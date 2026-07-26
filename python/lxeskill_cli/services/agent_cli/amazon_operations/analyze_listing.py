from __future__ import annotations

import html as html_module
import re
from typing import Any

from bs4 import BeautifulSoup

from services.agent_cli.amazon_operations._shared import (
    SOURCE,
    blocked_reason,
    compact_error,
    failure_payload,
    fetch_web,
    parse_count,
    persist_report,
    response_diagnostics,
    validate_marketplace,
)


_ASIN = re.compile(r"^[A-Z0-9]{10}$")
_CRITICAL_FIELDS = ("title", "bullets", "images_count", "rating", "review_count")


def _clean_text(value: str) -> str:
    return " ".join(html_module.unescape(value or "").split())


def _first_text(soup: BeautifulSoup, selectors: tuple[str, ...]) -> str:
    for selector in selectors:
        element = soup.select_one(selector)
        if element:
            text = _clean_text(element.get_text(" ", strip=True))
            if text:
                return text
    return ""


def parse_listing_page(source: str, asin: str) -> dict[str, Any]:
    soup = BeautifulSoup(source, "html.parser")
    title = _first_text(soup, ("#productTitle", "h1.a-size-large"))

    bullets: list[str] = []
    for element in soup.select("#feature-bullets .a-list-item"):
        text = _clean_text(element.get_text(" ", strip=True))
        if len(text) > 5 and text not in bullets:
            bullets.append(text)

    price = _first_text(
        soup,
        (
            "#corePrice_feature_div .a-price .a-offscreen",
            "#priceblock_ourprice",
            "#priceblock_dealprice",
            ".a-price .a-offscreen",
        ),
    )
    rating_text = _first_text(soup, ("#acrPopover", "#averageCustomerReviews .a-icon-alt"))
    rating_match = re.search(r"([0-5](?:\.[0-9]+)?)", rating_text)
    rating = float(rating_match.group(1)) if rating_match else None
    review_text = _first_text(soup, ("#acrCustomerReviewText", "[data-hook='total-review-count']"))
    review_count = parse_count(review_text)

    thumbnail_count = len(soup.select("#altImages li.imageThumbnail"))
    high_resolution_urls = set(re.findall(r'"hiRes"\s*:\s*"(https:[^"]+)"', source))
    images_count = thumbnail_count or len(high_resolution_urls) or None

    brand = _first_text(soup, ("#bylineInfo", "#brand"))
    brand = re.sub(r"^(?:Visit the\s+|Brand:\s*)|(?:\s+Store)$", "", brand, flags=re.IGNORECASE).strip()
    category = _first_text(soup, ("#wayfinding-breadcrumbs_feature_div", "#wayfinding-breadcrumbs_container"))
    description = _first_text(soup, ("#productDescription", "#aplus"))

    return {
        "asin": asin,
        "title": title,
        "bullets": bullets,
        "description": description,
        "price": price,
        "rating": rating,
        "review_count": review_count,
        "images_count": images_count,
        "brand": brand,
        "category": category,
    }


def _score_title(title: str) -> tuple[int, list[str]]:
    if not title:
        return 0, ["Title was not observed."]
    score = 0
    feedback: list[str] = []
    length = len(title)
    if 80 <= length <= 200:
        score += 30
    elif 50 <= length < 80:
        score += 20
        feedback.append("Consider expanding the title toward 80-200 characters.")
    elif length > 200:
        score += 15
        feedback.append("Reduce the title below 200 characters to avoid truncation.")
    else:
        score += 5
        feedback.append("The title is very short and may omit useful terms.")
    if len(title.split()) >= 8:
        score += 15
    else:
        feedback.append("Use more specific product terms where they are accurate.")
    if title != title.upper() and title[:1].isupper():
        score += 10
    elif title == title.upper():
        feedback.append("Avoid an all-caps title.")
    if any(character.isupper() for character in title[:20]):
        score += 10
    special_count = len(re.findall(r"[!@#$%^&*(){}|]", title))
    if special_count == 0:
        score += 10
    elif special_count > 3:
        feedback.append("Remove excessive special characters.")
    if "|" in title or " - " in title or "," in title:
        score += 10
    if re.search(r"\d", title):
        score += 15
    else:
        feedback.append("Add size, quantity, or count only when it helps identify the product.")
    return min(score, 100), feedback


def _score_bullets(bullets: list[str]) -> tuple[int, list[str]]:
    if not bullets:
        return 0, ["Bullet points were not observed."]
    score = 25 if len(bullets) >= 5 else 15 if len(bullets) >= 3 else 5
    feedback: list[str] = []
    if len(bullets) < 5:
        feedback.append(f"Only {len(bullets)} bullet points were observed.")
    average_length = sum(map(len, bullets)) / len(bullets)
    score += 25 if average_length >= 150 else 15 if average_length >= 80 else 5
    if average_length < 80:
        feedback.append("Bullets are short; add accurate benefits and supporting detail.")
    all_text = " ".join(bullets)
    if len(re.findall(r"\b[A-Z]{2,}\b", all_text)) >= 3:
        score += 15
    benefit_words = (
        "you",
        "your",
        "enjoy",
        "perfect",
        "ideal",
        "best",
        "premium",
        "quality",
        "guaranteed",
        "satisfaction",
        "easy",
        "comfortable",
    )
    benefit_count = sum(word in all_text.lower() for word in benefit_words)
    score += 20 if benefit_count >= 3 else 10 if benefit_count >= 1 else 0
    if benefit_count == 0:
        feedback.append("Explain customer benefits, not only product features.")
    if any(ord(character) > 127 for character in all_text):
        score += 15
    return min(score, 100), feedback


