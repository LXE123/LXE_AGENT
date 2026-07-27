from __future__ import annotations

from collections import Counter
import hashlib
import html as html_module
import re
from typing import Any, Iterable
from urllib.parse import urljoin, urlsplit

from bs4 import BeautifulSoup, Tag

from services.agent_cli.amazon_operations._shared import (
    SOURCE,
    WebResponse,
    blocked_reason,
    compact_error,
    failure_payload,
    fetch_web,
    integer_in_range,
    persist_report,
    response_diagnostics,
    validate_marketplace,
)
from services.agent_cli.amazon_operations.analyze_listing import parse_listing_page


_ASIN = re.compile(r"^[A-Z0-9]{10}$")
_ASIN_IN_PATH = re.compile(r"/(?:dp|product-reviews)/([A-Z0-9]{10})(?:[/?]|$)", re.IGNORECASE)
_RATING = re.compile(r"([0-5](?:\.[0-9]+)?)\s+out of\s+5", re.IGNORECASE)
_RATING_PREFIX = re.compile(r"^\s*[0-5](?:\.[0-9]+)?\s+out of\s+5\s+stars?\s*", re.IGNORECASE)
_WORD = re.compile(r"[a-z]+(?:'[a-z]+)?")
_LINKFOX_LEGACY_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
_USER_AGENT_PROFILE = "linkfox_legacy_default"
_NO_REVIEWS_MARKERS = (
    "no customer reviews",
    "there are 0 customer reviews",
    "this product has no customer reviews",
)
_AUTH_MARKERS = (
    'id="authportal-main-section"',
    "id='authportal-main-section'",
    "sign in to continue",
)
_POSITIVE_WORDS = (
    "love",
    "great",
    "excellent",
    "amazing",
    "perfect",
    "best",
    "delicious",
    "fantastic",
    "wonderful",
    "quality",
    "fresh",
    "recommend",
    "favorite",
    "good",
    "tasty",
    "happy",
    "pleased",
)
_NEGATIVE_WORDS = (
    "bad",
    "terrible",
    "awful",
    "worst",
    "disappointed",
    "poor",
    "waste",
    "horrible",
    "disgusting",
    "stale",
    "expired",
    "broken",
    "damaged",
    "wrong",
    "fake",
    "scam",
    "refund",
    "return",
    "complaint",
    "never",
    "hate",
)
_ACTION_RULES = (
    (
        "shipping_damage",
        ("damaged", "broken", "crushed", "leak", "leaking"),
        "Inspect packaging and carrier damage patterns, then review protective packing and fulfillment handling.",
    ),
    (
        "product_quality",
        ("expired", "stale", "old", "bad taste", "quality", "defective"),
        "Review the affected lot, shelf-life controls, and quality checks before changing the listing or inventory.",
    ),
    (
        "expectation_mismatch",
        ("wrong", "not what", "different", "expected", "misleading"),
        "Compare the listing's title, images, variation labels, and included-items claims with the delivered product.",
    ),
)
_GENERAL_ACTION = (
    "general_dissatisfaction",
    "Review the low-rating evidence, identify a reproducible product or listing issue, and route it for internal follow-up.",
)


def _clean_text(value: str) -> str:
    return " ".join(html_module.unescape(value or "").split())


def _amazon_headers(*, referer: str = "") -> dict[str, str]:
    headers = {
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": _LINKFOX_LEGACY_USER_AGENT,
    }
    if referer:
        headers["Referer"] = referer
    return headers


def _asin_from_url(value: str) -> str:
    match = _ASIN_IN_PATH.search(urlsplit(value or "").path)
    return match.group(1).upper() if match else ""


def _first_text(element: Tag | BeautifulSoup, selectors: Iterable[str]) -> str:
    for selector in selectors:
        found = element.select_one(selector)
        if found:
            text = _clean_text(found.get_text(" ", strip=True))
            if text:
                return text
    return ""


