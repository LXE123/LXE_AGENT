"""Tests for the FBA delivery-window write command (``delivery_window_apply``).

Two kinds of tests live here:

- **Pure logic / HTML reads** — run against the real modal fixture
  (``fixtures/delivery_window_modal.sanitized.html``, committed with the tests).
  Because the production read path is BeautifulSoup
  over ``page_source``, these tests exercise the *production* reader, not a
  mirror of it.
- **Orchestration** — a scripted fake driver feeds the same HTML per stage and
  records every injected script, so the stop gates (E1-E10) are proven by the
  clicks that did **not** happen.
"""

from __future__ import annotations

import datetime as dt
import json
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

import pytest
from selenium.common.exceptions import WebDriverException

from services.agent_cli.browser.amazon_fba import delivery_window_apply as dwa

FIXTURE = Path(__file__).parent / "fixtures" / "delivery_window_modal.sanitized.html"

SHIPMENT = "FBA19NDSQ2SK"
SHIPMENT_B = "FBA19QT6571T"
SHIPMENT_C = "FBA19L3SBMJ1"
ORIGIN = "https://sellercentral.amazon.com"
PAGE_URL = f"{ORIGIN}/fba/inbound-shipment/summary?wf=all"
CURRENT_WINDOW = "2026年10月11日 - 2026年10月17日"
TARGET_WINDOW = "2026年10月25日 - 2026年10月31日"
TARGET_DATE_INPUT = "2026-10-28"
NOW = dt.datetime(2026, 10, 1, 3, 0, tzinfo=dt.timezone.utc)


@pytest.fixture(autouse=True)
def _fast_waits(monkeypatch):
    """No real sleeping and one-shot timeouts, so failure branches are instant."""
    monkeypatch.setattr(dwa, "_SLEEP", lambda _seconds: None)
    monkeypatch.setattr(dwa, "MODAL_TIMEOUT_SECONDS", 0)
    monkeypatch.setattr(dwa, "LEGEND_TIMEOUT_SECONDS", 0)
    monkeypatch.setattr(dwa, "MODAL_CLOSE_TIMEOUT_SECONDS", 0)
    monkeypatch.setattr(dwa, "_utc_now", lambda: NOW)


@pytest.fixture(scope="module")
def modal_html() -> str:
    return FIXTURE.read_text(encoding="utf-8")


# --------------------------------------------------------------------------
# Pure logic.
# --------------------------------------------------------------------------


def test_parse_target_date_accepts_the_documented_forms():
    today = dt.date(2026, 1, 5)
    for raw in ("2026-10-28", "2026/10/28", "2026.10.28", "2026年10月28日"):
        assert dwa.parse_target_date(raw, today=today) == dt.date(2026, 10, 28)
    for raw in ("10.28", "10-28", "10/28", "10月28日", "10月28"):
        assert dwa.parse_target_date(raw, today=today) == dt.date(2026, 10, 28)


def test_parse_target_date_normalizes_fullwidth_digits():
    assert dwa.parse_target_date("１０.２８", today=dt.date(2026, 1, 5)) == dt.date(2026, 10, 28)


def test_parse_target_date_refuses_to_guess_day_month_order():
    with pytest.raises(dwa.DeliveryWindowApplyArgumentError) as excinfo:
        dwa.parse_target_date("28.10", today=dt.date(2026, 1, 5))
    assert "1-12" in str(excinfo.value)


@pytest.mark.parametrize("raw", ["", "   ", "abc", "2026-13-01", "2026-02-30", "10月"])
def test_parse_target_date_rejects_bad_values(raw):
    with pytest.raises(dwa.DeliveryWindowApplyArgumentError):
        dwa.parse_target_date(raw, today=dt.date(2026, 1, 5))


def test_calendar_week_span_is_sunday_to_saturday():
    # 2026-10-28 is a Wednesday -> the delivery week runs Sun 25th .. Sat 31st.
    assert dwa.calendar_week_span(dt.date(2026, 10, 28)) == (
        dt.date(2026, 10, 25),
        dt.date(2026, 10, 31),
    )
    # Both ends of the week map to themselves.
    assert dwa.calendar_week_span(dt.date(2026, 10, 25))[0] == dt.date(2026, 10, 25)
    assert dwa.calendar_week_span(dt.date(2026, 10, 31))[1] == dt.date(2026, 10, 31)
    assert dwa.format_cn_window(*dwa.calendar_week_span(dt.date(2026, 10, 28))) == TARGET_WINDOW


def test_parse_grace_period_with_and_without_the_utc_time():
    with_time = dwa.parse_grace_period("在 2026年10月11日, 00:00 UTC 之前", now=dt.datetime(2026, 10, 1, tzinfo=dt.timezone.utc))
    assert with_time["status"] == dwa.WINDOW_PARSED
    assert with_time["deadline"] == "2026-10-11T00:00:00+00:00"
    assert with_time["editable"] is True
    assert with_time["assumed_midnight_utc"] is False

    without_time = dwa.parse_grace_period("在 2026年10月11日 之前可编辑", now=dt.datetime(2026, 10, 1, tzinfo=dt.timezone.utc))
    assert without_time["status"] == dwa.WINDOW_PARSED
    assert without_time["deadline"] == "2026-10-11T00:00:00+00:00"
    assert without_time["assumed_midnight_utc"] is True


def test_parse_grace_period_reports_a_passed_deadline():
    grace = dwa.parse_grace_period("在 2026年9月27日, 00:00 UTC 之前", now=dt.datetime(2026, 10, 1, tzinfo=dt.timezone.utc))
    assert grace["editable"] is False


@pytest.mark.parametrize("raw", ["", "截止时间待定", "2026年10月11日"])
def test_parse_grace_period_reports_unreadable_text(raw):
    grace = dwa.parse_grace_period(raw, now=dt.datetime(2026, 10, 1, tzinfo=dt.timezone.utc))
    assert grace["status"] != dwa.WINDOW_PARSED
    assert grace["editable"] is None


def test_parse_unit_status_keeps_inventory_progress_as_diagnostic():
    partial = dwa.parse_unit_status("600/602")
    assert partial["status"] == dwa.WINDOW_PARSED
    assert (partial["received"], partial["expected"], partial["unreceived"]) == (600, 602, True)
    assert dwa.parse_unit_status("602/602")["unreceived"] is False
    assert dwa.parse_unit_status("已入库 0 / 预计上架 10")["unreceived"] is True


@pytest.mark.parametrize("raw", ["", "0/0", "等待上架", "10 件"])
def test_parse_unit_status_refuses_to_claim_unreceived(raw):
    unit = dwa.parse_unit_status(raw)
    assert unit["status"] != dwa.WINDOW_PARSED
    assert unit["unreceived"] is None


@pytest.mark.parametrize(
    "label",
    ["2026年10月", "2026年 10 月", "十月 2026", "十月2026", "10月 2026", "2026年 十月", "2026 十一月"],
)
def test_parse_calendar_month_label_covers_both_orders(label):
    # own_carrier's parser raises on the standard Chinese form; this one must not.
    year, month = dwa.parse_calendar_month_label(label)
    assert year == 2026 and month in {10, 11}


@pytest.mark.parametrize("label", ["", "   ", "十月", "2026"])
def test_parse_calendar_month_label_rejects_incomplete_labels(label):
    with pytest.raises(dwa.DeliveryWindowApplyArgumentError):
        dwa.parse_calendar_month_label(label)


def test_window_matches_requires_a_parsed_exact_window():
    from services.agent_cli.browser.amazon_fba import delivery_window_list as dwl

    parsed = dwl.parse_delivery_window("2026年10月25日 - 2026年10月31日")
    assert dwa.window_matches(parsed, dt.date(2026, 10, 25), dt.date(2026, 10, 31)) is True
    assert dwa.window_matches(parsed, dt.date(2026, 10, 25), dt.date(2026, 11, 1)) is False
    assert dwa.window_matches(None, dt.date(2026, 10, 25), dt.date(2026, 10, 31)) is False
    assert dwa.window_matches({"status": "unparsed"}, dt.date(2026, 10, 25), dt.date(2026, 10, 31)) is False


# --------------------------------------------------------------------------
# Argument plan.
# --------------------------------------------------------------------------


def test_plan_apply_defaults_to_a_dry_run_and_derives_the_target_week():
    plan = dwa.plan_apply(
        {"store_id": "store-1", "page_url": PAGE_URL, "shipment_ids": SHIPMENT, "target_date": "10.28"},
        now=NOW,
    )
    assert plan["apply"] is False
    assert plan["timeout_sec"] == dwa.DEFAULT_TIMEOUT_SECONDS
    assert plan["shipment_ids"] == [SHIPMENT]
    assert plan["target_date"] == "2026-10-28"
    assert plan["target_window"] == {
        "start_date": "2026-10-25",
        "end_date": "2026-10-31",
        "span_days": 7,
        "display": TARGET_WINDOW,
    }


def test_plan_apply_reuses_the_read_commands_argument_errors():
    with pytest.raises(Exception) as excinfo:
        dwa.plan_apply({"store_id": "s", "page_url": "amazon.com", "shipment_ids": SHIPMENT, "target_date": "10.28"}, now=NOW)
    assert "page_url 必须是绝对 http(s) 地址" in str(excinfo.value)

    with pytest.raises(Exception) as excinfo:
        dwa.plan_apply({"store_id": "s", "page_url": PAGE_URL, "shipment_ids": "123-1234567-1234567", "target_date": "10.28"}, now=NOW)
    assert "非法 FBA 货件编号" in str(excinfo.value)


def test_plan_apply_requires_at_least_one_shipment():
    with pytest.raises(dwa.DeliveryWindowApplyArgumentError) as excinfo:
        dwa.plan_apply({"store_id": "s", "page_url": PAGE_URL, "target_date": "10.28"}, now=NOW)
    assert "shipment_ids 不能为空" in str(excinfo.value)


def test_plan_apply_rejects_a_target_week_that_is_already_past():
    with pytest.raises(dwa.DeliveryWindowApplyArgumentError) as excinfo:
        dwa.plan_apply(
            {"store_id": "s", "page_url": PAGE_URL, "shipment_ids": SHIPMENT, "target_date": "2026-01-05"},
            now=dt.datetime(2026, 12, 30, tzinfo=dt.timezone.utc),
        )
    assert "已经过去" in str(excinfo.value)


@pytest.mark.parametrize("raw", [0, -1, 9999, "abc"])
def test_plan_apply_rejects_a_bad_timeout(raw):
    with pytest.raises(dwa.DeliveryWindowApplyArgumentError):
        dwa.plan_apply(
            {"store_id": "s", "page_url": PAGE_URL, "shipment_ids": SHIPMENT, "target_date": "10.28", "timeout_sec": raw},
            now=NOW,
        )


def test_plan_discover_uses_one_seed_and_does_not_require_a_target_date():
    plan = dwa.plan_discover(
        {
            "action": "discover",
            "store_id": "store-1",
            "page_url": PAGE_URL,
            "shipment_ids": SHIPMENT,
        }
    )
    assert plan["action"] == "discover"
    assert plan["seed_shipment_id"] == SHIPMENT
    assert plan["apply"] is False
    assert "target_date" not in plan


