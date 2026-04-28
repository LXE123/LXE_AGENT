from __future__ import annotations

from typing import Any

from .errors import MabangAuthError


def _normalize_domain(value: str) -> str:
    return str(value or "").strip().lstrip(".").lower()


def _domain_matches_host(host: str, domain: str) -> bool:
    if not host or not domain:
        return False
    if host == domain:
        return True
    return host.endswith(f".{domain}")


def _specificity_score(host: str, domain: str) -> tuple[int, int]:
    return (
        1 if host == domain else 0,
        len(domain),
    )


def build_cookie_header(
    cookies_by_domain: dict[str, list] | None,
    request_host: str | None = None,
    extra_cookies: dict[str, str] | None = None,
) -> str:
    host = _normalize_domain(request_host or "")
    candidates = []
    seq = 0
    for domain_key, items in (cookies_by_domain or {}).items():
        for cookie in items or []:
            if not isinstance(cookie, dict):
                continue
            name = str(cookie.get("name") or "").strip()
            value = cookie.get("value")
            if not name or value is None:
                continue
            domain = _normalize_domain(cookie.get("domain") or domain_key)
            if host and not _domain_matches_host(host, domain):
                continue
            candidates.append(
                {
                    "name": name,
                    "value": str(value),
                    "domain": domain,
                    "score": _specificity_score(host, domain) if host else (0, 0),
                    "seq": seq,
                }
            )
            seq += 1

    picked: dict[str, dict[str, Any]] = {}
    for item in candidates:
        current = picked.get(item["name"])
        if current is None or item["score"] > current["score"]:
            picked[item["name"]] = item

    ordered = sorted(picked.values(), key=lambda item: item["seq"])
    if extra_cookies:
        existing_names = {item["name"] for item in ordered}
        for name, value in extra_cookies.items():
            cookie_name = str(name or "").strip()
            if not cookie_name:
                continue
            cookie_value = str(value or "")
            if cookie_name in existing_names:
                for item in ordered:
                    if item["name"] == cookie_name:
                        item["value"] = cookie_value
                        break
            else:
                ordered.append({"name": cookie_name, "value": cookie_value, "seq": len(ordered)})
                existing_names.add(cookie_name)

    return "; ".join(f"{item['name']}={item['value']}" for item in ordered)


def list_cookie_names(
    cookies_by_domain: dict[str, list] | None,
    request_host: str | None = None,
    extra_cookies: dict[str, str] | None = None,
) -> list[str]:
    header = build_cookie_header(
        cookies_by_domain=cookies_by_domain,
        request_host=request_host,
        extra_cookies=extra_cookies,
    )
    result: list[str] = []
    seen = set()
    for part in header.split(";"):
        token = part.strip()
        if "=" not in token:
            continue
        name = token.split("=", 1)[0].strip()
        if not name or name in seen:
            continue
        seen.add(name)
        result.append(name)
    return result


def extract_named_cookies(
    cookies_by_domain: dict[str, list] | None,
    names: tuple[str, ...] | list[str],
) -> dict[str, str]:
    wanted = {str(name or "").strip() for name in names if str(name or "").strip()}
    found: dict[str, str] = {}
    if not wanted:
        return found

    for items in (cookies_by_domain or {}).values():
        for cookie in items or []:
            if not isinstance(cookie, dict):
                continue
            name = str(cookie.get("name") or "").strip()
            value = str(cookie.get("value") or "").strip()
            if name in wanted and value and name not in found:
                found[name] = value
    return found


def require_cookie_values(cookie_values: dict[str, str], required_names: tuple[str, ...] | list[str]) -> dict[str, str]:
    missing = [name for name in required_names if not str(cookie_values.get(name) or "").strip()]
    if missing:
        raise MabangAuthError(f"缺少关键 Cookie: {', '.join(missing)}")
    return cookie_values
