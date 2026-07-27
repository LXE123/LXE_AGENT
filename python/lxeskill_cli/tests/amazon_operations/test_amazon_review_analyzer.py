from __future__ import annotations

import json
from pathlib import Path
import sys

import pytest

from services.agent_cli.amazon_operations import _shared
from services.agent_cli.amazon_operations import analyze_listing
from services.agent_cli.amazon_operations import analyze_reviews


INPUT_ASIN = "B000000001"
RESOLVED_ASIN = "B000000002"
PRODUCT_HTML = f"""
<html><head>
  <link rel="canonical" href="https://www.amazon.com/example/dp/{RESOLVED_ASIN}">
</head><body>
  <span id="productTitle">Acme &amp; Co Review Test Product</span>
  <span id="acrPopover"><span>4.4 out of 5 stars</span></span>
  <span id="acrCustomerReviewText">1,234 ratings</span>
  <a href="/product-reviews/{INPUT_ASIN}?ref=wrong">Old variant reviews</a>
  <a href="/product-reviews/{RESOLVED_ASIN}?ref=right">Current reviews</a>
</body></html>
"""
REVIEW_HTML = """
<html><body>
  <div id="customer_review-R1" data-hook="review">
    <span data-hook="review-date">Reviewed in the United States on July 20, 2026</span>
    <i data-hook="review-star-rating"><span class="a-icon-alt">5.0 out of 5 stars</span></i>
    <a data-hook="review-title"><span>Great &amp; fresh quality</span></a>
    <span data-hook="review-body"><span>Excellent, delicious, and perfect for dinner.</span></span>
  </div>
  <div id="customer_review-R2" data-hook="review">
    <span data-hook="review-date">Reviewed in the United States on July 19, 2026</span>
    <i data-hook="review-star-rating"><span class="a-icon-alt">1.0 out of 5 stars</span></i>
    <a data-hook="review-title"><span>Arrived damaged</span></a>
    <span data-hook="review-body"><span>The jar was broken and leaking. Bad packaging.</span></span>
  </div>
</body></html>
"""


def _response(
    text: str,
    *,
    status: int = 200,
    final_url: str = "https://www.amazon.com/test",
) -> _shared.WebResponse:
    return _shared.WebResponse(
        requested_url=final_url,
        final_url=final_url,
        status_code=status,
        text=text,
        content_type="text/html",
    )


@pytest.fixture(autouse=True)
def _reports_in_tmp(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_shared, "artifact_path", lambda *parts: tmp_path.joinpath(*map(str, parts)))


def _sequence(monkeypatch: pytest.MonkeyPatch, *responses: _shared.WebResponse) -> None:
    queue = iter(responses)
    monkeypatch.setattr(analyze_reviews, "fetch_web", lambda *_args, **_kwargs: next(queue))