def test_plan_discover_rejects_multiple_seeds_and_apply_true():
    with pytest.raises(dwa.DeliveryWindowApplyArgumentError):
        dwa.plan_discover(
            {
                "store_id": "store-1",
                "page_url": PAGE_URL,
                "shipment_ids": [SHIPMENT, SHIPMENT_B],
            }
        )
    with pytest.raises(dwa.DeliveryWindowApplyArgumentError):
        dwa.plan_discover(
            {
                "store_id": "store-1",
                "page_url": PAGE_URL,
                "shipment_ids": SHIPMENT,
                "apply": True,
            }
        )


# --------------------------------------------------------------------------
# HTML reads — the same code the live run uses, over the real fixture.
# --------------------------------------------------------------------------


def test_read_current_window_uses_the_modal_value_not_the_help_text(modal_html):
    read = dwa.read_current_window_text(modal_html)
    assert read["status"] == dwa.WINDOW_PARSED
    assert read["raw"] == CURRENT_WINDOW
    assert read["scope"] == "modal"
    assert read["source"] == "modal:next-sibling-direct"


def test_read_grace_text_falls_back_to_the_info_banner(modal_html):
    # The fixture has no grace-period testid: the sentence lives in a kat-alert.
    grace_text = dwa.read_grace_text(modal_html)
    assert grace_text["text"] == "在 2026年10月11日 之前"
    assert grace_text["source"] == "modal-text"
    grace = dwa.parse_grace_period(grace_text["text"], now=NOW)
    assert grace["status"] == dwa.WINDOW_PARSED
    assert grace["assumed_midnight_utc"] is True


def test_read_legend_selected_text_reads_the_marked_week(modal_html):
    legend = dwa.read_legend_selected_text(modal_html)
    assert legend["status"] == dwa.WINDOW_PARSED
    assert legend["raw"] == CURRENT_WINDOW
    # The swatch class sits on a grandchild, the label on a sibling span.
    assert "item-text" in legend["matched_by"]
    assert "descendant-class" in legend["matched_by"]


def test_inspect_selected_shipment_requires_window_grace_and_edit_link():
    editable = dwa.inspect_selected_shipment(
        _tracking_html(
            shipment_ids=[SHIPMENT],
            selected_index=0,
            window_display=CURRENT_WINDOW,
        ),
        now=NOW,
    )
    assert editable["status"] == "editable"
    assert editable["editable"] is True

    locked = dwa.inspect_selected_shipment(
        _tracking_html(
            shipment_ids=[SHIPMENT],
            selected_index=0,
            window_display=CURRENT_WINDOW,
            grace="在 2026年9月27日, 00:00 UTC 之前",
        ),
        now=NOW,
    )
    assert locked["status"] == "locked"
    assert locked["editable"] is False

    unavailable = dwa.inspect_selected_shipment(
        _tracking_html(
            shipment_ids=[SHIPMENT],
            selected_index=0,
            window_display=CURRENT_WINDOW,
            with_edit_link=False,
        ),
        now=NOW,
    )
    assert unavailable["status"] == "unavailable"
    assert unavailable["editable"] is False


def test_inspect_selected_shipment_does_not_treat_tooltip_copy_as_disabled():
    html = _tracking_html(
        shipment_ids=[SHIPMENT],
        selected_index=0,
        window_display=CURRENT_WINDOW,
    ).replace(
        '<kat-link data-testid="edit-delivery-window-link" label="(编辑时段)"></kat-link>',
        '<kat-tooltip><kat-link data-testid="edit-delivery-window-link" '
        'label="(编辑时段)" slot="trigger"></kat-link>'
        '<span data-testid="edit-delivery-window-tooltip">'
        "送达时段的开始日期不再是未来的日期。因此，无法再编辑该送达时段。"
        "</span></kat-tooltip>",
    )

    inspection = dwa.inspect_selected_shipment(html, now=NOW)

    assert inspection["status"] == "editable"
    assert inspection["editable"] is True
    assert inspection["edit_link_present"] is True
    assert inspection["edit_link"]["blocked"] is False
    assert "无法再编辑" in inspection["edit_link"]["tooltip_text"]


def test_inspect_selected_shipment_honors_real_disabled_attributes():
    html = _tracking_html(
        shipment_ids=[SHIPMENT],
        selected_index=0,
        window_display=CURRENT_WINDOW,
    ).replace(
        'data-testid="edit-delivery-window-link"',
        'data-testid="edit-delivery-window-link" aria-disabled="true"',
    )

    inspection = dwa.inspect_selected_shipment(html, now=NOW)

    assert inspection["status"] == "locked"
    assert inspection["editable"] is False
    assert inspection["edit_link"]["disabled"] is True


def test_read_update_button_state_sees_the_disabled_flag(modal_html):
    button = dwa.read_update_button_state(modal_html)
    assert button == {
        "present": True,
        "disabled": True,
        "label": "确认新的送达时段",
        "aria_disabled": "",
    }


def test_read_update_button_state_accepts_an_enabled_button(modal_html):
    enabled = modal_html.replace(' disabled="true"', "")
    button = dwa.read_update_button_state(enabled)
    assert button["present"] is True
    assert button["disabled"] is False


def test_the_fixture_has_no_tracking_tab_or_sta_link(modal_html):
    # The read must report "nothing there" instead of inventing a match.
    assert dwa.read_tracking_tabs(modal_html) == []
    assert dwa.read_sta_link(modal_html) == {"href": "", "source": ""}


def test_reads_are_quiet_on_empty_html():
    assert dwa.read_current_window_text("")["status"] == dwa.WINDOW_MISSING
    assert dwa.read_legend_selected_text("<div></div>")["status"] == dwa.WINDOW_MISSING
    assert dwa.read_update_button_state("")["present"] is False
    assert dwa.read_grace_text("")["text"] == ""


def test_label_read_ignores_a_help_container_that_mentions_the_label():
    # The tooltip/help block repeats 「送达时段」 in prose; only an element whose
    # *own* text is the label may be used, and its value is the next sibling.
    html = """
    <div data-testid="edit-delivery-window-modal-body">
      <div>送达时段是指预计您的货件送达亚马逊的日历周，送达时段之外送达会有延迟。</div>
      <div>当前送达时段</div>
      <div>2026年10月11日 - 2026年10月17日</div>
    </div>
    """
    read = dwa.read_current_window_text(html)
    assert read["status"] == dwa.WINDOW_PARSED
    assert read["raw"] == CURRENT_WINDOW
    assert read["source"] == "modal:next-sibling-direct"
    # The prose block never even becomes a candidate.
    assert all("送达时段是指" not in candidate["text"] for candidate in read["candidates"])


def test_page_level_window_label_accepts_a_colon_and_a_child_value():
    html = '<div><span>送达时段:</span><span>10月11日 - 2026年10月17日</span></div>'
    read = dwa.read_current_window_text(html)
    assert read["status"] == dwa.WINDOW_PARSED
    assert read["raw"] == "10月11日 - 2026年10月17日"
    assert read["scope"] == "page"


def test_page_level_window_accepts_inline_label_and_value_from_live_dom():
    html = """
    <div>
      送达时段: 2026年10月4日 - 2026年10月10日
      <span data-testid="edit-delivery-window-tooltip">
        送达时段的开始日期不再是未来的日期。因此，无法再编辑该送达时段。
      </span>
    </div>
    """
    read = dwa.read_current_window_text(html)
    assert read["status"] == dwa.WINDOW_PARSED
    assert read["raw"] == "2026年10月4日 - 2026年10月10日"
    assert read["source"] == "page:inline-direct"


def test_read_tracking_tabs_and_tab_selection_markers():
    html = (
        '<div data-testid="shipment-tracking-tab" aria-selected="true">货件 ' + SHIPMENT + "</div>"
        '<div data-testid="shipment-tracking-tab" aria-selected="false" class="kat-tab-active">货件 ' + SHIPMENT_B + "</div>"
    )
    tabs = dwa.read_tracking_tabs(html)
    assert [tab["fba_ids"] for tab in tabs] == [[SHIPMENT], [SHIPMENT_B]]
    assert tabs[0]["selected"] is True
    assert tabs[1]["selected"] is True  # the class also marks it; positives win

    selection = dwa.select_tracking_tab(tabs, SHIPMENT)
    assert selection == {"status": "ok", "reason": "", "index": 0, "tab_count": 2}
    assert dwa.verify_tab_selection(tabs, 0)["status"] == "mismatch"


def test_tracking_tab_classes_distinguish_selected_from_not_selected():
    html = (
        f'<div data-testid="shipment-tracking-tab" class="decision-switch-item selected">{SHIPMENT}</div>'
        f'<div data-testid="shipment-tracking-tab" class="decision-switch-item not-selected clickable">{SHIPMENT_B}</div>'
    )

    tabs = dwa.read_tracking_tabs(html)

    assert [tab["selected"] for tab in tabs] == [True, False]
    assert dwa.verify_tab_selection(tabs, 0)["status"] == "ok"


def test_verify_tab_selection_reports_unknown_when_the_page_says_nothing():
    html = f'<div data-testid="shipment-tracking-tab">货件 {SHIPMENT}</div>'
    tabs = dwa.read_tracking_tabs(html)
    assert tabs[0]["selected"] is None
    verdict = dwa.verify_tab_selection(tabs, 0)
    assert verdict["status"] == "unconfirmed"
    assert "无法证明" in verdict["reason"]


def test_select_tracking_tab_refuses_a_missing_or_ambiguous_match():
    only_other = dwa.read_tracking_tabs(
        f'<div data-testid="shipment-tracking-tab">{SHIPMENT_B}</div>'
    )
    assert dwa.select_tracking_tab(only_other, SHIPMENT)["status"] == "not_found"

    duplicated = dwa.read_tracking_tabs(
        "".join(f'<div data-testid="shipment-tracking-tab">{SHIPMENT}</div>' for _ in range(2))
    )
    ambiguous = dwa.select_tracking_tab(duplicated, SHIPMENT)
    assert ambiguous["status"] == "ambiguous"
    assert "无法确定" in ambiguous["reason"]


def test_read_sta_link_prefers_the_shipment_info_details_area():
    href = "/fba/sendtoamazon?wf=abc"
    html = f'<kat-link href="{href}"></kat-link><div data-testid="shipment-info-details"><kat-link href="{href}"></kat-link></div>'
    link = dwa.read_sta_link(html)
    assert link == {"href": href, "source": "shipment-info-details"}


# --------------------------------------------------------------------------
# Hub rows.
# --------------------------------------------------------------------------


