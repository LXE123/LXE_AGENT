"""Tests for the Amazon shipment-hub delivery-window reader.

The parsing cases use the **exact** window strings harvested from a real
25-row shipment hub page (Sept 2026), so the format coverage is evidence-backed
rather than invented.  The browser half is exercised with a fake driver: that
proves the wiring, never that the selector matches a live page.
"""

from __future__ import annotations

import json
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest

from services.agent_cli.browser.amazon_fba import delivery_window_list as dwl

PAGE_URL = "https://sellercentral.amazon.com/fba/inbound-shipment/summary/contents"

#: Verbatim ``data-atom-id="primary"`` values from the real page (end year 2026).
REAL_WINDOW_SAMPLES = [
    ("9月6日 - 2026年9月12日", "2026-09-06", "2026-09-12", 7),
    ("9月6日 - 2026年9月19日", "2026-09-06", "2026-09-19", 14),
    ("8月30日 - 2026年9月5日", "2026-08-30", "2026-09-05", 7),
    ("9月13日 - 2026年9月19日", "2026-09-13", "2026-09-19", 7),
    ("9月20日 - 2026年9月26日", "2026-09-20", "2026-09-26", 7),
    ("9月27日 - 2026年10月3日", "2026-09-27", "2026-10-03", 7),
    ("10月4日 - 2026年10月10日", "2026-10-04", "2026-10-10", 7),
    ("10月11日 - 2026年10月17日", "2026-10-11", "2026-10-17", 7),
    ("10月23日 - 2026年11月5日", "2026-10-23", "2026-11-05", 14),
]


class _FakeDriver:
    def __init__(self, cells: list[dict[str, str]]) -> None:
        self.cells = list(cells)
        self.opened: list[str] = []
        self.scripts: list[tuple[str, tuple[object, ...]]] = []

    def get(self, url: str) -> None:
        self.opened.append(str(url))

    def execute_script(self, script: str, *args: object) -> list[dict[str, str]]:
        self.scripts.append((script, args))
        return list(self.cells)


def _fake_browser_session(driver: _FakeDriver, output_dir: Path):
    """Stand-in for ``browser_session`` that accepts the real keyword arguments."""

    @contextmanager
    def _session(**_kwargs: object):
        yield SimpleNamespace(driver=driver, output_dir=output_dir)

    return _session


def _cell(row_id: str, column: str, text: str) -> dict[str, str]:
    return {"rowId": row_id, "column": column, "text": text, "cellText": text}


def _hub_cells(pairs: list[tuple[str, str]]) -> list[dict[str, str]]:
    """Build the cell payload the page script returns for ``(id, window)`` pairs."""
    cells: list[dict[str, str]] = []
    for row_id, window in pairs:
        cells.append(_cell(row_id, dwl.DELIVERY_WINDOW_COLUMN, window))
        cells.append(_cell(row_id, dwl.SHIPMENT_ID_COLUMN, f"FBA STA -YEG2 {row_id}"))
    return cells


def _arguments(**overrides: object) -> dict[str, object]:
    args: dict[str, object] = {"store_id": "oauth-store", "page_url": PAGE_URL}
    args.update(overrides)
    return args


def _explode(*_args: object, **_kwargs: object) -> None:
    raise AssertionError("this path must not touch the browser")


# --------------------------------------------------------------------------
# Window parsing — real page strings.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("text", "start", "end", "span_days"),
    REAL_WINDOW_SAMPLES,
    ids=[sample[0] for sample in REAL_WINDOW_SAMPLES],
)
def test_parses_every_window_string_seen_on_the_real_page(
    text: str, start: str, end: str, span_days: int
) -> None:
    parsed = dwl.parse_delivery_window(text)

    assert parsed["status"] == dwl.WINDOW_PARSED
    assert parsed["start_date"] == start
    assert parsed["end_date"] == end
    assert parsed["span_days"] == span_days
    assert parsed["raw"] == text


def test_missing_year_on_the_start_is_inferred_from_the_end() -> None:
    parsed = dwl.parse_delivery_window("9月6日 - 2026年9月12日")

    assert parsed["start_date"] == "2026-09-06"
    assert parsed["start_year_inferred"] is True


def test_a_window_crossing_new_year_does_not_reuse_the_end_year() -> None:
    """The rule that would silently compute a 350-day window if it were wrong."""
    parsed = dwl.parse_delivery_window("12月28日 - 2027年1月3日")

    assert parsed["status"] == dwl.WINDOW_PARSED
    assert parsed["start_date"] == "2026-12-28"
    assert parsed["end_date"] == "2027-01-03"
    assert parsed["span_days"] == 7