@pytest.mark.parametrize("platform", ["darwin", "win32", "linux"])
def test_linkfox_user_agent_is_fixed_across_platforms(
    platform: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(sys, "platform", platform)

    headers = analyze_reviews._amazon_headers()

    assert headers["User-Agent"] == (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    )


def test_product_context_resolves_canonical_asin_and_matching_review_link() -> None:
    result = analyze_reviews.parse_product_context(PRODUCT_HTML, INPUT_ASIN)

    assert result["resolved_asin"] == RESOLVED_ASIN
    assert result["rating"] == 4.4
    assert result["review_count"] == 1234
    assert result["review_url"] == f"https://www.amazon.com/product-reviews/{RESOLVED_ASIN}"
    assert result["review_url_source"] == "product_page"


def test_review_parser_sentiment_and_actions_are_bounded_and_token_aware() -> None:
    reviews = analyze_reviews.parse_review_page(REVIEW_HTML)
    sentiment = analyze_reviews.analyze_sentiment(reviews)
    actions = analyze_reviews.internal_actions(reviews)

    assert [review["review_id"] for review in reviews] == ["customer_review-R1", "customer_review-R2"]
    assert sentiment["positive_mentions"] == 6
    assert sentiment["negative_mentions"] == 3
    assert sentiment["confidence"] == "medium"
    assert actions[0]["category"] == "shipping_damage"

    boundary = analyze_reviews.analyze_sentiment([{"title": "A badge", "body": "Nothing lexical here"}])
    assert boundary["negative_mentions"] == 0
    assert boundary["positive_mention_ratio"] is None


def test_review_analyzer_returns_compact_result_and_full_artifact(monkeypatch: pytest.MonkeyPatch) -> None:
    _sequence(monkeypatch, _response(PRODUCT_HTML), _response(REVIEW_HTML))

    result = analyze_reviews.run({"asin": INPUT_ASIN, "pages": 1})

    assert result["success"] is True
    assert result["status"] == "complete"
    assert result["resolved_asin"] == RESOLVED_ASIN
    assert result["product_summary"]["review_count"] == 1234
    assert result["review_sample"]["parsed_reviews"] == 2
    assert result["review_sample"]["rating_distribution"] == {"5": 1, "4": 0, "3": 0, "2": 0, "1": 1}
    assert len(result["review_sample"]["top_negative_reviews"]) == 1
    assert "reviews" not in result["review_sample"]

    report = json.loads(Path(result["report_path"]).read_text(encoding="utf-8"))
    assert len(report["review_sample"]["reviews"]) == 2
    assert report["diagnostics"]["review_text_status"] == "complete"
    assert report["diagnostics"]["user_agent_profile"] == "linkfox_legacy_default"
    assert report["diagnostics"]["user_agent_platform_agnostic"] is True


def test_review_requests_override_shared_user_agent_and_keep_referer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    queue = iter((_response(PRODUCT_HTML), _response(REVIEW_HTML)))
    calls: list[dict] = []

    def capture(_url: str, **kwargs):
        calls.append(kwargs)
        return next(queue)

    monkeypatch.setattr(analyze_reviews, "fetch_web", capture)

    result = analyze_reviews.run({"asin": INPUT_ASIN})

    expected_user_agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
    assert result["success"] is True
    assert [call["headers"]["User-Agent"] for call in calls] == [expected_user_agent, expected_user_agent]
    assert "Referer" not in calls[0]["headers"]
    assert calls[1]["headers"]["Referer"] == result["product_summary"]["canonical_url"]
    assert result["diagnostics"]["user_agent_profile"] == "linkfox_legacy_default"
    assert result["diagnostics"]["user_agent_platform_agnostic"] is True


def test_listing_analysis_does_not_inherit_linkfox_user_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    captured_headers: dict[str, str] = {}

    def capture(_url: str, **kwargs):
        captured_headers.update(kwargs["headers"])
        return _response(PRODUCT_HTML)

    monkeypatch.setattr(analyze_listing, "fetch_web", capture)

    result = analyze_listing.run({"asin": INPUT_ASIN})

    assert result["success"] is True
    assert "User-Agent" not in captured_headers


@pytest.mark.parametrize(
    ("review_response", "expected_status", "expected_kind"),
    [
        (_response("<form action='/errors/validateCaptcha'>challenge</form>"), "blocked", "validatecaptcha"),
        (
            _response("<main id='authportal-main-section'>Sign in</main>", final_url="https://www.amazon.com/ap/signin"),
            "blocked",
            "sign_in_required",
        ),
        (
            _response("guard", final_url="https://www.amazon.com/edgex/guard/rx?__rx_csd=token"),
            "blocked",
            "amazon_guard",
        ),
        (_response("Forbidden", status=403), "blocked", "http_403"),
        (_response("Too many requests", status=429), "blocked", "http_429"),
        (_response("Service unavailable", status=503), "blocked", "http_503"),
        (_response("Page Not Found", status=404), "failed", "review_endpoint_unavailable"),
    ],
)
def test_review_page_failures_preserve_product_aggregates(
    review_response: _shared.WebResponse,
    expected_status: str,
    expected_kind: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _sequence(monkeypatch, _response(PRODUCT_HTML), review_response)

    result = analyze_reviews.run({"asin": INPUT_ASIN})

    assert result["success"] is True
    assert result["status"] == "partial"
    assert result["product_summary"]["rating"] == 4.4
    assert result["review_sample"]["parsed_reviews"] == 0
    assert result["sentiment"] is None
    assert result["internal_actions"] == []
    assert result["diagnostics"]["review_text_status"] == expected_status
    assert result["diagnostics"]["review_pages"][0]["page_kind"] == expected_kind
    if expected_status == "blocked":
        assert result["diagnostics"]["review_pages"][0]["blocked_marker"] == expected_kind
    assert result["diagnostics"]["empty_result_confirmed"] is False


def test_product_preflight_block_is_not_downgraded_to_partial(monkeypatch: pytest.MonkeyPatch) -> None:
    _sequence(monkeypatch, _response("<h1>Robot Check</h1>"))

    result = analyze_reviews.run({"asin": INPUT_ASIN})

    assert result["success"] is False
    assert result["status"] == "blocked"
    assert result["resolved_asin"] == ""
    assert result["diagnostics"]["user_agent_profile"] == "linkfox_legacy_default"
    assert result["diagnostics"]["user_agent_platform_agnostic"] is True
    assert Path(result["report_path"]).is_file()


def test_explicit_empty_and_unrecognized_review_pages_stay_distinct(monkeypatch: pytest.MonkeyPatch) -> None:
    _sequence(monkeypatch, _response(PRODUCT_HTML), _response("<p>No customer reviews</p>"))
    empty = analyze_reviews.run({"asin": INPUT_ASIN})

    assert empty["status"] == "complete"
    assert empty["diagnostics"]["empty_result_confirmed"] is True
    assert empty["diagnostics"]["review_text_status"] == "complete"

    _sequence(monkeypatch, _response(PRODUCT_HTML), _response("<html>simplified page</html>"))
    unknown = analyze_reviews.run({"asin": INPUT_ASIN})

    assert unknown["status"] == "partial"
    assert unknown["diagnostics"]["empty_result_confirmed"] is False
    assert unknown["diagnostics"]["review_text_status"] == "failed"
    assert unknown["diagnostics"]["review_pages"][0]["page_kind"] == "unrecognized"


def test_review_deduplication_and_body_limit() -> None:
    long_body = "x" * 700
    source = REVIEW_HTML.replace("The jar was broken and leaking. Bad packaging.", long_body)
    reviews = analyze_reviews.parse_review_page(source)

    assert len(reviews[1]["body"]) == 500
    assert len(analyze_reviews.deduplicate_reviews([*reviews, reviews[0]])) == 2