def test_build_hub_rows_groups_columns_and_flags_duplicates():
    cells = [
        {"rowId": SHIPMENT, "column": "shipmentId", "text": SHIPMENT, "cellText": SHIPMENT},
        {"rowId": SHIPMENT, "column": "orderStatus", "text": "正在接收", "cellText": "正在接收", "cellType": "Status", "cellVariant": "default"},
        {"rowId": SHIPMENT, "column": "unitStatus", "text": "600/602", "cellText": "600/602", "cellType": "Fraction", "cellVariant": "bar"},
        {"rowId": SHIPMENT, "column": "deliveryWindow", "text": CURRENT_WINDOW, "cellText": CURRENT_WINDOW},
        {"rowId": SHIPMENT_B, "column": "unitStatus", "text": "602/602", "cellText": "602/602"},
        {"rowId": SHIPMENT, "column": "unitStatus", "text": "600/602", "cellText": "600/602"},
    ]
    hub = dwa.build_hub_rows(cells)
    assert hub["row_count"] == 2
    assert hub["by_id"][SHIPMENT]["unit_status_text"] == "600/602"
    assert hub["by_id"][SHIPMENT]["unit_status_cell_type"] == "Fraction"
    assert hub["by_id"][SHIPMENT]["order_status_text"] == "正在接收"
    assert hub["by_id"][SHIPMENT]["order_status_cell_type"] == "Status"
    assert hub["by_id"][SHIPMENT]["delivery_window_text"] == CURRENT_WINDOW
    assert hub["duplicates"] == [{"rowId": SHIPMENT, "column": "unitStatus"}]


def test_read_hub_cells_wires_the_shadow_dom_reader_with_four_columns():
    driver = SimpleNamespace(scripts=[], cells=[])

    def execute_script(script, *args):
        driver.scripts.append((script, args))
        return driver.cells

    driver.execute_script = execute_script
    dwa.read_hub_cells(driver)
    script, args = driver.scripts[0]
    assert "deepQuerySelectorAll" in script
    assert args[1] == "shipmentId,orderStatus,deliveryWindow,unitStatus"
    assert args[2] == dwa.PRIMARY_ATOM_SELECTOR


# --------------------------------------------------------------------------
# Scripted-driver harness.
# --------------------------------------------------------------------------


def _hub_cells(rows):
    cells = []
    for item in rows:
        row_id, unit, window, *status_values = item
        order_status = status_values[0] if status_values else "已发货"
        cells.append({"rowId": row_id, "column": "shipmentId", "text": row_id, "cellText": row_id, "cellType": "Text", "cellVariant": ""})
        if order_status is not None:
            cells.append({"rowId": row_id, "column": "orderStatus", "text": order_status, "cellText": order_status, "cellType": "Status", "cellVariant": "default"})
        cells.append({"rowId": row_id, "column": "unitStatus", "text": unit, "cellText": f"已入库 {unit}", "cellType": "Fraction", "cellVariant": "bar"})
        cells.append({"rowId": row_id, "column": "deliveryWindow", "text": window, "cellText": window, "cellType": "Text", "cellVariant": ""})
    return cells


def _detail_html(shipment_id: str) -> str:
    return (
        f'<div data-testid="shipment-info-details">'
        f'<kat-link href="/fba/sendtoamazon?wf={shipment_id}">追踪详情</kat-link>'
        f"</div>"
    )


def _tracking_html(
    *,
    shipment_ids,
    selected_index,
    window_display,
    markers=True,
    grace="在 2026年10月11日, 00:00 UTC 之前",
    with_edit_link=True,
) -> str:
    tabs = []
    for index, shipment_id in enumerate(shipment_ids):
        marker = ""
        if markers:
            marker = ' aria-selected="true"' if index == selected_index else ' aria-selected="false"'
        tabs.append(f'<div data-testid="shipment-tracking-tab"{marker}>货件 {shipment_id}</div>')
    edit_link = (
        f'<kat-link data-testid="edit-delivery-window-link" label="(编辑时段)"></kat-link>'
        if with_edit_link
        else ""
    )
    return (
        '<div data-testid="tracking-tabs">' + "".join(tabs) + "</div>"
        f'<span data-testid="edit-delivery-window-grace-period">{grace}</span>'
        f'<div><span>送达时段:</span><span>{window_display}</span></div>'
        + edit_link
    )


def _collapsed_tracking_html() -> str:
    return (
        '<section><h3>第 1 步：已确认要发送的库存</h3>'
        '<kat-link data-testid="step-view-link">查看</kat-link></section>'
        '<section><h3>最后一步：追踪详情</h3>'
        '<kat-link data-testid="step-view-link">查看</kat-link></section>'
    )


def _modal_html(*, current_display, legend_display, button_disabled=True) -> str:
    disabled = ' disabled="true"' if button_disabled else ""
    return (
        '<article data-testid="sta-modal"><kat-modal visible="true" data-testid="modal-overlay">'
        '<div data-testid="edit-delivery-window-modal-body">'
        '<kat-alert persistent="true" variant="info" size="small">'
        '<span slot="header">在 2026年10月11日 之前可编辑</span></kat-alert>'
        '<div class="padding-top-20px bold max-width-50-percent">当前送达时段</div>'
        f"<div>{current_display}</div>"
        '<div class="ac-delivery-window-modal-calendar">'
        '<kat-calendar data-testid="edit-delivery-window-calendar" locale="zh-CN"></kat-calendar>'
        "</div>"
        '<div class="ac-delivery-window-modal-legend">'
        '<div data-testid="delivery-window-modal-legend-item">'
        '<div class="flex flex-row">'
        '<div class="ac-delivery-window-modal-legend-item-color ac-delivery-window-modal-legend-selected"></div>'
        "<span>已选择</span></div>"
        f'<div class="color-tarpon padding-left-20px">{legend_display}</div>'
        "</div>"
        '<div data-testid="delivery-window-modal-legend-item">'
        '<div class="flex flex-row">'
        '<div class="ac-delivery-window-modal-legend-item-color ac-delivery-window-modal-legend-unavailable"></div>'
        "<span>配送时段不可用</span></div></div>"
        "</div>"
        "</div>"
        '<div data-testid="modal-footer"><div data-testid="edit-delivery-window-modal-footer">'
        '<kat-button variant="secondary" data-testid="edit-delivery-window-modal-cancel-button" label="取消"></kat-button>'
        f'<kat-button{disabled} label="确认新的送达时段" data-testid="edit-delivery-window-modal-update-button" variant="primary"></kat-button>'
        "</div></div></kat-modal></article>"
    )


class _ScriptedDriver:
    """Fake Selenium driver: serves HTML per stage and answers the injected JS.

    Every ``execute_script`` call is recorded, so a test can assert not only
    what was clicked but *what was never clicked* (the stop gates).
    """

    def __init__(self, *, hub_cells, shipment_ids, markers=True, target_window=TARGET_WINDOW):
        self.hub_cells = list(hub_cells)
        self.shipment_ids = list(shipment_ids)
        self.markers = markers
        self.target_window = target_window
        self.state = {
            "url": "",
            "selected_index": 0,
            "modal_open": False,
            "day_clicked": False,
            "applied": False,
            "month_label": "2026年10月",
            "day_count": 31,
            "edit_link_clickable": True,
            "tab_click_confirms": True,
            "confirm_effect": True,
            "keep_button_disabled": False,
            "month_stuck": False,
            "day_clickable": True,
            "grace": "在 2026年10月11日, 00:00 UTC 之前",
            "current_window": CURRENT_WINDOW,
            "with_edit_link": True,
            "tracking_expanded": True,
            "tracking_detail_delay_reads": 0,
        }
        self.shipment_states = {}
        self.opened: list[str] = []
        self.clicks: list[tuple] = []
        self.scripts: list[tuple] = []

    # -- Selenium surface -------------------------------------------------

    def get(self, url: str) -> None:
        self.opened.append(url)
        self.state["url"] = url

    @property
    def current_url(self) -> str:
        return self.state["url"]

    @property
    def current_window_handle(self) -> str:
        return self.state.get("window_handle", "amazon-tab")

    @property
    def page_source(self) -> str:
        url = self.state["url"]
        if "/contents" in url:
            return _detail_html(url.split("/summary/")[1].split("/")[0])
        if "sendtoamazon" in url:
            if not self.state["tracking_expanded"]:
                return _collapsed_tracking_html()
            if self.state["tracking_detail_delay_reads"] > 0:
                self.state["tracking_detail_delay_reads"] -= 1
                return _tracking_html(
                    shipment_ids=self.shipment_ids,
                    selected_index=self.state["selected_index"],
                    window_display="",
                    markers=self.markers,
                    grace="",
                    with_edit_link=False,
                )
            selected_id = self.shipment_ids[self.state["selected_index"]]
            selected_state = self.shipment_states.get(selected_id, {})
            current_window = selected_state.get("current_window", self.state["current_window"])
            window = self.target_window if self.state["applied"] else current_window
            html = _tracking_html(
                shipment_ids=self.shipment_ids,
                selected_index=self.state["selected_index"],
                window_display=window,
                markers=self.markers,
                grace=selected_state.get("grace", self.state["grace"]),
                with_edit_link=selected_state.get("with_edit_link", self.state["with_edit_link"]),
            )
            if self.state["modal_open"]:
                legend = self.target_window if self.state["day_clicked"] else self.state["current_window"]
                html += _modal_html(
                    current_display=self.state["current_window"],
                    legend_display=legend,
                    button_disabled=not self.state["day_clicked"] or self.state["keep_button_disabled"],
                )
            return html
        return ""

    def execute_script(self, script: str, *args):
        self.scripts.append((script, args))
        selector = args[0] if args else ""

        if "cellSelector" in script:
            return list(self.hub_cells)
        if ".cal-month" in script:
            return self.state["month_label"]
        if "return -1" in script:
            return self.state["day_count"]
        if "labelPrefix" in script:
            self.clicks.append((selector, args[1]))
            if not self.state["day_clickable"]:
                return False
            self.state["day_clicked"] = True
            return True
        if "calendar-next-month" in script or "calendar-prev-month" in script:
            self.clicks.append((selector, args[1]))
            if self.state["month_stuck"]:
                return True
            year, month = (int(part) for part in self.state["month_label"].replace("年", " ").replace("月", "").split())
            month = month + 1 if args[1] == "next" else month - 1
            if month == 13:
                year, month = year + 1, 1
            if month == 0:
                year, month = year - 1, 12
            self.state["month_label"] = f"{year}年{month}月"
            return True
        if "Boolean(" in script:
            if selector == dwa.MODAL_BODY_SELECTOR:
                return self.state["modal_open"]
            if selector == dwa.SHIPMENT_INFO_DETAILS_SELECTOR:
                return True
            return False
        # NB: the nth-click script also uses Array.from, so clicks come first.
        if "dispatchClick" in script:
            self.clicks.append((selector, args[1] if len(args) > 1 else None))
            if selector == dwa.EDIT_LINK_SELECTOR:
                if not self.state["edit_link_clickable"]:
                    return False
                self.state["modal_open"] = True
                return True
            if selector == dwa.CANCEL_BUTTON_SELECTOR:
                self.state["modal_open"] = False
                return True
            if selector == dwa.UPDATE_BUTTON_SELECTOR:
                if self.state["confirm_effect"]:
                    self.state["applied"] = True
                    self.state["modal_open"] = False
                return True
            if selector == dwa.STEP_VIEW_LINK_SELECTOR:
                self.state["tracking_expanded"] = True
                return True
            if selector == dwa.TRACKING_TAB_SELECTOR:
                if self.state["tab_click_confirms"]:
                    self.state["selected_index"] = int(args[1])
                return True
            return True
        if "Array.from" in script:
            if selector == dwa.TRACKING_TAB_SELECTOR:
                return (
                    len(self.shipment_ids)
                    if "sendtoamazon" in self.state["url"] and self.state["tracking_expanded"]
                    else 0
                )
            if selector == dwa.STEP_VIEW_LINK_SELECTOR:
                return (
                    2
                    if "sendtoamazon" in self.state["url"] and not self.state["tracking_expanded"]
                    else 0
                )
            return 0
        return None

    # -- assertions helpers ------------------------------------------------

    def clicked(self, selector: str) -> bool:
        return any(click[0] == selector for click in self.clicks)