def test_a_window_with_both_years_present_is_not_marked_inferred() -> None:
    parsed = dwl.parse_delivery_window("2026年9月6日 - 2026年9月12日")

    assert parsed["status"] == dwl.WINDOW_PARSED
    assert parsed["start_year_inferred"] is False


def test_an_empty_window_is_missing_not_unparsed() -> None:
    parsed = dwl.parse_delivery_window("")

    assert parsed["status"] == dwl.WINDOW_MISSING
    assert parsed["start_date"] == ""
    assert parsed["end_date"] == ""


def test_an_unknown_format_is_reported_unparsed_never_guessed() -> None:
    parsed = dwl.parse_delivery_window("Sep 6, 2026 - Sep 12, 2026")

    assert parsed["status"] == dwl.WINDOW_UNPARSED
    assert parsed["start_date"] == ""
    assert "中文日期格式" in parsed["reason"]


def test_a_single_date_is_unparsed_rather_than_treated_as_a_whole_window() -> None:
    parsed = dwl.parse_delivery_window("2026年9月12日")

    assert parsed["status"] == dwl.WINDOW_UNPARSED
    assert "两段" in parsed["reason"]


def test_a_reversed_window_is_flagged_inconsistent() -> None:
    parsed = dwl.parse_delivery_window("2026年9月20日 - 2026年9月12日")

    assert parsed["status"] == dwl.WINDOW_INCONSISTENT
    assert "晚于" in parsed["reason"]


def test_an_impossible_day_is_unparsed() -> None:
    parsed = dwl.parse_delivery_window("2月30日 - 2026年3月5日")

    assert parsed["status"] == dwl.WINDOW_UNPARSED


# --------------------------------------------------------------------------
# Row assembly.
# --------------------------------------------------------------------------


def test_build_rows_groups_cells_by_the_row_id_attribute() -> None:
    built = dwl.build_rows(_hub_cells([("FBA19TESTSHIP1", "9月6日 - 2026年9月12日")]))

    assert len(built["rows"]) == 1
    row = built["rows"][0]
    assert row["fba_shipment_id"] == "FBA19TESTSHIP1"
    assert row["row_id_is_fba_shipment_id"] is True
    assert row["delivery_window"]["start_date"] == "2026-09-06"


def test_build_rows_keeps_page_order() -> None:
    built = dwl.build_rows(
        _hub_cells(
            [
                ("FBA19AAAAAAA", "9月6日 - 2026年9月12日"),
                ("FBA19BBBBBBB", "9月13日 - 2026年9月19日"),
                ("FBA19CCCCCCC", "9月20日 - 2026年9月26日"),
            ]
        )
    )

    assert [row["fba_shipment_id"] for row in built["rows"]] == [
        "FBA19AAAAAAA",
        "FBA19BBBBBBB",
        "FBA19CCCCCCC",
    ]


def test_a_row_without_a_window_cell_is_reported_missing() -> None:
    built = dwl.build_rows([_cell("FBA19TESTSHIP1", dwl.SHIPMENT_ID_COLUMN, "FBA19TESTSHIP1")])

    assert built["rows"][0]["delivery_window"]["status"] == dwl.WINDOW_MISSING


def test_duplicate_cells_are_counted_not_silently_merged() -> None:
    cells = _hub_cells([("FBA19TESTSHIP1", "9月6日 - 2026年9月12日")])
    cells.append(_cell("FBA19TESTSHIP1", dwl.DELIVERY_WINDOW_COLUMN, "9月13日 - 2026年9月19日"))

    built = dwl.build_rows(cells)

    assert built["duplicate_pairs"] == [
        {"column": dwl.DELIVERY_WINDOW_COLUMN, "row_id": "FBA19TESTSHIP1", "count": 2}
    ]
    # The first cell wins, so the duplicate is visible rather than averaged away.
    assert built["rows"][0]["delivery_window"]["start_date"] == "2026-09-06"


def test_collect_problems_flags_a_row_id_that_is_not_an_fba_shipment_id() -> None:
    built = dwl.build_rows(_hub_cells([("NOT-AN-FBA-ID", "9月6日 - 2026年9月12日")]))

    problems = dwl.collect_problems(built["rows"])

    assert [item["kind"] for item in problems] == ["row_id_not_fba_shipment_id"]


def test_collect_problems_treats_a_missing_window_as_normal() -> None:
    built = dwl.build_rows([_cell("FBA19TESTSHIP1", dwl.SHIPMENT_ID_COLUMN, "x")])

    assert dwl.collect_problems(built["rows"]) == []


# --------------------------------------------------------------------------
# Selection.
# --------------------------------------------------------------------------


