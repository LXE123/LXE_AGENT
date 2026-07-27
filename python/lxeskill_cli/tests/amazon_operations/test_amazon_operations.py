from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest
import requests

from services.agent_cli.amazon_operations import _shared
from services.agent_cli.amazon_operations import analyze_listing
from services.agent_cli.amazon_operations import analyze_reviews
from services.agent_cli.amazon_operations import research_competitors
from services.agent_cli.amazon_operations import research_keywords


COMPLETE_LISTING_HTML = """
<html><body>
  <span id="productTitle">Acme &amp; Co Premium Seasoning Blend, 12 Ounce Pack of 2</span>
  <div id="feature-bullets"><ul>
    <li><span class="a-list-item">PREMIUM QUALITY blend made for your everyday cooking and easy meal preparation.</span></li>
    <li><span class="a-list-item">ENJOY balanced flavor in soups, vegetables, marinades, and grilled dishes.</span></li>
    <li><span class="a-list-item">IDEAL 12 OUNCE size keeps your pantry ready for family meals.</span></li>
    <li><span class="a-list-item">EASY TO USE shaker packaging supports accurate seasoning and storage.</span></li>
    <li><span class="a-list-item">YOUR KITCHEN gets a versatile blend with clearly labeled ingredients.</span></li>
  </ul></div>
  <div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">$24.99</span></span></div>
  <span id="acrPopover"><span>4.6 out of 5 stars</span></span>
  <span id="acrCustomerReviewText">1,234 ratings</span>
  <div id="altImages">
    <li class="imageThumbnail"></li><li class="imageThumbnail"></li><li class="imageThumbnail"></li>
    <li class="imageThumbnail"></li><li class="imageThumbnail"></li><li class="imageThumbnail"></li>
    <li class="imageThumbnail"></li>
  </div>
  <a id="bylineInfo">Brand: Acme</a>
  <div id="wayfinding-breadcrumbs_feature_div">Grocery &amp; Gourmet Food</div>
</body></html>
"""


def _response(text: str, *, status: int = 200, content_type: str = "text/html") -> _shared.WebResponse:
    return _shared.WebResponse(
        requested_url="https://www.amazon.com/test",
        final_url="https://www.amazon.com/test",
        status_code=status,
        text=text,
        content_type=content_type,
    )


@pytest.fixture(autouse=True)
def _reports_in_tmp(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_shared, "dataset_dir", lambda dataset_id, *parts: tmp_path.joinpath(dataset_id, *map(str, parts)))


def test_listing_complete_page_is_normalized_and_scored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(analyze_listing, "fetch_web", lambda *_args, **_kwargs: _response(COMPLETE_LISTING_HTML))

    result = analyze_listing.run({"asin": "b0dc6f1mtd", "marketplace": "com"})

    assert result["success"] is True
    assert result["status"] == "complete"
    assert result["source"] == "amazon_public_web"
    assert result["listing"]["title"].startswith("Acme & Co")
    assert result["listing"]["brand"] == "Acme"
    assert result["listing"]["review_count"] == 1234
    assert result["listing"]["images_count"] == 7
    assert result["scores"] == {
        "title": 80,
        "bullets": 65,
        "images": 100,
        "reviews": 100,
        "overall": 85,
        "grade": "A",
    }
    assert result["missing_fields"] == []
    assert result["data_completeness"] == 1.0
    assert result["diagnostics"]["confidence"] == "high"
    assert Path(result["report_path"]).is_file()