def _plan(**overrides):
    arguments = {
        "store_id": "store-1",
        "page_url": PAGE_URL,
        "shipment_ids": [SHIPMENT],
        "target_date": TARGET_DATE_INPUT,
        # Shortest legal page timeout: with _SLEEP stubbed this keeps the
        # "never appears" branches quick without skipping them.
        "timeout_sec": 1,
    }
    arguments.update(overrides)
    if arguments.get("apply"):
        arguments.setdefault("dry_run_id", "a" * 32)
    return dwa.plan_apply(arguments, now=NOW)


def _seed_preparation(driver, plan, tmp_path):
    """An earlier completed dry-run, independent of the fault injected now."""
    entries = []
    for shipment_id in plan["shipment_ids"]:
        selected_state = driver.shipment_states.get(shipment_id, {})
        raw = selected_state.get("current_window", driver.state["current_window"])
        window = dwa.dwl.parse_delivery_window(raw)
        if window["status"] != "parsed":
            window = dwa.dwl.parse_delivery_window(CURRENT_WINDOW)
        entries.append({"fba_shipment_id": shipment_id, "status": "dry_run_ready", "observations": [{
            "store_id": plan["store_id"], "shipment_id": shipment_id,
            "window_handle": "amazon-tab", "page_url": f"{ORIGIN}/fba/sendtoamazon?wf={shipment_id}",
            "workflow_id": shipment_id, "current_window_read": {"window": window},
            "grace": dwa.parse_grace_period("在 2026年10月11日, 00:00 UTC 之前", now=NOW),
        }]})
    return dwa.preparation.create(tmp_path, {**plan, "apply": False}, entries)


def _run(driver, plan, tmp_path):
    if plan["apply"]:
        plan = {**plan, "dry_run_id": _seed_preparation(driver, plan, tmp_path)}
    return dwa._run_shipments(driver, plan, output_dir=tmp_path, now=NOW)


def _entry(result, index=0):
    return result["data"]["shipments"][index]


# --------------------------------------------------------------------------
# Orchestration: the happy path.
# --------------------------------------------------------------------------


def test_apply_walks_the_page_and_reads_the_new_window_back(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    result = _run(driver, _plan(apply=True), tmp_path)

    assert result["success"] is True and result["finished"] is True
    entry = _entry(result)
    assert entry["status"] == "applied"
    assert entry["current_window"]["raw"] == CURRENT_WINDOW
    assert entry["applied_window"]["start_date"] == "2026-10-25"
    assert entry["applied_window"]["end_date"] == "2026-10-31"
    assert entry["grace"]["editable"] is True

    assert driver.opened[0] == PAGE_URL
    assert any("/fba/inbound-shipment/summary/FBA19NDSQ2SK/contents" in url for url in driver.opened)
    assert any("sendtoamazon" in url for url in driver.opened)
    assert driver.clicked(dwa.EDIT_LINK_SELECTOR)
    assert (dwa.CALENDAR_SELECTOR, "2026年10月28日") in driver.clicks
    assert driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)


def test_apply_reuses_an_already_open_hub_route_before_revalidation(tmp_path):
    driver = _ScriptedDriver(
        hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]),
        shipment_ids=[SHIPMENT],
    )
    driver.state["url"] = f"{PAGE_URL}&ref=sc_shipments"

    result = _run(driver, _plan(apply=False), tmp_path)

    assert result["success"] is True
    assert PAGE_URL not in driver.opened
    assert driver.opened[0].endswith(f"/{SHIPMENT}/contents")
    hub_steps = {item["step"]: item["detail"] for item in result["data"]["steps"]}
    assert "action=reused" in hub_steps["列表页定位"]


def test_dry_run_stops_before_the_calendar_and_never_confirms(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    result = _run(driver, _plan(apply=False), tmp_path)

    assert result["success"] is True
    entry = _entry(result)
    assert entry["status"] == "dry_run_ready"
    assert entry["dry_run_cancel_clicked"] is True
    # The evidence that this is a dry run is what was *not* clicked.
    assert not driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)
    assert all(click[0] != dwa.CALENDAR_SELECTOR for click in driver.clicks)
    assert not any("labelPrefix" in script for script, _ in driver.scripts)
    assert driver.clicked(dwa.CANCEL_BUTTON_SELECTOR)


def test_tracking_page_expands_the_final_step_before_selecting_the_tab(tmp_path):
    driver = _ScriptedDriver(
        hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]),
        shipment_ids=[SHIPMENT],
    )
    driver.state["tracking_expanded"] = False

    result = _run(driver, _plan(apply=False), tmp_path)

    assert result["success"] is True
    assert _entry(result)["status"] == "dry_run_ready"
    assert driver.clicked(dwa.STEP_VIEW_LINK_SELECTOR)
    steps = [item["step"] for item in _entry(result)["steps"]]
    assert "E2a 展开最后一步" in steps


def test_tracking_page_waits_for_detail_fields_after_tabs_appear(tmp_path, monkeypatch):
    driver = _ScriptedDriver(
        hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]),
        shipment_ids=[SHIPMENT],
    )
    driver.state["tracking_detail_delay_reads"] = 2
    monkeypatch.setattr(dwa, "LEGEND_TIMEOUT_SECONDS", 1)

    result = _run(driver, _plan(apply=False), tmp_path)

    assert result["success"] is True
    assert _entry(result)["status"] == "dry_run_ready"
    steps = {item["step"]: item["detail"] for item in _entry(result)["steps"]}
    assert "ready=True" in steps["E2a 追踪详情加载"]


@pytest.mark.parametrize("visible_id", [SHIPMENT_B, SHIPMENT + "U000001"])
def test_discovery_stops_before_details_when_current_store_page_has_no_exact_fba(tmp_path, visible_id):
    driver = _ScriptedDriver(
        hub_cells=_hub_cells([(visible_id, "0/172", CURRENT_WINDOW)]),
        shipment_ids=[SHIPMENT],
    )
    plan = dwa.plan_discover({"action": "discover", "store_id": "store-1", "page_url": PAGE_URL,
                             "shipment_ids": SHIPMENT, "timeout_sec": 1})

    with pytest.raises(dwa._HardFailure) as caught:
        dwa._run_discovery(driver, plan, output_dir=tmp_path, now=NOW)

    assert caught.value.code == "E1"
    assert SHIPMENT in caught.value.message and visible_id in caught.value.message
    assert "不在当前列表页" in caught.value.message
    assert driver.opened == [PAGE_URL] and driver.clicks == []
    assert not list(tmp_path.iterdir())


def test_discovery_rejects_ambiguous_target_rows_before_opening_details(tmp_path):
    driver = _ScriptedDriver(
        hub_cells=_hub_cells([(SHIPMENT, "0/172", CURRENT_WINDOW), (SHIPMENT, "0/172", TARGET_WINDOW)]),
        shipment_ids=[SHIPMENT],
    )
    plan = dwa.plan_discover({"action": "discover", "store_id": "store-1", "page_url": PAGE_URL,
                             "shipment_ids": SHIPMENT, "timeout_sec": 1})

    with pytest.raises(dwa._HardFailure) as caught:
        dwa._run_discovery(driver, plan, output_dir=tmp_path, now=NOW)

    assert caught.value.code == "E1"
    assert SHIPMENT in caught.value.message and "orderStatus" in caught.value.message
    assert driver.opened == [PAGE_URL] and driver.clicks == []
    assert not list(tmp_path.iterdir())


def test_discovery_rejects_a_workflow_that_does_not_contain_the_seed(tmp_path):
    driver = _ScriptedDriver(
        hub_cells=_hub_cells([(SHIPMENT, "0/172", CURRENT_WINDOW), (SHIPMENT_B, "0/172", CURRENT_WINDOW)]),
        shipment_ids=[SHIPMENT_B],
    )
    plan = dwa.plan_discover({"action": "discover", "store_id": "store-1", "page_url": PAGE_URL,
                             "shipment_ids": SHIPMENT, "timeout_sec": 1})

    with pytest.raises(dwa._HardFailure) as caught:
        dwa._run_discovery(driver, plan, output_dir=tmp_path, now=NOW)

    assert caught.value.code == "E2"
    assert SHIPMENT in caught.value.message and SHIPMENT_B in caught.value.message
    assert driver.clicks == [] and driver.state["applied"] is False
    assert not list(tmp_path.iterdir())


@pytest.mark.parametrize("tab_ids", [
    [SHIPMENT, SHIPMENT_B, SHIPMENT_C],
    [SHIPMENT_B, SHIPMENT, SHIPMENT_C],
    [SHIPMENT_B, SHIPMENT_C, SHIPMENT],
])
def test_discovery_keeps_each_window_with_its_fba_and_returns_to_the_exact_seed(tmp_path, tab_ids):
    windows = {
        SHIPMENT: "2026年11月8日 - 2026年11月14日",
        SHIPMENT_B: CURRENT_WINDOW,
        SHIPMENT_C: TARGET_WINDOW,
    }
    driver = _ScriptedDriver(
        hub_cells=_hub_cells([(shipment, "0/172", windows[shipment]) for shipment in tab_ids]),
        shipment_ids=tab_ids,
    )
    driver.shipment_states = {shipment: {"current_window": window} for shipment, window in windows.items()}
    plan = dwa.plan_discover({"action": "discover", "store_id": "store-1", "page_url": PAGE_URL,
                             "shipment_ids": SHIPMENT, "timeout_sec": 1})

    result = dwa._run_discovery(driver, plan, output_dir=tmp_path, now=NOW)

    assert result["success"] is True and result["finished"] is True
    options = result["data"]["operator_options"]
    assert [item["fba_shipment_id"] for item in options] == tab_ids
    for index, item in enumerate(options):
        assert item["selection_number"] == index + 1
        assert item["current_window"]["raw"] == windows[item["fba_shipment_id"]]
    target = next(item for item in options if item["fba_shipment_id"] == SHIPMENT)
    assert target["selection_number"] == tab_ids.index(SHIPMENT) + 1
    assert driver.state["selected_index"] == tab_ids.index(SHIPMENT)
    assert dwa.read_current_window_text(driver.page_source)["raw"] == windows[SHIPMENT]
    assert not driver.clicked(dwa.EDIT_LINK_SELECTOR)
    assert not driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)
    assert all(click[0] != dwa.CALENDAR_SELECTOR for click in driver.clicks)