def parse_product_context(source: str, input_asin: str, marketplace: str = "com") -> dict[str, Any]:
    soup = BeautifulSoup(source, "html.parser")
    canonical_element = soup.select_one("link[rel='canonical']")
    canonical_url = str(canonical_element.get("href") or "").strip() if canonical_element else ""
    resolved_asin = _asin_from_url(canonical_url) or input_asin
    listing = parse_listing_page(source, resolved_asin)

    review_url = ""
    review_url_source = ""
    expected_hosts = {f"amazon.{marketplace}", f"www.amazon.{marketplace}"}
    for element in soup.select("a[href*='/product-reviews/']"):
        href = str(element.get("href") or "").strip()
        absolute = urljoin(f"https://www.amazon.{marketplace}/", href)
        parsed = urlsplit(absolute)
        if parsed.hostname not in expected_hosts or _asin_from_url(absolute) != resolved_asin:
            continue
        review_url = f"https://www.amazon.{marketplace}{parsed.path}"
        review_url_source = "product_page"
        break

    if not review_url:
        review_url = f"https://www.amazon.{marketplace}/product-reviews/{resolved_asin}"
        review_url_source = "canonical_fallback"

    return {
        "input_asin": input_asin,
        "resolved_asin": resolved_asin,
        "title": listing["title"],
        "rating": listing["rating"],
        "review_count": listing["review_count"],
        "canonical_url": canonical_url or f"https://www.amazon.{marketplace}/dp/{resolved_asin}",
        "review_url": review_url,
        "review_url_source": review_url_source,
    }


def parse_review_page(source: str) -> list[dict[str, Any]]:
    soup = BeautifulSoup(source, "html.parser")
    reviews: list[dict[str, Any]] = []
    for block in soup.select("[data-hook='review']"):
        review_id = str(block.get("id") or block.get("data-review-id") or "").strip()
        date = _first_text(block, ("[data-hook='review-date']",))
        rating_text = _first_text(
            block,
            (
                "[data-hook='review-star-rating']",
                "[data-hook='cmps-review-star-rating']",
                ".a-icon-alt",
            ),
        )
        rating_match = _RATING.search(rating_text)
        rating = float(rating_match.group(1)) if rating_match else None
        title = _RATING_PREFIX.sub("", _first_text(block, ("[data-hook='review-title']",))).strip()
        body = _first_text(block, ("[data-hook='review-body']",))[:500]
        if rating is None and not title and not body:
            continue
        fingerprint_source = "|".join((date, str(rating or ""), title, body))
        identity = review_id or hashlib.sha256(fingerprint_source.encode("utf-8")).hexdigest()[:24]
        reviews.append(
            {
                "review_id": identity,
                "date": date,
                "rating": rating,
                "title": title,
                "body": body,
            }
        )
    return reviews


