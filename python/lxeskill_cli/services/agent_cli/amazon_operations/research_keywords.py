from __future__ import annotations

from collections import Counter
import json
import string
import time
from typing import Any

from services.agent_cli.amazon_operations._shared import (
    SOURCE,
    blocked_reason,
    compact_error,
    failure_payload,
    fetch_web,
    integer_in_range,
    persist_report,
    required_text,
    response_diagnostics,
    validate_marketplace,
)


MAX_REQUESTS = 30
_REQUEST_PAUSE_SECONDS = 0.1


def _fetch_suggestions(prefix: str, marketplace: str) -> dict[str, Any]:
    response = fetch_web(
        f"https://completion.amazon.{marketplace}/api/2017/suggestions",
        headers={"Accept": "application/json", "Accept-Language": "en-US,en;q=0.9"},
        params={
            "session-id": "000-0000000-0000000",
            "customer-id": "000000000",
            "request-id": "000000000",
            "page-type": "Gateway",
            "lop": "en_US",
            "site-variant": "desktop",
            "client-info": "amazon-search-ui",
            "mid": "ATVPDKIKX0DER",
            "alias": "aps",
            "prefix": prefix,
            "event": "onKeyPress",
            "limit": 11,
            "fb": 1,
            "suggestion-type": "KEYWORD",
        },
    )
    diagnostics = response_diagnostics(response)
    marker = blocked_reason(response)
    if marker:
        return {
            "ok": False,
            "status": "blocked",
            "message": "Amazon blocked or challenged an autocomplete request",
            "diagnostics": diagnostics,
            "suggestions": [],
        }
    if response.error or response.status_code is None or not 200 <= response.status_code < 300:
        return {
            "ok": False,
            "status": "failed",
            "message": compact_error(response),
            "diagnostics": diagnostics,
            "suggestions": [],
        }
    try:
        document = json.loads(response.text)
    except json.JSONDecodeError as exc:
        return {
            "ok": False,
            "status": "failed",
            "message": f"Amazon autocomplete returned invalid JSON: {exc}",
            "diagnostics": diagnostics,
            "suggestions": [],
        }
    raw_suggestions = document.get("suggestions")
    if not isinstance(raw_suggestions, list):
        return {
            "ok": False,
            "status": "failed",
            "message": "Amazon autocomplete JSON did not contain a suggestions array",
            "diagnostics": diagnostics,
            "suggestions": [],
        }
    suggestions: list[str] = []
    for item in raw_suggestions:
        value = item.get("value") if isinstance(item, dict) else ""
        normalized = " ".join(str(value or "").split())
        if normalized and normalized not in suggestions:
            suggestions.append(normalized)
    return {
        "ok": True,
        "status": "complete",
        "message": "",
        "diagnostics": diagnostics,
        "suggestions": suggestions,
    }


def keyword_frequency(keywords: list[str]) -> list[dict[str, Any]]:
    counts: Counter[str] = Counter()
    for keyword in keywords:
        counts.update(word for word in keyword.lower().split() if len(word) > 2)
    return [{"term": term, "count": count} for term, count in counts.most_common(30)]


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    try:
        marketplace = validate_marketplace(arguments.get("marketplace"))
        seed = required_text(arguments.get("seed"), field="seed")
        depth = integer_in_range(arguments.get("depth"), field="depth", default=1, minimum=1, maximum=2)
    except ValueError as exc:
        return failure_payload(str(exc))

    all_keywords: set[str] = set()
    request_errors: list[dict[str, Any]] = []
    request_count = 0

    def request(prefix: str) -> dict[str, Any] | None:
        nonlocal request_count
        if request_count >= MAX_REQUESTS:
            return None
        request_count += 1
        result = _fetch_suggestions(prefix, marketplace)
        if request_count < MAX_REQUESTS:
            time.sleep(_REQUEST_PAUSE_SECONDS)
        return result

    first = request(seed)
    if first is None or not first["ok"]:
        first = first or {
            "status": "failed",
            "message": "Autocomplete request budget was exhausted before the first request",
            "diagnostics": {},
        }
        payload = failure_payload(
            str(first["message"]),
            status=str(first["status"]),
            diagnostics={**dict(first["diagnostics"]), "request_count": request_count},
        )
        return persist_report("keywords", seed, payload)

    first_suggestions = list(first["suggestions"])
    all_keywords.update(first_suggestions)
    first_level_queue = list(first_suggestions)

    for letter in string.ascii_lowercase:
        result = request(f"{seed} {letter}")
        if result is None:
            break
        if result["ok"]:
            all_keywords.update(result["suggestions"])
        else:
            request_errors.append(
                {
                    "prefix": f"{seed} {letter}",
                    "status": result["status"],
                    "message": result["message"],
                    "http_status": result["diagnostics"].get("http_status"),
                }
            )

    if depth == 2:
        for prefix in first_level_queue[:20]:
            result = request(prefix)
            if result is None:
                break
            if result["ok"]:
                all_keywords.update(result["suggestions"])
            else:
                request_errors.append(
                    {
                        "prefix": prefix,
                        "status": result["status"],
                        "message": result["message"],
                        "http_status": result["diagnostics"].get("http_status"),
                    }
                )

    keywords = sorted(all_keywords)
    seed_words = set(seed.lower().split())
    exact_match = [keyword for keyword in keywords if seed_words.issubset(set(keyword.lower().split()))]
    broad_match = [keyword for keyword in keywords if keyword not in exact_match]
    frequencies = keyword_frequency(keywords)
    status = "partial" if request_errors else "complete"
    confidence = "medium" if request_errors else "high"
    report = persist_report(
        "keywords",
        seed,
        {
            "success": True,
            "status": status,
            "source": SOURCE,
            "marketplace": marketplace,
            "seed": seed,
            "depth": depth,
            "total_keywords": len(keywords),
            "exact_match": exact_match,
            "broad_match": broad_match,
            "frequency": frequencies,
            "all_keywords": keywords,
            "diagnostics": {
                "confidence": confidence,
                "request_count": request_count,
                "request_limit": MAX_REQUESTS,
                "request_errors": request_errors[:10],
                "empty_result_confirmed": not keywords and not request_errors,
            },
        },
    )
    return {
        "success": True,
        "status": status,
        "source": SOURCE,
        "marketplace": marketplace,
        "seed": seed,
        "depth": depth,
        "total_keywords": len(keywords),
        "top_keywords": keywords[:20],
        "frequency": frequencies[:20],
        "diagnostics": report["diagnostics"],
        "report_path": report["report_path"],
    }


__all__ = ["keyword_frequency", "run"]