def test_discovery_does_not_report_completion_when_return_to_seed_cannot_be_confirmed(tmp_path, monkeypatch):
    driver = _ScriptedDriver(
        hub_cells=_hub_cells([(SHIPMENT, "0/172", CURRENT_WINDOW), (SHIPMENT_B, "0/172", TARGET_WINDOW)]),
        shipment_ids=[SHIPMENT, SHIPMENT_B],
    )
    execute = driver.execute_script
    def fail_return(script, *args):
        if "dispatchClick" in script and args[:2] == (dwa.TRACKING_TAB_SELECTOR, 0):
            driver.state["tab_click_confirms"] = False
        return execute(script, *args)
    monkeypatch.setattr(driver, "execute_script", fail_return)
    plan = dwa.plan_discover({"action": "discover", "store_id": "store-1", "page_url": PAGE_URL,
                             "shipment_ids": SHIPMENT, "timeout_sec": 1})

    with pytest.raises(dwa._HardFailure) as caught:
        dwa._run_discovery(driver, plan, output_dir=tmp_path, now=NOW)

    assert caught.value.code == "E2" and SHIPMENT in caught.value.message
    assert "仍无法确认" in caught.value.message
    assert driver.state["selected_index"] == 1 and driver.state["applied"] is False
    assert not driver.clicked(dwa.EDIT_LINK_SELECTOR)
    assert not list(tmp_path.iterdir())


def test_discovery_reads_every_dynamic_tab_and_never_opens_the_editor(tmp_path):
    driver = _ScriptedDriver(
        hub_cells=_hub_cells(
            [
                (SHIPMENT, "600/602", CURRENT_WINDOW),
                (SHIPMENT_B, "0/285", CURRENT_WINDOW),
                (SHIPMENT_C, "0/477", CURRENT_WINDOW),
            ]
        ),
        shipment_ids=[SHIPMENT, SHIPMENT_B, SHIPMENT_C],
    )
    driver.shipment_states = {
        SHIPMENT_B: {"with_edit_link": False},
        SHIPMENT_C: {"grace": "在 2026年9月27日, 00:00 UTC 之前"},
    }
    plan = dwa.plan_discover(
        {
            "action": "discover",
            "store_id": "store-1",
            "page_url": PAGE_URL,
            "shipment_ids": SHIPMENT,
            "timeout_sec": 1,
        }
    )

    result = dwa._run_discovery(driver, plan, output_dir=tmp_path, now=NOW)

    assert result["success"] is True and result["finished"] is True
    assert result["data"]["shipment_count"] == 3
    assert result["data"]["editable_shipment_ids"] == [SHIPMENT]
    assert result["data"]["page_editable_shipment_ids"] == [SHIPMENT]
    assert result["data"]["ineligible_shipment_ids"] == []
    assert [item["label"] for item in result["data"]["operator_options"]] == [
        "货件编号 1",
        "货件编号 2",
        "货件编号 3",
    ]
    assert [item["selection_number"] for item in result["data"]["operator_options"]] == [
        1,
        2,
        3,
    ]
    assert result["data"]["operator_options"][0]["selectable"] is True
    assert [item["status"] for item in result["data"]["shipments"]] == [
        "editable",
        "unavailable",
        "locked",
    ]
    assert not driver.clicked(dwa.EDIT_LINK_SELECTOR)
    assert not driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)
    assert all(click[0] != dwa.CALENDAR_SELECTOR for click in driver.clicks)
    artifact = Path(result["file_path"][0]["value"])
    assert result["file_path"][0]["key"] == "delivery_window_discover"
    assert artifact.exists()


def test_discovery_inspects_receiving_child_but_keeps_it_ineligible(tmp_path):
    driver = _ScriptedDriver(
        hub_cells=_hub_cells(
            [
                (SHIPMENT, "0/285", CURRENT_WINDOW, "已发货"),
                (SHIPMENT_B, "285/285", CURRENT_WINDOW, "正在接收"),
            ]
        ),
        shipment_ids=[SHIPMENT, SHIPMENT_B],
    )
    plan = dwa.plan_discover(
        {
            "action": "discover",
            "store_id": "store-1",
            "page_url": PAGE_URL,
            "shipment_ids": SHIPMENT,
            "timeout_sec": 1,
        }
    )

    result = dwa._run_discovery(driver, plan, output_dir=tmp_path, now=NOW)

    assert result["success"] is True and result["finished"] is True
    assert result["data"]["editable_shipment_ids"] == [SHIPMENT]
    assert result["data"]["page_editable_shipment_ids"] == [SHIPMENT, SHIPMENT_B]
    assert result["data"]["ineligible_shipment_ids"] == [SHIPMENT_B]
    receiving = result["data"]["shipments"][1]
    assert receiving["operator_label"] == "货件编号 2"
    assert receiving["status"] == "ineligible"
    assert receiving["editable"] is False
    assert receiving["page_editable"] is True
    assert receiving["business_eligible"] is False
    assert receiving["selectable"] is False
    assert receiving["order_status"] == "正在接收"
    assert receiving["unit_status"]["received"] == 285
    assert receiving["unit_status"]["expected"] == 285
    assert "当前仅允许: 已发货" in receiving["reason"]
    assert (dwa.TRACKING_TAB_SELECTOR, 1) in driver.clicks


def test_discovery_fails_closed_when_child_has_no_hub_status(tmp_path):
    driver = _ScriptedDriver(
        hub_cells=_hub_cells([(SHIPMENT, "0/285", CURRENT_WINDOW, "已发货")]),
        shipment_ids=[SHIPMENT, SHIPMENT_B],
    )
    plan = dwa.plan_discover(
        {
            "action": "discover",
            "store_id": "store-1",
            "page_url": PAGE_URL,
            "shipment_ids": SHIPMENT,
            "timeout_sec": 1,
        }
    )

    result = dwa._run_discovery(driver, plan, output_dir=tmp_path, now=NOW)

    assert result["success"] is True and result["finished"] is False
    assert result["data"]["editable_shipment_ids"] == [SHIPMENT]
    assert result["data"]["unknown_shipment_ids"] == [SHIPMENT_B]
    missing = result["data"]["shipments"][1]
    assert missing["failure_code"] == "E1"
    assert missing["editable"] is None
    assert missing["page_editable"] is True
    assert missing["business_eligible"] is None
    assert missing["selectable"] is False
    assert "无法确认 orderStatus" in missing["reason"]
    assert (dwa.TRACKING_TAB_SELECTOR, 1) in driver.clicks


def test_already_target_week_short_circuits_without_touching_the_modal(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", TARGET_WINDOW)]), shipment_ids=[SHIPMENT])
    driver.state["current_window"] = TARGET_WINDOW
    result = _run(driver, _plan(apply=True), tmp_path)

    assert result["success"] is True
    assert _entry(result)["status"] == "already_target"
    assert not driver.clicked(dwa.EDIT_LINK_SELECTOR)


def test_the_artifact_records_the_steps_and_the_windows(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    result = _run(driver, _plan(apply=True), tmp_path)

    artifact = Path(result["file_path"][0]["value"])
    assert result["file_path"][0]["key"] == "delivery_window_apply"
    assert artifact.exists()
    payload = json.loads(artifact.read_text(encoding="utf-8"))
    assert payload["target_window"]["display"] == TARGET_WINDOW
    assert payload["shipments"][0]["status"] == "applied"
    assert payload["hub"]["rows"][0]["unit_status_text"] == "600/602"
    assert payload["hub"]["rows"][0]["order_status_text"] == "已发货"
    steps = [item["step"] for item in payload["shipments"][0]["steps"]]
    assert "E1 列表状态校验" in steps
    assert "E7 已点目标日" in steps


# --------------------------------------------------------------------------
# Orchestration: every stop gate.
# --------------------------------------------------------------------------


@pytest.mark.parametrize("order_status", ["正在接收", "已完成", "在途"])
def test_non_shipped_status_fails_e1_without_touching_the_detail_page(
    tmp_path, order_status
):
    driver = _ScriptedDriver(
        hub_cells=_hub_cells(
            [(SHIPMENT, "0/172", CURRENT_WINDOW, order_status)]
        ),
        shipment_ids=[SHIPMENT],
    )
    result = _run(driver, _plan(apply=False), tmp_path)

    entry = _entry(result)
    assert entry["failure_code"] == "E1"
    assert f"orderStatus='{order_status}'" in entry["failure_detail"]
    assert "当前仅允许: 已发货" in entry["failure_detail"]
    assert driver.opened == [PAGE_URL]


def test_shipped_status_allows_zero_received_units_to_continue(tmp_path):
    driver = _ScriptedDriver(
        hub_cells=_hub_cells(
            [(SHIPMENT, "0/172", CURRENT_WINDOW, "已发货")]
        ),
        shipment_ids=[SHIPMENT],
    )
    result = _run(driver, _plan(apply=False), tmp_path)

    entry = _entry(result)
    assert entry["status"] == "dry_run_ready"
    assert entry["order_status"] == "已发货"
    assert entry["unit_status"]["received"] == 0
    assert entry["unit_status"]["expected"] == 172
    assert any("/fba/inbound-shipment/summary/" in url for url in driver.opened)


def test_unreadable_unit_status_is_diagnostic_and_does_not_block_tracking(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "0/0", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    result = _run(driver, _plan(apply=False), tmp_path)

    entry = _entry(result)
    assert entry["status"] == "dry_run_ready"
    assert entry["unit_status"]["status"] != dwa.WINDOW_PARSED


def test_missing_order_status_fails_e1_without_touching_the_detail_page(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "602/602", CURRENT_WINDOW, None)]), shipment_ids=[SHIPMENT])
    result = _run(driver, _plan(apply=False), tmp_path)

    entry = _entry(result)
    assert entry["failure_code"] == "E1"
    assert "orderStatus 读不出来" in entry["failure_detail"]
    assert driver.opened == [PAGE_URL]


