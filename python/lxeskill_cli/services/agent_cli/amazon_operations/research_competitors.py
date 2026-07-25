from __future__ import annotations

import html as html_module
import re
from typing import Any

from bs4 import BeautifulSoup, Tag

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


_ASIN = re.compile(r"^[A-Z0-9]{10}$")
_NO_RESULTS_MARKERS = (
    "no results for",
    "did not match any products",
    "try checking your spelling or use more general terms",
)


def _clean_text(value: str) -> str:
    return " ".join(html_module.unescape(value or "").split())


def _child_text(card: Tag, selector: str) -> str:
    element = card.select_one(selector)
    return _clean_text(element.get_text(" ", strip=True)) if element else ""


def parse_search_page(source: str, limit: int) -> list[dict[str, Any]]:
    soup = BeautifulSoup(source, "html.parser")
    cards = soup.select("[data-component-type='s-search-result'][data-asin]")
    if not cards:
        cards = soup.select("[data-asin]")
    competitors: list[dict[str, Any]] = []
    seen: set[str] = set()
    for card in cards:
        asin = str(card.get("data-asin") or "").strip().upper()
        if not _ASIN.fullmatch(asin) or asin in seen:
            continue
        seen.add(asin)
        competitors.append(
            {
                "rank": len(competitors) + 1,
                "asin": asin,
                "title": _child_text(card, "h2 span"),
                "price": _child_text(card, ".a-price .a-offscreen"),
                "sponsored": "sponsored" in _clean_text(card.get_text(" ", strip=True)).lower(),
            }
        )
        if len(competitors) >= limit:
            break
    return competitors


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    try:
        marketplace = validate_marketplace(arguments.get("marketplace"))
        query = required_text(arguments.get("query"), field="query")
        limit = integer_in_range(arguments.get("limit"), field="limit", default=10, minimum=1, maximum=10)
    except ValueError as exc:
        return failure_payload(str(exc))

    response = fetch_web(
        f"https://www.amazon.{marketplace}/s",
        headers={"Accept": "text/html", "Accept-Language": "en-US,en;q=0.9"},
        params={"k": query},
    )
    diagnostics = {**response_diagnostics(response), "request_count": 1}
    marker = blocked_reason(response)
    if marker:
        return persist_report(
            "competitors",
            query,
            failure_payload(
                "Amazon blocked or challenged the competitor search request",
                status="blocked",
                diagnostics=diagnostics,
            ),
        )
    if response.error or response.status_code is None or not 200 <= response.status_code < 300:
        return persist_report(
            "competitors",
            query,
            failure_payload(compact_error(response), diagnostics=diagnostics),
        )

    competitors = parse_search_page(response.text, limit)
    lowered = response.text.lower()
    explicit_no_results = any(marker in lowered for marker in _NO_RESULTS_MARKERS)
    if not competitors and not explicit_no_results:
        return persist_report(
            "competitors",
            query,
            failure_payload(
                "Amazon returned a search page without recognizable product results",
                diagnostics={**diagnostics, "page_kind": "unrecognized"},
            ),
        )

    payload = {
        "success": True,
        "status": "complete",
        "source": SOURCE,
        "marketplace": marketplace,
        "query": query,
        "total_results": len(competitors),
        "competitors": competitors,
        "diagnostics": {
            **diagnostics,
            "confidence": "high",
            "empty_result_confirmed": explicit_no_results and not competitors,
        },
    }
    return persist_report("competitors", query, payload)


__all__ = ["parse_search_page", "run"]