def test_select_rows_returns_everything_when_no_filter_is_given() -> None:
    built = dwl.build_rows(
        _hub_cells(
            [
                ("FBA19AAAAAAA", "9月6日 - 2026年9月12日"),
                ("FBA19BBBBBBB", "9月13日 - 2026年9月19日"),
            ]
        )
    )

    selection = dwl.select_rows(built["rows"], [])

    assert len(selection["selected"]) == 2
    assert selection["unmatched"] == []


def test_select_rows_reports_a_requested_id_that_is_absent() -> None:
    built = dwl.build_rows(_hub_cells([("FBA19AAAAAAA", "9月6日 - 2026年9月12日")]))

    selection = dwl.select_rows(built["rows"], ["FBA19AAAAAAA", "FBA19ZZZZZZZ"])

    assert [row["fba_shipment_id"] for row in selection["selected"]] == ["FBA19AAAAAAA"]
    assert selection["unmatched"] == ["FBA19ZZZZZZZ"]


# --------------------------------------------------------------------------
# Argument contract.
# --------------------------------------------------------------------------


def test_plan_read_requires_the_store_id() -> None:
    with pytest.raises(dwl.DeliveryWindowArgumentError, match="store_id"):
        dwl.plan_read({"page_url": PAGE_URL})


def test_plan_read_requires_an_absolute_page_url() -> None:
    with pytest.raises(dwl.DeliveryWindowArgumentError, match="page_url"):
        dwl.plan_read({"store_id": "oauth-store", "page_url": "/fba/inbound-shipment"})


def test_plan_read_rejects_buyer_order_numbers_in_shipment_ids() -> None:
    with pytest.raises(dwl.DeliveryWindowArgumentError, match="非法 FBA 货件编号"):
        dwl.plan_read(_arguments(shipment_ids=["123-1234567-1234567"]))


def test_plan_read_accepts_a_comma_separated_string_and_deduplicates() -> None:
    plan = dwl.plan_read(_arguments(shipment_ids="FBA19AAAAAAA, fba19aaaaaaa FBA19BBBBBBB"))

    assert plan["shipment_ids"] == ["FBA19AAAAAAA", "FBA19BBBBBBB"]


def test_plan_read_defaults_and_validates_the_page_wait_timeout() -> None:
    assert dwl.plan_read(_arguments())["timeout_sec"] == dwl.DEFAULT_TIMEOUT_SECONDS
    assert dwl.plan_read(_arguments(timeout_sec="5"))["timeout_sec"] == 5

    for invalid in (0, 601, "later"):
        with pytest.raises(dwl.DeliveryWindowArgumentError, match="timeout_sec"):
            dwl.plan_read(_arguments(timeout_sec=invalid))


# --------------------------------------------------------------------------
# run() wiring.
# --------------------------------------------------------------------------


def test_run_plan_only_never_touches_the_browser_or_the_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)
    monkeypatch.setattr(dwl, "browser_session", _explode)

    payload = dwl.run(_arguments(plan_only=True))

    assert payload["success"] is True
    assert payload["finished"] is True
    assert payload["data"]["rows"] == []
    assert "plan_only" in payload["notice"]


def test_run_fails_without_an_agent_session(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)

    payload = dwl.run(_arguments())

    assert payload["success"] is False
    assert payload["exception"] == "缺少 LXE_AGENT_SESSION_ID"


def test_read_hub_cells_passes_the_hub_selector_and_the_two_columns() -> None:
    driver = _FakeDriver([])

    dwl.read_hub_cells(driver)

    script, args = driver.scripts[0]
    assert dwl.SHIPMENT_HUB_CELL_SELECTOR == '[data-hub-key="shipment_hub"][data-row-id]'
    assert args == (
        dwl.SHIPMENT_HUB_CELL_SELECTOR,
        "shipmentId,deliveryWindow",
        '[data-atom-id="primary"]',
    )
    assert "deepQuerySelectorAll" in script