def test_listing_partial_page_keeps_upstream_score_and_reports_completeness(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    partial = """
    <span id="productTitle">Acme Example Product Title</span>
    <div id="feature-bullets"><span class="a-list-item">A useful observed product detail.</span></div>
    <div id="altImages"><li class="imageThumbnail"></li></div>
    """
    monkeypatch.setattr(analyze_listing, "fetch_web", lambda *_args, **_kwargs: _response(partial))

    result = analyze_listing.run({"asin": "B0DC6F1MTD"})

    assert result["success"] is True
    assert result["status"] == "partial"
    assert result["scores"] == {
        "title": 35,
        "bullets": 10,
        "images": 20,
        "reviews": 0,
        "overall": 18,
        "grade": "F",
    }
    assert result["missing_fields"] == ["rating", "review_count"]
    assert result["data_completeness"] == 0.6
    assert result["diagnostics"]["score_available"] is True
    assert result["diagnostics"]["missing_fields"] == ["rating", "review_count"]


def test_upstream_scoring_golden_case_uses_original_thresholds_and_flooring() -> None:
    scores, _recommendations = analyze_listing.score_listing(
        {
            "title": "Acme Example Product Title",
            "bullets": ["A useful observed product detail."],
            "images_count": 3,
            "rating": 4.2,
            "review_count": 50,
        },
    )

    assert scores == {
        "title": 35,
        "bullets": 10,
        "images": 50,
        "reviews": 70,
        "overall": 39,
        "grade": "F",
    }


def test_upstream_bullet_benefit_vocabulary_is_preserved() -> None:
    score, _feedback = analyze_listing._score_bullets(
        ["BEST GUARANTEED SATISFACTION for practical everyday use."],
    )

    assert score == 45


@pytest.mark.parametrize(
    ("response", "marker"),
    [
        (_response("<h1>Robot Check</h1>"), "robot check"),
        (_response("<form action='validateCaptcha'>challenge</form>"), "validatecaptcha"),
        (_response("Forbidden", status=403), "http_403"),
        (_response("Too many requests", status=429), "http_429"),
        (_response("Service unavailable", status=503), "http_503"),
    ],
)
def test_listing_detects_hard_and_soft_blocks(
    response: _shared.WebResponse,
    marker: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(analyze_listing, "fetch_web", lambda *_args, **_kwargs: response)

    result = analyze_listing.run({"asin": "B0DC6F1MTD"})

    assert result["success"] is False
    assert result["status"] == "blocked"
    assert result["diagnostics"]["blocked_marker"] == marker


def test_listing_rejects_unrecognized_200_page(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(analyze_listing, "fetch_web", lambda *_args, **_kwargs: _response("<html>hello</html>"))

    result = analyze_listing.run({"asin": "B0DC6F1MTD"})

    assert result["success"] is False
    assert result["status"] == "failed"
    assert result["diagnostics"]["page_kind"] == "unrecognized"


def test_fetch_web_preserves_timeout_type_and_message(monkeypatch: pytest.MonkeyPatch) -> None:
    def timeout(*_args, **_kwargs):
        raise requests.Timeout("read timed out")

    monkeypatch.setattr(_shared, "external_requests_session", SimpleNamespace(get=timeout))

    result = _shared.fetch_web("https://www.amazon.com/test")

    assert result.exception_type == "Timeout"
    assert result.error == "read timed out"


def test_listing_timeout_fails_without_scoring(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        analyze_listing,
        "fetch_web",
        lambda *_args, **_kwargs: _shared.WebResponse(
            requested_url="https://www.amazon.com/dp/B0DC6F1MTD",
            final_url="https://www.amazon.com/dp/B0DC6F1MTD",
            status_code=None,
            text="",
            content_type="",
            exception_type="Timeout",
            error="read timed out",
        ),
    )

    result = analyze_listing.run({"asin": "B0DC6F1MTD"})

    assert result["success"] is False
    assert result["status"] == "failed"
    assert result["source"] == "amazon_public_web"
    assert "scores" not in result


def test_keyword_research_returns_compact_summary_and_full_report(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(research_keywords, "_REQUEST_PAUSE_SECONDS", 0)

    def suggestions(prefix: str, _marketplace: str) -> dict:
        values = ["seasoning blend organic", "seasoning blend gift set"] if prefix == "seasoning blend" else []
        if prefix == "seasoning blend a":
            values = ["all purpose seasoning blend"]
        return {"ok": True, "status": "complete", "message": "", "diagnostics": {}, "suggestions": values}

    monkeypatch.setattr(research_keywords, "_fetch_suggestions", suggestions)

    result = research_keywords.run({"seed": "seasoning blend", "depth": 1})

    assert result["success"] is True
    assert result["status"] == "complete"
    assert result["source"] == "amazon_public_web"
    assert result["total_keywords"] == 3
    assert len(result["top_keywords"]) == 3
    assert result["diagnostics"]["request_count"] == 27
    assert Path(result["report_path"]).is_file()


def test_keyword_research_distinguishes_partial_failure_from_empty(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(research_keywords, "_REQUEST_PAUSE_SECONDS", 0)

    def suggestions(prefix: str, _marketplace: str) -> dict:
        if prefix == "seed":
            return {"ok": True, "status": "complete", "message": "", "diagnostics": {}, "suggestions": ["seed one"]}
        if prefix == "seed a":
            return {
                "ok": False,
                "status": "blocked",
                "message": "challenged",
                "diagnostics": {"http_status": 429},
                "suggestions": [],
            }
        return {"ok": True, "status": "complete", "message": "", "diagnostics": {}, "suggestions": []}

    monkeypatch.setattr(research_keywords, "_fetch_suggestions", suggestions)

    result = research_keywords.run({"seed": "seed"})

    assert result["success"] is True
    assert result["status"] == "partial"
    assert result["diagnostics"]["empty_result_confirmed"] is False
    assert result["diagnostics"]["request_errors"][0]["http_status"] == 429


def test_keyword_research_accepts_confirmed_empty_result(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(research_keywords, "_REQUEST_PAUSE_SECONDS", 0)
    monkeypatch.setattr(
        research_keywords,
        "_fetch_suggestions",
        lambda *_args: {"ok": True, "status": "complete", "message": "", "diagnostics": {}, "suggestions": []},
    )

    result = research_keywords.run({"seed": "unfindable phrase"})

    assert result["success"] is True
    assert result["status"] == "complete"
    assert result["total_keywords"] == 0
    assert result["diagnostics"]["empty_result_confirmed"] is True


def test_keyword_invalid_json_is_a_real_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        research_keywords,
        "fetch_web",
        lambda *_args, **_kwargs: _response("not-json", content_type="application/json"),
    )

    result = research_keywords._fetch_suggestions("seed", "com")

    assert result["ok"] is False
    assert result["status"] == "failed"
    assert "invalid JSON" in result["message"]


def test_competitor_parser_deduplicates_and_honors_limit() -> None:
    source = """
    <div data-component-type="s-search-result" data-asin="B000000001"><h2><span>First</span></h2></div>
    <div data-component-type="s-search-result" data-asin="B000000001"><h2><span>Duplicate</span></h2></div>
    <div data-component-type="s-search-result" data-asin="B000000002"><h2><span>Second</span></h2></div>
    """

    results = research_competitors.parse_search_page(source, 2)

    assert [item["asin"] for item in results] == ["B000000001", "B000000002"]
    assert [item["rank"] for item in results] == [1, 2]


def test_competitor_research_only_accepts_explicit_empty_page(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        research_competitors,
        "fetch_web",
        lambda *_args, **_kwargs: _response("<div>No results for unusual phrase</div>"),
    )

    confirmed = research_competitors.run({"query": "unusual phrase", "limit": 5})

    assert confirmed["success"] is True
    assert confirmed["source"] == "amazon_public_web"
    assert confirmed["total_results"] == 0
    assert confirmed["diagnostics"]["empty_result_confirmed"] is True

    monkeypatch.setattr(
        research_competitors,
        "fetch_web",
        lambda *_args, **_kwargs: _response("<html>simplified response</html>"),
    )
    unknown = research_competitors.run({"query": "unusual phrase", "limit": 5})
    assert unknown["success"] is False
    assert unknown["diagnostics"]["page_kind"] == "unrecognized"


def test_catalog_attributes_amazon_operations_commands_to_their_source_skills() -> None:
    from lxeskill.business import load_catalog

    entries = [
        entry
        for entry in load_catalog().values()
        if list(entry.get("command_path") or [])[:1] == ["amazon"]
    ]

    assert len(entries) == 4
    owners = {tuple(entry["command_path"]): entry["owner_skills"] for entry in entries}
    assert owners[("amazon", "reviews", "analyze")] == ["amazon-review-monitor"]
    assert all(
        owners[path] == ["amazon-listing-optimizer"]
        for path in (
            ("amazon", "listing", "analyze"),
            ("amazon", "keywords", "research"),
            ("amazon", "competitors", "research"),
        )
    )
    assert all(entry["artifact_paths"] == [{"field": "report_path", "role": "diagnostic"}] for entry in entries)


@pytest.mark.parametrize(
    ("runner", "arguments", "message"),
    [
        (analyze_listing.run, {"asin": "bad"}, "asin must contain exactly 10"),
        (analyze_listing.run, {"asin": "B0DC6F1MTD", "marketplace": "co.uk"}, "marketplace must be 'com'"),
        (research_keywords.run, {"seed": "", "depth": 1}, "seed is required"),
        (research_keywords.run, {"seed": "seed", "depth": 3}, "depth must be between 1 and 2"),
        (research_competitors.run, {"query": "query", "limit": 11}, "limit must be between 1 and 10"),
        (analyze_reviews.run, {"asin": "B0DC6F1MTD", "pages": 4}, "pages must be between 1 and 3"),
    ],
)
def test_public_input_validation(runner, arguments: dict, message: str) -> None:
    result = runner(arguments)

    assert result["success"] is False
    assert result["status"] == "failed"
    assert message in result["message"]
    assert result["report_path"] == ""