def test_shipment_missing_from_the_hub_page_fails_e1(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT_B, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    result = _run(driver, _plan(apply=True), tmp_path)

    entry = _entry(result)
    assert entry["failure_code"] == "E1"
    assert "不在当前列表页" in entry["failure_detail"]


def test_empty_hub_read_fails_e1(tmp_path):
    driver = _ScriptedDriver(hub_cells=[], shipment_ids=[SHIPMENT])
    result = _run(driver, _plan(apply=True), tmp_path)

    # The list page itself failed, so no shipment was touched at all.
    assert result["success"] is False and result["finished"] is False
    assert result["exception"].startswith("E1: ")
    assert "没有读到任何行" in result["exception"]
    entries = result["data"]["shipments"]
    assert [item["status"] for item in entries] == ["not_attempted"]
    assert "列表页阶段失败" in entries[0]["failure_detail"]
    assert driver.opened == [PAGE_URL]


def test_grace_period_already_passed_fails_e3_before_the_modal(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    driver.state["grace"] = "在 2026年9月27日, 00:00 UTC 之前"
    result = _run(driver, _plan(apply=True), tmp_path)

    entry = _entry(result)
    assert entry["failure_code"] == "E3"
    assert "已锁定" in entry["failure_detail"]
    assert not driver.clicked(dwa.EDIT_LINK_SELECTOR)


def test_unreadable_grace_period_fails_e3(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    driver.state["grace"] = "截止时间待定"
    result = _run(driver, _plan(apply=True), tmp_path)

    assert _entry(result)["failure_code"] == "E3"


def test_unreadable_current_window_fails_e9(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    driver.state["current_window"] = "待定"
    result = _run(driver, _plan(apply=True), tmp_path)

    entry = _entry(result)
    assert entry["failure_code"] == "E9"
    assert "读不到当前送达时段" in entry["failure_detail"]
    assert not driver.clicked(dwa.EDIT_LINK_SELECTOR)


def test_tab_without_any_selection_marker_fails_e2(tmp_path):
    driver = _ScriptedDriver(
        hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]),
        shipment_ids=[SHIPMENT],
        markers=False,
    )
    result = _run(driver, _plan(apply=True), tmp_path)

    entry = _entry(result)
    assert entry["failure_code"] == "E2"
    assert "无法确认" in entry["failure_detail"] or "无法证明" in entry["failure_detail"]


def test_tab_that_refuses_to_become_selected_fails_e2(tmp_path):
    driver = _ScriptedDriver(
        hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]),
        shipment_ids=[SHIPMENT, SHIPMENT_B],
    )
    driver.state["selected_index"] = 1  # the other shipment is the selected tab
    driver.state["tab_click_confirms"] = False
    result = _run(driver, _plan(apply=True), tmp_path)

    entry = _entry(result)
    assert entry["failure_code"] == "E2"
    assert driver.clicked(dwa.TRACKING_TAB_SELECTOR)


def test_tab_that_belongs_to_another_shipment_fails_e2(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT_B])
    result = _run(driver, _plan(apply=True), tmp_path)

    entry = _entry(result)
    assert entry["failure_code"] == "E2"
    assert "没有找到" in entry["failure_detail"]