def _score_images(count: int | None) -> tuple[int, list[str]]:
    # The upstream parser treated an unobserved image set as one image.
    normalized_count = max(int(count or 1), 1)
    if normalized_count >= 7:
        return 100, []
    if normalized_count >= 5:
        return 75, [f"Add {7 - normalized_count} more useful product images if available."]
    if normalized_count >= 3:
        return 50, ["Add lifestyle, detail, and size-reference images."]
    return 20, ["Very few product images were observed."]


def _score_reviews(rating: float | None, count: int | None) -> tuple[int, list[str]]:
    score = 0
    feedback: list[str] = []
    if rating is None:
        feedback.append("Rating was not observed.")
    else:
        score += 50 if rating >= 4.5 else 35 if rating >= 4.0 else 20 if rating >= 3.5 else 5
        if rating < 4.0:
            feedback.append("The observed rating may reduce conversion.")
    if count is None:
        feedback.append("Review count was not observed.")
    else:
        score += 50 if count >= 100 else 35 if count >= 30 else 20 if count >= 10 else 5
        if count < 30:
            feedback.append("The observed review count provides limited social proof.")
    return min(score, 100), feedback


def score_listing(listing: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    title_score, title_feedback = _score_title(str(listing.get("title") or ""))
    bullet_score, bullet_feedback = _score_bullets(list(listing.get("bullets") or []))
    image_score, image_feedback = _score_images(listing.get("images_count"))
    review_score, review_feedback = _score_reviews(listing.get("rating"), listing.get("review_count"))
    components = {
        "title": title_score,
        "bullets": bullet_score,
        "images": image_score,
        "reviews": review_score,
    }
    overall = int(
        title_score * 0.30
        + bullet_score * 0.25
        + image_score * 0.25
        + review_score * 0.20
    )
    grade = (
        "A+"
        if overall >= 90
        else "A"
        if overall >= 80
        else "B"
        if overall >= 70
        else "C"
        if overall >= 60
        else "D"
        if overall >= 50
        else "F"
    )
    return {**components, "overall": overall, "grade": grade}, [
        *title_feedback,
        *bullet_feedback,
        *image_feedback,
        *review_feedback,
    ]


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    raw_asin = str(arguments.get("asin") or "").strip().upper()
    try:
        marketplace = validate_marketplace(arguments.get("marketplace"))
        if not _ASIN.fullmatch(raw_asin):
            raise ValueError("asin must contain exactly 10 uppercase letters or digits")
    except ValueError as exc:
        return failure_payload(str(exc))

    response = fetch_web(
        f"https://www.amazon.{marketplace}/dp/{raw_asin}",
        headers={"Accept": "text/html", "Accept-Language": "en-US,en;q=0.9"},
    )
    diagnostics = {**response_diagnostics(response), "request_count": 1}
    marker = blocked_reason(response)
    if marker:
        return persist_report(
            "listing",
            raw_asin,
            failure_payload(
                "Amazon blocked or challenged the listing request",
                status="blocked",
                diagnostics=diagnostics,
            ),
        )
    if response.error or response.status_code is None or not 200 <= response.status_code < 300:
        return persist_report(
            "listing",
            raw_asin,
            failure_payload(compact_error(response), diagnostics=diagnostics),
        )

    listing = parse_listing_page(response.text, raw_asin)
    if not listing["title"] and not listing["bullets"]:
        return persist_report(
            "listing",
            raw_asin,
            failure_payload(
                "Amazon returned a page that does not contain a recognizable product listing",
                diagnostics={**diagnostics, "page_kind": "unrecognized"},
            ),
        )

    missing_fields = [field for field in _CRITICAL_FIELDS if listing.get(field) in (None, "", [])]
    data_completeness = round((len(_CRITICAL_FIELDS) - len(missing_fields)) / len(_CRITICAL_FIELDS), 2)
    scores, recommendations = score_listing(listing)
    status = "complete" if not missing_fields else "partial"
    confidence = "high" if not missing_fields else "medium" if len(missing_fields) <= 2 else "low"
    payload = {
        "success": True,
        "status": status,
        "source": SOURCE,
        "marketplace": marketplace,
        "listing": listing,
        "scores": scores,
        "recommendations": recommendations[:12],
        "missing_fields": missing_fields,
        "data_completeness": data_completeness,
        "diagnostics": {
            **diagnostics,
            "confidence": confidence,
            "missing_fields": missing_fields,
            "score_available": True,
        },
    }
    return persist_report("listing", raw_asin, payload)


__all__ = ["parse_listing_page", "run", "score_listing"]