def deduplicate_reviews(reviews: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for review in reviews:
        identity = str(review.get("review_id") or "")
        if identity in seen:
            continue
        seen.add(identity)
        unique.append(review)
    return unique


def analyze_sentiment(reviews: Iterable[dict[str, Any]]) -> dict[str, Any]:
    positive = Counter[str]()
    negative = Counter[str]()
    for review in reviews:
        text = f"{review.get('title', '')} {review.get('body', '')}".lower()
        tokens = set(_WORD.findall(text))
        for word in _POSITIVE_WORDS:
            if word in tokens:
                positive[word] += 1
        for word in _NEGATIVE_WORDS:
            if word in tokens:
                negative[word] += 1

    positive_mentions = sum(positive.values())
    negative_mentions = sum(negative.values())
    total_mentions = positive_mentions + negative_mentions
    return {
        "method": "keyword_lexicon_v1",
        "language": "en",
        "positive_mentions": positive_mentions,
        "negative_mentions": negative_mentions,
        "positive_mention_ratio": round(positive_mentions / total_mentions * 100, 1) if total_mentions else None,
        "top_positive_themes": [
            {"theme": theme, "mentions": count} for theme, count in positive.most_common(5)
        ],
        "top_negative_themes": [
            {"theme": theme, "mentions": count} for theme, count in negative.most_common(5)
        ],
        "confidence": "medium" if total_mentions >= 5 else "low",
    }


def internal_actions(reviews: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    counts = Counter[str]()
    evidence: dict[str, list[str]] = {}
    recommendations = {category: recommendation for category, _terms, recommendation in _ACTION_RULES}
    recommendations[_GENERAL_ACTION[0]] = _GENERAL_ACTION[1]

    for review in reviews:
        rating = review.get("rating")
        if rating is None or float(rating) > 2:
            continue
        text = f"{review.get('title', '')} {review.get('body', '')}".lower()
        categories = [category for category, terms, _recommendation in _ACTION_RULES if any(term in text for term in terms)]
        if not categories:
            categories = [_GENERAL_ACTION[0]]
        for category in categories:
            counts[category] += 1
            title = str(review.get("title") or review.get("body") or "")[:120]
            if title and title not in evidence.setdefault(category, []) and len(evidence[category]) < 3:
                evidence[category].append(title)

    order = [category for category, _terms, _recommendation in _ACTION_RULES] + [_GENERAL_ACTION[0]]
    return [
        {
            "category": category,
            "review_count": counts[category],
            "recommendation": recommendations[category],
            "evidence": evidence.get(category, []),
        }
        for category in sorted(order, key=lambda item: (-counts[item], order.index(item)))
        if counts[category]
    ]


def _review_access_failure(response: WebResponse) -> tuple[str, str]:
    marker = blocked_reason(response)
    if marker:
        return "blocked", marker
    lowered_url = response.final_url.lower()
    lowered_text = response.text.lower()
    if "/edgex/guard/" in lowered_url or "__rx_csd=" in lowered_url:
        return "blocked", "amazon_guard"
    if "/ap/signin" in lowered_url or any(marker in lowered_text for marker in _AUTH_MARKERS):
        return "blocked", "sign_in_required"
    if response.status_code == 404:
        return "failed", "review_endpoint_unavailable"
    if response.error or response.status_code is None or not 200 <= response.status_code < 300:
        return "failed", compact_error(response)
    return "", ""


def _rating_summary(reviews: list[dict[str, Any]]) -> tuple[dict[str, int], float | None]:
    distribution = {str(star): 0 for star in range(5, 0, -1)}
    ratings = [float(review["rating"]) for review in reviews if review.get("rating") is not None]
    for rating in ratings:
        star = min(max(int(rating), 1), 5)
        distribution[str(star)] += 1
    average = round(sum(ratings) / len(ratings), 1) if ratings else None
    return distribution, average


def _product_failure(
    message: str,
    *,
    input_asin: str,
    marketplace: str,
    status: str,
    diagnostics: dict[str, Any],
) -> dict[str, Any]:
    payload = failure_payload(message, marketplace=marketplace, status=status, diagnostics=diagnostics)
    payload.update({"input_asin": input_asin, "resolved_asin": ""})
    return persist_report("reviews", input_asin, payload)


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    input_asin = str(arguments.get("asin") or "").strip().upper()
    try:
        marketplace = validate_marketplace(arguments.get("marketplace"))
        if not _ASIN.fullmatch(input_asin):
            raise ValueError("asin must contain exactly 10 uppercase letters or digits")
        pages = integer_in_range(arguments.get("pages"), field="pages", default=1, minimum=1, maximum=3)
    except ValueError as exc:
        return failure_payload(str(exc))

    product_response = fetch_web(
        f"https://www.amazon.{marketplace}/dp/{input_asin}",
        headers=_amazon_headers(),
    )
    product_diagnostics = response_diagnostics(product_response)
    request_diagnostics = {
        "request_count": 1,
        "user_agent_profile": _USER_AGENT_PROFILE,
        "user_agent_platform_agnostic": True,
    }
    marker = blocked_reason(product_response)
    if marker:
        return _product_failure(
            "Amazon blocked or challenged the product preflight request",
            input_asin=input_asin,
            marketplace=marketplace,
            status="blocked",
            diagnostics={**request_diagnostics, "product": product_diagnostics},
        )
    if product_response.error or product_response.status_code is None or not 200 <= product_response.status_code < 300:
        return _product_failure(
            compact_error(product_response),
            input_asin=input_asin,
            marketplace=marketplace,
            status="failed",
            diagnostics={**request_diagnostics, "product": product_diagnostics},
        )

    product = parse_product_context(product_response.text, input_asin, marketplace)
    if not product["title"]:
        return _product_failure(
            "Amazon returned a page that does not contain a recognizable product listing",
            input_asin=input_asin,
            marketplace=marketplace,
            status="failed",
            diagnostics={
                **request_diagnostics,
                "product": {**product_diagnostics, "page_kind": "unrecognized"},
            },
        )

    collected: list[dict[str, Any]] = []
    review_pages: list[dict[str, Any]] = []
    review_text_status = "complete"
    empty_result_confirmed = False
    reached_end = False
    for page in range(1, pages + 1):
        response = fetch_web(
            product["review_url"],
            headers=_amazon_headers(referer=product["canonical_url"]),
            params={"pageNumber": page, "sortBy": "recent"},
        )
        page_diagnostics = {"page": page, **response_diagnostics(response)}
        failure_status, failure_reason = _review_access_failure(response)
        if failure_status:
            if failure_status == "blocked" and not page_diagnostics["blocked_marker"]:
                page_diagnostics["blocked_marker"] = failure_reason
            review_text_status = failure_status
            review_pages.append({**page_diagnostics, "page_kind": failure_reason, "review_count": 0})
            break

        parsed = parse_review_page(response.text)
        lowered = response.text.lower()
        explicit_empty = any(marker in lowered for marker in _NO_REVIEWS_MARKERS)
        if not parsed and not explicit_empty:
            review_text_status = "failed"
            review_pages.append({**page_diagnostics, "page_kind": "unrecognized", "review_count": 0})
            break
        if explicit_empty:
            empty_result_confirmed = not collected
            reached_end = True
            review_pages.append({**page_diagnostics, "page_kind": "empty", "review_count": 0})
            break

        collected.extend(parsed)
        review_pages.append({**page_diagnostics, "page_kind": "reviews", "review_count": len(parsed)})

    reviews = deduplicate_reviews(collected)
    if review_text_status == "complete" and not reached_end and len(review_pages) < pages:
        review_text_status = "failed"

    distribution, sample_average = _rating_summary(reviews)
    sentiment = analyze_sentiment(reviews) if reviews else None
    actions = internal_actions(reviews) if reviews else []
    negative_reviews = [
        review for review in reviews if review.get("rating") is not None and float(review["rating"]) <= 2
    ]
    product_missing_fields = [field for field in ("rating", "review_count") if product.get(field) is None]
    status = "complete" if review_text_status == "complete" and not product_missing_fields else "partial"
    confidence = "medium" if status == "complete" and reviews else "low"
    diagnostics = {
        "confidence": confidence,
        "request_count": 1 + len(review_pages),
        "user_agent_profile": _USER_AGENT_PROFILE,
        "user_agent_platform_agnostic": True,
        "product": product_diagnostics,
        "product_missing_fields": product_missing_fields,
        "review_url_source": product["review_url_source"],
        "review_text_status": review_text_status,
        "review_pages": review_pages,
        "empty_result_confirmed": empty_result_confirmed,
        "deduplicated_review_count": len(reviews),
    }
    report = persist_report(
        "reviews",
        input_asin,
        {
            "success": True,
            "status": status,
            "source": SOURCE,
            "input_asin": input_asin,
            "resolved_asin": product["resolved_asin"],
            "marketplace": marketplace,
            "product_summary": {
                "title": product["title"],
                "rating": product["rating"],
                "review_count": product["review_count"],
                "canonical_url": product["canonical_url"],
            },
            "review_sample": {
                "requested_pages": pages,
                "parsed_reviews": len(reviews),
                "average_rating": sample_average,
                "rating_distribution": distribution,
                "negative_review_count": len(negative_reviews),
                "reviews": reviews,
            },
            "sentiment": sentiment,
            "internal_actions": actions,
            "diagnostics": diagnostics,
        },
    )
    return {
        "success": True,
        "status": status,
        "source": SOURCE,
        "input_asin": input_asin,
        "resolved_asin": product["resolved_asin"],
        "marketplace": marketplace,
        "product_summary": report["product_summary"],
        "review_sample": {
            "requested_pages": pages,
            "parsed_reviews": len(reviews),
            "average_rating": sample_average,
            "rating_distribution": distribution,
            "negative_review_count": len(negative_reviews),
            "top_negative_reviews": [
                {
                    "rating": review["rating"],
                    "date": review["date"],
                    "title": review["title"],
                    "excerpt": review["body"][:180],
                }
                for review in negative_reviews[:5]
            ],
        },
        "sentiment": sentiment,
        "internal_actions": actions,
        "diagnostics": diagnostics,
        "report_path": report["report_path"],
    }


__all__ = [
    "analyze_sentiment",
    "deduplicate_reviews",
    "internal_actions",
    "parse_product_context",
    "parse_review_page",
    "run",
]