def test_unclickable_edit_link_fails_e4(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    driver.state["edit_link_clickable"] = False
    result = _run(driver, _plan(apply=True), tmp_path)

    entry = _entry(result)
    assert entry["failure_code"] == "E4"
    assert "找不到或点不动" in entry["failure_detail"]


def test_modal_that_never_appears_fails_e4(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    # The edit click reports success, but the modal never opens.
    original = driver.execute_script

    def dropping_modal(script, *args):
        result = original(script, *args)
        if "dispatchClick" in script and args and args[0] == dwa.EDIT_LINK_SELECTOR:
            driver.state["modal_open"] = False  # ...but nothing opens
        return result

    driver.execute_script = dropping_modal
    result = _run(driver, _plan(apply=True), tmp_path)

    entry = _entry(result)
    assert entry["failure_code"] == "E4"
    assert "没等到弹窗" in entry["failure_detail"]


def test_legend_that_still_shows_another_week_fails_e5_before_confirming(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    driver.state["day_clicked"] = False
    original = driver.execute_script

    def ignore_day_click(script, *args):
        result = original(script, *args)
        if "labelPrefix" in script:
            driver.state["day_clicked"] = False  # the calendar never registers it
        return result

    driver.execute_script = ignore_day_click
    result = _run(driver, _plan(apply=True), tmp_path)

    entry = _entry(result)
    assert entry["failure_code"] == "E5"
    assert not driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)


def test_confirm_button_still_disabled_fails_e6(tmp_path):
    # The legend already shows the target week (E5 would pass) but Amazon keeps
    # the button disabled -> stop, and never pretend the change was submitted.
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    driver.state["keep_button_disabled"] = True
    result = _run(driver, _plan(apply=True), tmp_path)

    entry = _entry(result)
    assert entry["failure_code"] == "E6"
    assert "确认按钮" in entry["failure_detail"] and "disabled" in entry["failure_detail"]
    assert not driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)


def test_readback_that_never_changes_reports_e8(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    driver.state["confirm_effect"] = False
    driver.state["day_clicked"] = True  # the legend looks right before confirming
    result = _run(driver, _plan(apply=True), tmp_path)

    entry = _entry(result)
    assert entry["failure_code"] == "E8"
    assert entry["status"] == "pending_readback"
    assert entry["readback_required"] is True
    assert "不是目标周" in entry["failure_detail"]
    assert driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)


def test_calendar_month_that_will_not_advance_fails_e7(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    driver.state["month_label"] = "2026年9月"  # must page forward, but paging is dead
    driver.state["month_stuck"] = True
    result = _run(driver, _plan(apply=True), tmp_path)

    entry = _entry(result)
    assert entry["failure_code"] == "E7"
    assert "月份没变" in entry["failure_detail"]
    assert not driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)


def test_calendar_without_day_cells_fails_e7(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    driver.state["day_count"] = 0
    driver.state["month_label"] = "2026年10月"
    result = _run(driver, _plan(apply=True), tmp_path)

    entry = _entry(result)
    assert entry["failure_code"] == "E7"
    assert "读不到日期格子" in entry["failure_detail"]


def test_unclickable_day_cell_fails_e7(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    driver.state["day_clickable"] = False
    result = _run(driver, _plan(apply=True), tmp_path)

    entry = _entry(result)
    assert entry["failure_code"] == "E7"
    assert "点不到 2026-10-28" in entry["failure_detail"]


def test_other_shipments_are_not_attempted_after_a_failure(tmp_path):
    driver = _ScriptedDriver(
        hub_cells=_hub_cells(
            [(SHIPMENT, "600/602", CURRENT_WINDOW), (SHIPMENT_B, "602/602", CURRENT_WINDOW, None), (SHIPMENT_C, "600/602", CURRENT_WINDOW)]
        ),
        shipment_ids=[SHIPMENT, SHIPMENT_B, SHIPMENT_C],
    )
    result = _run(driver, _plan(apply=False, shipment_ids=[SHIPMENT, SHIPMENT_B, SHIPMENT_C]), tmp_path)

    statuses = [item["status"] for item in result["data"]["shipments"]]
    assert statuses == ["dry_run_ready", "failed", "not_attempted"]
    assert _entry(result, 1)["failure_code"] == "E1"
    assert "not_attempted=1" in result["notice"]


def test_calendar_paging_walks_forward_to_the_target_month(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "600/602", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    driver.state["month_label"] = "2026年8月"
    result = _run(driver, _plan(apply=True), tmp_path)

    assert result["success"] is True
    steps = [item["step"] for item in _entry(result)["steps"]]
    assert "E7 日历翻页" in steps
    assert driver.state["month_label"] == "2026年10月"


# --------------------------------------------------------------------------
# run() — the lxeskill entrypoint.
# --------------------------------------------------------------------------


def test_run_dispatches_read_only_discovery_plan_without_a_target_date():
    payload = dwa.run(
        {
            "action": "discover",
            "store_id": "store-1",
            "page_url": PAGE_URL,
            "shipment_ids": SHIPMENT,
            "plan_only": True,
        }
    )
    assert payload["success"] is True
    assert payload["data"]["plan"]["action"] == "discover"
    assert "target_date" not in payload["data"]["plan"]


def test_run_rejects_an_unknown_action():
    payload = dwa.run({"action": "guess"})
    assert payload["success"] is False
    assert "action 必须是" in payload["exception"]


def test_run_without_a_session_reports_it_before_touching_a_browser(monkeypatch):
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)
    payload = dwa.run(
        {"store_id": "store-1", "page_url": PAGE_URL, "shipment_ids": SHIPMENT, "target_date": TARGET_DATE_INPUT}
    )
    assert payload["success"] is False
    assert payload["exception"] == "缺少 LXE_AGENT_SESSION_ID"


def test_run_plan_only_never_opens_a_browser(monkeypatch):
    def explode(*args, **kwargs):
        raise AssertionError("plan_only 不得接触浏览器")

    monkeypatch.setattr(dwa, "browser_session", explode)
    payload = dwa.run(
        {
            "store_id": "store-1",
            "page_url": PAGE_URL,
            "shipment_ids": SHIPMENT,
            "target_date": TARGET_DATE_INPUT,
            "plan_only": True,
        }
    )
    assert payload["success"] is True
    assert payload["data"]["plan"]["target_window"]["display"] == TARGET_WINDOW


def test_run_reports_argument_errors_in_the_payload():
    payload = dwa.run({"store_id": "store-1", "page_url": "not-a-url", "shipment_ids": SHIPMENT, "target_date": "10.28"})
    assert payload == {
        "success": False,
        "finished": False,
        "auth_refresh_required": False,
        "exception": "page_url 必须是绝对 http(s) 地址（Amazon 货件列表页），收到: not-a-url",
        "notice": "",
        "file_path": [],
        "data": {},
    }


def test_run_wires_the_session_and_carries_a_real_exception(monkeypatch, tmp_path):
    @contextmanager
    def fake_browser_session(*, session_id, context, output_dir, **attach_options):
        assert session_id == "session-1"
        assert context == {"store_id": "store-1"}
        assert Path(output_dir) == tmp_path
        assert attach_options == {'strict_attach': True, 'target_host': 'sellercentral.amazon.com', 'target_handle': ''}
        yield SimpleNamespace(driver=None)

    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "session-1")
    monkeypatch.setattr(dwa, "workflow_output_dir", lambda _session_id: tmp_path)
    monkeypatch.setattr(dwa, "browser_session", fake_browser_session)

    payload = dwa.run(
        {"store_id": "store-1", "page_url": PAGE_URL, "shipment_ids": SHIPMENT, "target_date": TARGET_DATE_INPUT}
    )
    assert payload["success"] is False
    assert payload["exception"] == "RuntimeError: browser_session 没有提供 driver"


def _run_entrypoint(monkeypatch, tmp_path, driver, *, shipment_ids=None, cleanup_error=False):
    @contextmanager
    def fake_session(**kwargs):
        assert kwargs['strict_attach'] is True
        assert kwargs['target_host'] == 'sellercentral.amazon.com'
        assert kwargs['target_handle'] == 'amazon-tab'
        yield SimpleNamespace(driver=driver, store_id="store-1")
        if cleanup_error:
            raise WebDriverException("session cleanup failed")

    original_run = dwa._run_shipments
    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "test-session")
    monkeypatch.setattr(dwa, "browser_session", fake_session)
    monkeypatch.setattr(dwa, "workflow_output_dir", lambda _: tmp_path)
    monkeypatch.setattr(dwa, "_run_shipments", lambda driver, plan, **kwargs:
                        original_run(driver, plan, now=NOW, **kwargs))
    dry_run_id = _seed_preparation(driver, _plan(shipment_ids=shipment_ids or [SHIPMENT]), tmp_path)
    return dwa.run({"store_id": "store-1", "page_url": PAGE_URL,
                    "shipment_ids": shipment_ids or [SHIPMENT],
                    "target_date": TARGET_DATE_INPUT, "apply": True, "dry_run_id": dry_run_id, "timeout_sec": 1})


def test_driver_exception_keeps_applied_failed_and_unattempted_results(monkeypatch, tmp_path):
    ids = [SHIPMENT, SHIPMENT_B, SHIPMENT_C]
    driver = _ScriptedDriver(hub_cells=_hub_cells([(sid, "0/10", CURRENT_WINDOW) for sid in ids]), shipment_ids=ids)
    original_get = driver.get

    def fail_second(url):
        if f"/{SHIPMENT_B}/contents" in url:
            # First result must already be durable when the next ticket starts.
            audits = list(tmp_path.glob("amazon-delivery-window-apply-*.json"))
            assert len(audits) == 1
            saved = json.loads(audits[0].read_text())
            assert saved["shipments"][0]["status"] == "applied"
            raise WebDriverException("second shipment navigation failed")
        original_get(url)

    driver.get = fail_second
    result = _run_entrypoint(monkeypatch, tmp_path, driver, shipment_ids=ids)
    assert result["success"] is False
    assert [entry["status"] for entry in result["data"]["shipments"]] == ["applied", "failed", "not_attempted"]
    assert "WebDriverException" in result["exception"] and "second shipment navigation failed" in result["exception"]
    artifact = json.loads(Path(result["file_path"][0]["value"]).read_text())
    assert artifact["shipments"] == result["data"]["shipments"]


@pytest.mark.parametrize("phase", ["confirm", "readback"])
def test_post_submit_exception_requires_readback_and_keeps_audit(monkeypatch, tmp_path, phase):
    class Driver(_ScriptedDriver):
        @property
        def page_source(self):
            if phase == "readback" and self.state["applied"]:
                raise WebDriverException("readback disconnected")
            return super().page_source

        def execute_script(self, script, *args):
            if "dispatchClick" in script and args and args[0] == dwa.UPDATE_BUTTON_SELECTOR:
                saved = json.loads(next(tmp_path.glob("amazon-delivery-window-apply-*.json")).read_text())
                assert saved["shipments"][0]["status"] == "pending_readback"
                assert saved["shipments"][0]["readback_required"] is True
                result = super().execute_script(script, *args)
                if phase == "confirm":
                    raise WebDriverException("confirm response lost")
                return result
            return super().execute_script(script, *args)

    driver = Driver(hub_cells=_hub_cells([(SHIPMENT, "0/10", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    result = _run_entrypoint(monkeypatch, tmp_path, driver)
    entry = _entry(result)
    assert result["success"] is False
    assert entry["status"] == "pending_readback" and entry["readback_required"] is True
    assert entry["confirmation_attempted"] is True
    assert "WebDriverException" in entry["failure_detail"]
    assert json.loads(Path(result["file_path"][0]["value"]).read_text())["shipments"][0] == entry
    assert sum(click[0] == dwa.UPDATE_BUTTON_SELECTOR for click in driver.clicks) == 1


@pytest.mark.parametrize("cancel_return", [False, True])
def test_dry_run_requires_cancel_and_modal_closure(tmp_path, cancel_return):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "0/10", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    original_execute = driver.execute_script

    def stuck_modal(script, *args):
        if "dispatchClick" in script and args and args[0] == dwa.CANCEL_BUTTON_SELECTOR:
            return cancel_return
        return original_execute(script, *args)

    driver.execute_script = stuck_modal
    result = _run(driver, _plan(apply=False), tmp_path)
    assert result["success"] is False and result["finished"] is False
    entry = _entry(result)
    assert entry["status"] == "failed" and entry["failure_code"] == "E10"
    assert entry["dry_run_cancel_clicked"] is cancel_return
    assert driver.state["modal_open"] is True
    assert not driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)


def test_session_cleanup_error_does_not_discard_completed_results(monkeypatch, tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "0/10", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    result = _run_entrypoint(monkeypatch, tmp_path, driver, cleanup_error=True)
    assert result["success"] is False
    assert _entry(result)["status"] == "applied"
    assert result["file_path"] and "session cleanup failed" in result["exception"]


def test_audit_write_failure_stops_before_confirm_and_keeps_progress(monkeypatch, tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, "0/10", CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    write = dwa._write_artifact

    def fail_on_submission(output_dir, payload, **kwargs):
        if any(entry["status"] == "pending_readback" for entry in payload["shipments"]):
            raise OSError("audit disk full")
        return write(output_dir, payload, **kwargs)

    monkeypatch.setattr(dwa, "_write_artifact", fail_on_submission)
    result = _run_entrypoint(monkeypatch, tmp_path, driver)
    assert result["success"] is False and "OSError: audit disk full" in result["exception"]
    assert _entry(result)["status"] == "failed"
    assert _entry(result)["confirmation_attempted"] is False
    assert not driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)
    assert result["file_path"]


def test_persistent_audit_failure_after_success_keeps_result_and_stops(monkeypatch, tmp_path):
    ids = [SHIPMENT, SHIPMENT_B]
    driver = _ScriptedDriver(hub_cells=_hub_cells([(sid, "0/10", CURRENT_WINDOW) for sid in ids]), shipment_ids=ids)
    write = dwa._write_artifact

    def disk_full_after_applied(output_dir, payload, **kwargs):
        if payload["shipments"][0]["status"] == "applied":
            raise OSError("disk full after first shipment")
        return write(output_dir, payload, **kwargs)

    monkeypatch.setattr(dwa, "_write_artifact", disk_full_after_applied)
    result = _run_entrypoint(monkeypatch, tmp_path, driver, shipment_ids=ids)
    assert result["success"] is False
    assert [entry["status"] for entry in result["data"]["shipments"]] == ["applied", "not_attempted"]
    assert result["data"]["audit_error"] == "OSError: disk full after first shipment"
    saved = json.loads(Path(result["file_path"][0]["value"]).read_text())
    assert saved["shipments"][0]["status"] == "pending_readback"
    assert not any(f"/{SHIPMENT_B}/contents" in url for url in driver.opened)


def test_initial_audit_failure_prevents_browser_actions(monkeypatch, tmp_path):
    driver = _ScriptedDriver(hub_cells=[], shipment_ids=[SHIPMENT])

    def fail(*args, **kwargs):
        raise PermissionError("audit directory denied")

    monkeypatch.setattr(dwa, "_write_artifact", fail)
    result = _run_entrypoint(monkeypatch, tmp_path, driver)
    assert result["success"] is False
    assert _entry(result)["status"] == "not_attempted"
    assert "PermissionError: audit directory denied" in result["exception"]
    assert result["file_path"] == [] and driver.opened == []


def test_atomic_audit_failure_leaves_last_complete_file(monkeypatch, tmp_path):
    path = dwa._write_artifact(tmp_path, {"stage": "complete"})

    def fail_replace(*args):
        raise OSError("replace failed")

    monkeypatch.setattr(dwa.os, "replace", fail_replace)
    with pytest.raises(OSError, match="replace failed"):
        dwa._write_artifact(tmp_path, {"stage": "new"}, target_path=path)
    assert json.loads(Path(path).read_text()) == {"stage": "complete"}


def test_hub_driver_exception_returns_unattempted_tickets_and_audit(monkeypatch, tmp_path):
    driver = _ScriptedDriver(hub_cells=[], shipment_ids=[SHIPMENT])

    def fail_get(url):
        raise WebDriverException("hub navigation failed")

    driver.get = fail_get
    result = _run_entrypoint(monkeypatch, tmp_path, driver)
    assert result["success"] is False and _entry(result)["status"] == "not_attempted"
    assert "WebDriverException" in result["exception"] and "hub navigation failed" in result["exception"]
    assert result["file_path"]


# Browser observations, preparation binding, and recovery exercise the real
# orchestration above; no live Amazon writes are performed by these tests.

def test_apply_requires_preparation_before_attaching(monkeypatch):
    monkeypatch.setattr(dwa, 'browser_session', lambda **_: pytest.fail('must not attach'))
    result = dwa.run({'store_id': 'store-1', 'page_url': PAGE_URL,
                      'shipment_ids': [SHIPMENT], 'target_date': TARGET_DATE_INPUT, 'apply': True})
    assert not result['success']
    assert 'dry_run_id' in result['exception']


def test_dry_run_receipt_can_be_used_once_for_the_exact_plan(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, '0/10', CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    dry = dwa._run_shipments(driver, _plan(), output_dir=tmp_path, now=NOW)
    assert dry['finished'] and len(dry['data']['dry_run_id']) == 32
    plan = _plan(apply=True, dry_run_id=dry['data']['dry_run_id'])
    result = dwa._run_shipments(driver, plan, output_dir=tmp_path, now=NOW)
    assert _entry(result)['status'] == 'applied'
    clicks = list(driver.clicks)
    repeated = dwa._run_shipments(driver, plan, output_dir=tmp_path, now=NOW)
    assert not repeated['success'] and '已执行过' in repeated['exception']
    assert driver.clicks == clicks
    assert len(_entry(result)['observations']) >= 4
    assert _entry(result)['phase'] == 'complete'


@pytest.mark.parametrize('change', ['date', 'store', 'url', 'order'])
def test_preparation_rejects_changed_parameters_before_browser(tmp_path, monkeypatch, change):
    ids = [SHIPMENT, SHIPMENT_B]
    driver = _ScriptedDriver(hub_cells=_hub_cells([(sid, '0/10', CURRENT_WINDOW) for sid in ids]), shipment_ids=ids)
    plan = _plan(shipment_ids=ids)
    dry_run_id = _seed_preparation(driver, plan, tmp_path)
    args = {'store_id': 'store-1', 'page_url': PAGE_URL, 'shipment_ids': ids,
            'target_date': TARGET_DATE_INPUT, 'dry_run_id': dry_run_id, 'apply': True}
    if change == 'date':
        args['target_date'] = '2026-10-29'  # even a different day in the same week
    elif change == 'store':
        args['store_id'] = 'store-2'
    elif change == 'url':
        args['page_url'] += '&other=1'
    else:
        args['shipment_ids'] = list(reversed(ids))
    monkeypatch.setenv('LXE_AGENT_SESSION_ID', 'test-session')
    monkeypatch.setattr(dwa, 'workflow_output_dir', lambda _: tmp_path)
    monkeypatch.setattr(dwa, 'browser_session', lambda **_: pytest.fail('must not attach'))
    result = dwa.run(args)
    assert not result['success'] and 'dry-run 不一致' in result['exception']


@pytest.mark.parametrize('changed', ['window', 'deadline', 'handle', 'workflow'])
def test_changed_page_evidence_stops_before_opening_editor(tmp_path, changed):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, '0/10', CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    dry = dwa._run_shipments(driver, _plan(), output_dir=tmp_path, now=NOW)
    driver.clicks.clear()
    if changed == 'window':
        driver.state['current_window'] = '2026年10月18日 - 2026年10月24日'
    elif changed == 'deadline':
        driver.state['grace'] = '在 2026年10月12日, 00:00 UTC 之前'
    elif changed == 'handle':
        driver.state['window_handle'] = 'another-tab'
    else:
        original_get = driver.get
        driver.get = lambda url: original_get(url.replace(f'wf={SHIPMENT}', 'wf=changed'))
    result = dwa._run_shipments(driver, _plan(apply=True, dry_run_id=dry['data']['dry_run_id']),
                                output_dir=tmp_path, now=NOW)
    assert _entry(result)['failure_code'] == 'preparation_changed'
    assert not driver.clicked(dwa.EDIT_LINK_SELECTOR)
    assert not driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)


def test_already_open_editor_is_not_reused(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, '0/10', CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    driver.state['modal_open'] = True
    result = _run(driver, _plan(), tmp_path)
    assert _entry(result)['failure_code'] == 'context_changed'
    assert not driver.clicked(dwa.EDIT_LINK_SELECTOR)
    assert not result['data']['dry_run_id']


def test_target_tab_switch_before_submit_invalidates_observation(tmp_path):
    ids = [SHIPMENT, SHIPMENT_B]
    driver = _ScriptedDriver(hub_cells=_hub_cells([(sid, '0/10', CURRENT_WINDOW) for sid in ids]), shipment_ids=ids)
    original = driver.execute_script

    def switch_tab(script, *args):
        result = original(script, *args)
        if 'labelPrefix' in script:
            driver.state['selected_index'] = 1
        return result

    driver.execute_script = switch_tab
    result = _run(driver, _plan(apply=True), tmp_path)
    assert _entry(result)['failure_code'] == 'E2'
    assert _entry(result)['last_observation_valid'] is False
    assert not driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)


def test_deadline_is_checked_again_immediately_before_submit(tmp_path, monkeypatch):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, '0/10', CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    original = driver.execute_script

    def advance_clock(script, *args):
        result = original(script, *args)
        if 'labelPrefix' in script:
            monkeypatch.setattr(dwa, '_utc_now', lambda: dt.datetime(2026, 10, 12, tzinfo=dt.timezone.utc))
        return result

    driver.execute_script = advance_clock
    result = _run(driver, _plan(apply=True), tmp_path)
    assert _entry(result)['failure_code'] == 'E3'
    assert not driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)


def test_modal_text_cannot_fake_successful_readback(tmp_path):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, '0/10', CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    original = driver.execute_script

    def stale_modal(script, *args):
        result = original(script, *args)
        if 'dispatchClick' in script and args[0] == dwa.UPDATE_BUTTON_SELECTOR:
            driver.state.update(applied=False, modal_open=True, current_window=TARGET_WINDOW)
            driver.shipment_states[SHIPMENT] = {'current_window': CURRENT_WINDOW}
        return result

    driver.execute_script = stale_modal
    result = _run(driver, _plan(apply=True), tmp_path)
    assert _entry(result)['status'] == 'pending_readback'
    assert _entry(result)['applied_window']['raw'] == CURRENT_WINDOW
    assert sum(click[0] == dwa.UPDATE_BUTTON_SELECTOR for click in driver.clicks) == 1


def test_failed_snapshot_preserves_real_exception_and_invalidates_previous_read(tmp_path):
    class Driver(_ScriptedDriver):
        @property
        def page_source(self):
            if self.state['day_clicked']:
                raise WebDriverException('specific snapshot transport failure')
            return super().page_source

    driver = Driver(hub_cells=_hub_cells([(SHIPMENT, '0/10', CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    result = _run(driver, _plan(apply=True), tmp_path)
    assert 'specific snapshot transport failure' in result['exception']
    assert _entry(result)['last_observation_valid'] is False
    assert not driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)


@pytest.mark.parametrize('matches', [True, False])
def test_readback_is_read_only_even_after_deadline_and_lifecycle_change(tmp_path, matches):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, '10/10', CURRENT_WINDOW, '正在接收')]), shipment_ids=[SHIPMENT])
    driver.state.update(current_window=TARGET_WINDOW if matches else CURRENT_WINDOW,
                        grace='', with_edit_link=False)
    later = dt.datetime(2027, 1, 1, tzinfo=dt.timezone.utc)
    plan = dwa.plan_apply({'action': 'readback', 'store_id': 'store-1', 'page_url': PAGE_URL,
                          'shipment_ids': [SHIPMENT], 'target_date': TARGET_DATE_INPUT, 'timeout_sec': 1}, now=later)
    result = dwa._run_shipments(driver, plan, output_dir=tmp_path, now=later)
    assert _entry(result)['status'] == ('verified_target' if matches else 'readback_mismatch')
    assert result['success'] is matches
    assert result['data']['dry_run'] is False
    assert not result['data']['dry_run_id']
    assert not driver.clicked(dwa.EDIT_LINK_SELECTOR)
    assert not driver.clicked(dwa.CALENDAR_SELECTOR)
    assert not driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)
    assert _entry(result)['confirmation_attempted'] is False


@pytest.mark.parametrize('extra', [{'apply': True}, {'dry_run_id': 'a' * 32}])
def test_readback_rejects_write_arguments(extra):
    with pytest.raises(dwa.DeliveryWindowApplyArgumentError, match='只读核验'):
        _plan(action='readback', **extra)


def test_preparation_claim_is_atomic_for_concurrent_executors(tmp_path):
    from concurrent.futures import ThreadPoolExecutor

    preparation_id = 'b' * 32

    def claim(_):
        try:
            dwa.preparation.claim(tmp_path, preparation_id)
            return True
        except FileExistsError:
            return False

    with ThreadPoolExecutor(max_workers=2) as executor:
        assert sorted(executor.map(claim, range(2))) == [False, True]


def test_page_changing_during_capture_is_rejected(tmp_path):
    class Driver(_ScriptedDriver):
        @property
        def page_source(self):
            html = super().page_source
            self.state['window_handle'] = 'changed-during-read'
            return html

    driver = Driver(hub_cells=[], shipment_ids=[SHIPMENT])
    driver.get(f'{ORIGIN}/fba/sendtoamazon?wf={SHIPMENT}')
    with pytest.raises(dwa._HardFailure) as failure:
        dwa.observe_shipment(driver, _plan(), SHIPMENT, now=NOW)
    assert failure.value.code == 'context_changed'


@pytest.mark.parametrize('mode', ['missing', 'corrupt', 'oversized'])
def test_bad_preparation_is_rejected_before_attach_and_keeps_real_error(tmp_path, monkeypatch, mode):
    preparation_id = 'c' * 32
    path = tmp_path / f'delivery-window-preparation-{preparation_id}.json'
    if mode == 'corrupt':
        path.write_text('{ broken', encoding='utf-8')
    elif mode == 'oversized':
        path.write_bytes(b' ' * (dwa.preparation.MAX_RECEIPT_BYTES + 1))
    monkeypatch.setenv('LXE_AGENT_SESSION_ID', 'test-session')
    monkeypatch.setattr(dwa, 'workflow_output_dir', lambda _: tmp_path)
    monkeypatch.setattr(dwa, 'browser_session', lambda **_: pytest.fail('must not attach'))
    result = dwa.run({'store_id': 'store-1', 'page_url': PAGE_URL, 'shipment_ids': [SHIPMENT],
                      'target_date': TARGET_DATE_INPUT, 'apply': True, 'dry_run_id': preparation_id})
    assert not result['success']
    expected = {'missing': 'FileNotFoundError', 'corrupt': 'JSONDecodeError', 'oversized': '超过'}
    assert expected[mode] in result['exception']


def test_readback_entrypoint_strictly_attaches_and_reports_actual_page(tmp_path, monkeypatch):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, '0/10', CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    driver.state['current_window'] = TARGET_WINDOW

    @contextmanager
    def session(**kwargs):
        assert kwargs['strict_attach'] is True
        assert kwargs['target_host'] == 'sellercentral.amazon.com'
        assert kwargs['target_handle'] == 'amazon-tab'
        yield SimpleNamespace(driver=driver, store_id='store-1')

    monkeypatch.setenv('LXE_AGENT_SESSION_ID', 'test-session')
    monkeypatch.setattr(dwa, 'workflow_output_dir', lambda _: tmp_path)
    monkeypatch.setattr(dwa, 'browser_session', session)
    result = dwa.run({'action': 'readback', 'store_id': 'store-1', 'page_url': PAGE_URL,
                      'shipment_ids': [SHIPMENT], 'target_date': TARGET_DATE_INPUT,
                      'target_handle': 'amazon-tab', 'timeout_sec': 1})
    assert result['success'] and _entry(result)['status'] == 'verified_target'
    assert TARGET_WINDOW in result['notice']
    assert CURRENT_WINDOW not in result['notice']
    assert result['file_path'][0]['key'] == 'delivery_window_readback'
    assert not driver.clicked(dwa.EDIT_LINK_SELECTOR)
    assert not driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)


def test_session_with_another_store_is_rejected_before_navigation(tmp_path, monkeypatch):
    driver = _ScriptedDriver(hub_cells=[], shipment_ids=[SHIPMENT])

    @contextmanager
    def session(**kwargs):
        yield SimpleNamespace(driver=driver, store_id='another-store')

    monkeypatch.setenv('LXE_AGENT_SESSION_ID', 'test-session')
    monkeypatch.setattr(dwa, 'workflow_output_dir', lambda _: tmp_path)
    monkeypatch.setattr(dwa, 'browser_session', session)
    result = dwa.run({'action': 'readback', 'store_id': 'store-1', 'page_url': PAGE_URL,
                      'shipment_ids': [SHIPMENT], 'target_date': TARGET_DATE_INPUT})
    assert not result['success'] and 'another-store' in result['exception']
    assert driver.opened == [] and driver.clicks == []


def test_deadline_expiring_during_audit_does_not_dispatch_submit(tmp_path, monkeypatch):
    driver = _ScriptedDriver(hub_cells=_hub_cells([(SHIPMENT, '0/10', CURRENT_WINDOW)]), shipment_ids=[SHIPMENT])
    original_write = dwa._write_artifact

    def slow_audit(output_dir, payload, **kwargs):
        result = original_write(output_dir, payload, **kwargs)
        if any(item['status'] == 'pending_readback' for item in payload['shipments']):
            monkeypatch.setattr(dwa, '_utc_now', lambda: dt.datetime(2026, 10, 12, tzinfo=dt.timezone.utc))
        return result

    monkeypatch.setattr(dwa, '_write_artifact', slow_audit)
    result = _run(driver, _plan(apply=True), tmp_path)
    entry = _entry(result)
    assert entry['failure_code'] == 'submission_changed'
    assert entry['confirmation_attempted'] is False and entry['readback_required'] is False
    assert not driver.clicked(dwa.UPDATE_BUTTON_SELECTOR)