def test_wait_for_hub_cells_retries_until_the_spa_rows_render(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = _hub_cells([("FBA19AAAAAAA", "9月6日 - 2026年9月12日")])
    other = _hub_cells([("FBA19BBBBBBB", "9月13日 - 2026年9月19日")])
    reads = iter([other, expected])
    clock = iter([0.0, 0.1])
    sleeps: list[float] = []
    monkeypatch.setattr(dwl, "read_hub_cells", lambda _driver: next(reads))
    monkeypatch.setattr(dwl.time, "monotonic", lambda: next(clock))
    monkeypatch.setattr(dwl.time, "sleep", sleeps.append)

    cells = dwl.wait_for_hub_cells(
        object(), timeout_seconds=1, shipment_ids=["FBA19AAAAAAA"]
    )

    assert cells == expected
    assert sleeps == [0.2]


def test_run_reads_the_hub_and_writes_the_artifact(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    driver = _FakeDriver(
        _hub_cells(
            [
                ("FBA19AAAAAAA", "9月6日 - 2026年9月12日"),
                ("FBA19BBBBBBB", "10月4日 - 2026年10月10日"),
            ]
        )
    )
    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "session-1")
    monkeypatch.setattr(dwl, "workflow_output_dir", lambda _session_id: tmp_path)
    monkeypatch.setattr(dwl, "browser_session", _fake_browser_session(driver, tmp_path))

    payload = dwl.run(_arguments())

    assert driver.opened == [PAGE_URL]
    assert payload["success"] is True
    assert payload["finished"] is True
    assert payload["data"]["page_row_count"] == 2
    assert [row["delivery_window"]["start_date"] for row in payload["data"]["rows"]] == [
        "2026-09-06",
        "2026-10-04",
    ]
    artifact = json.loads(Path(payload["file_path"][0]["value"]).read_text(encoding="utf-8"))
    assert artifact["page_url"] == PAGE_URL
    assert artifact["page_row_count"] == 2
    assert len(artifact["rows"]) == 2


def test_run_fails_loudly_when_the_page_yields_no_rows(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A wrong page or a drifted selector reads zero rows — never a clean empty list."""
    driver = _FakeDriver([])
    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "session-1")
    monkeypatch.setattr(dwl, "workflow_output_dir", lambda _session_id: tmp_path)
    monkeypatch.setattr(dwl, "browser_session", _fake_browser_session(driver, tmp_path))
    monkeypatch.setattr(dwl, "wait_for_hub_cells", lambda *_args, **_kwargs: [])

    payload = dwl.run(_arguments())

    assert payload["success"] is False
    assert payload["finished"] is False
    assert "等待 60 秒后仍未读到货件行" in payload["exception"]
    assert "马帮认证" in payload["exception"]
    assert payload["auth_refresh_required"] is False


def test_run_fails_loudly_when_the_window_format_is_unknown(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    driver = _FakeDriver(_hub_cells([("FBA19AAAAAAA", "Sep 6, 2026 - Sep 12, 2026")]))
    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "session-1")
    monkeypatch.setattr(dwl, "workflow_output_dir", lambda _session_id: tmp_path)
    monkeypatch.setattr(dwl, "browser_session", _fake_browser_session(driver, tmp_path))

    payload = dwl.run(_arguments())

    assert payload["success"] is False
    assert "无法可信解析" in payload["exception"]
    assert payload["data"]["problems"][0]["kind"] == dwl.WINDOW_UNPARSED


def test_run_fails_loudly_when_a_requested_shipment_is_not_on_the_page(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    driver = _FakeDriver(_hub_cells([("FBA19AAAAAAA", "9月6日 - 2026年9月12日")]))
    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "session-1")
    monkeypatch.setattr(dwl, "workflow_output_dir", lambda _session_id: tmp_path)
    monkeypatch.setattr(dwl, "browser_session", _fake_browser_session(driver, tmp_path))
    monkeypatch.setattr(
        dwl,
        "wait_for_hub_cells",
        lambda active_driver, **_kwargs: dwl.read_hub_cells(active_driver),
    )

    payload = dwl.run(_arguments(shipment_ids=["FBA19AAAAAAA", "FBA19ZZZZZZZ"]))

    assert payload["success"] is False
    assert payload["data"]["unmatched"] == ["FBA19ZZZZZZZ"]
    assert "FBA19ZZZZZZZ" in payload["exception"]


def test_run_succeeds_when_a_shipment_has_no_window_yet(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    driver = _FakeDriver([_cell("FBA19AAAAAAA", dwl.SHIPMENT_ID_COLUMN, "FBA19AAAAAAA")])
    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "session-1")
    monkeypatch.setattr(dwl, "workflow_output_dir", lambda _session_id: tmp_path)
    monkeypatch.setattr(dwl, "browser_session", _fake_browser_session(driver, tmp_path))

    payload = dwl.run(_arguments())

    assert payload["success"] is True
    assert "尚未分配送达时段" in payload["notice"]


def test_run_reports_the_real_browser_error_verbatim(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    class _Boom(_FakeDriver):
        def get(self, url: str) -> None:
            raise RuntimeError("session not found: oauth-store")

    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "session-1")
    monkeypatch.setattr(dwl, "workflow_output_dir", lambda _session_id: tmp_path)
    monkeypatch.setattr(dwl, "browser_session", _fake_browser_session(_Boom([]), tmp_path))

    payload = dwl.run(_arguments())

    assert payload["success"] is False
    assert payload["exception"] == "RuntimeError: session not found: oauth-store"


def test_run_rejects_a_bad_argument_before_any_browser_work(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(dwl, "browser_session", _explode)

    payload = dwl.run({"store_id": "", "page_url": PAGE_URL})

    assert payload["success"] is False
    assert "store_id" in payload["exception"]
