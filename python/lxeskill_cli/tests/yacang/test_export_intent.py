from __future__ import annotations

from datetime import date
import json
from pathlib import Path
from typing import Any

import pytest

from services.yacang.export_intent import (
    ALL_DATA_TYPES,
    WAREHOUSE_CODES,
    normalize_export_intent,
)


FIXED_TODAY = lambda: date(2026, 9, 14)
EVAL_CASES = json.loads(
    (Path(__file__).parent / "fixtures" / "export_intent_eval.json").read_text(encoding="utf-8")
)


def normalized(text: str, **kwargs: Any) -> dict[str, Any]:
    return normalize_export_intent(text, today=FIXED_TODAY, **kwargs)


def test_omitted_dimensions_apply_deterministic_defaults() -> None:
    result = normalized("导出雅仓数据")

    assert result["intent"] == {
        "data_type_intent": {"state": "omitted"},
        "warehouse_intent": {"state": "omitted"},
        "created_date_filter": {"state": "omitted"},
        "inventory_snapshot_intent": {"state": "omitted"},
    }
    assert result["effective_request"] == {
        "data_types": list(ALL_DATA_TYPES),
        "warehouses": list(WAREHOUSE_CODES),
        "created_date_filter": {
            "mode": "default",
            "created_start_date": "2026-09-14",
            "created_end_date": "2026-09-14",
            "source": "system_default",
            "input_fragments": [],
            "normalization_rules": ["default_execution_day"],
        },
    }
    assert result["questions"] == []
    assert result["preflight_issues"] == []
    assert result["requires_clarification"] is False


@pytest.mark.parametrize("execution_day", [date(2026, 9, 15), date(2026, 10, 1)])
def test_default_created_date_tracks_execution_day(execution_day: date) -> None:
    result = normalize_export_intent("导出月度销量", today=lambda: execution_day)

    created = result["effective_request"]["created_date_filter"]
    assert created["created_start_date"] == execution_day.isoformat()
    assert created["created_end_date"] == execution_day.isoformat()


@pytest.mark.parametrize(
    "candidate",
    [
        {"state": "omitted", "mode": "default"},
        {"state": "ambiguous", "days": 7},
        {"state": "resolved", "mode": "default", "days": 7},
        {
            "state": "resolved",
            "mode": "relative_days",
            "days": 7,
            "created_start_date": "2026-09-01",
        },
        {
            "state": "resolved",
            "mode": "explicit_range",
            "created_start_date": "2026-09-01",
            "created_end_date": "2026-09-10",
        },
        {"state": "resolved", "mode": "relative_days", "days": 0},
        {"state": "resolved", "mode": "unknown"},
    ],
)
def test_created_date_filter_rejects_non_exclusive_shapes(
    candidate: dict[str, Any],
) -> None:
    with pytest.raises(ValueError):
        normalized("导出雅仓销量", created_date_filter=candidate)


@pytest.mark.parametrize(
    ("field", "candidate"),
    [
        ("data_type_intent", {"state": "omitted", "values": ["sales-monthly"]}),
        ("data_type_intent", {"state": "resolved", "values": []}),
        ("data_type_intent", {"state": "resolved", "values": ["unknown"]}),
        ("data_type_intent", {"state": "resolved", "values": ["sales-monthly"] * 2}),
        ("data_type_intent", {"state": "unsupported"}),
        ("warehouse_intent", {"state": "omitted", "values": ["MY8801"]}),
        ("warehouse_intent", {"state": "resolved", "values": []}),
        ("warehouse_intent", {"state": "resolved", "values": ["UNKNOWN"]}),
        ("inventory_snapshot_intent", {"state": "resolved"}),
        ("inventory_snapshot_intent", {"state": "current", "date": "2026-09-01"}),
    ],
)
def test_agent_candidates_reject_invalid_or_unknown_shapes(
    field: str,
    candidate: dict[str, Any],
) -> None:
    with pytest.raises(ValueError):
        normalized("导出雅仓数据", **{field: candidate})


@pytest.mark.parametrize("value", [None, "", "   ", 123, ["导出雅仓数据"]])
def test_request_text_must_be_non_empty_text(value: Any) -> None:
    with pytest.raises(ValueError):
        normalize_export_intent(value, today=FIXED_TODAY)


def test_legacy_inventory_candidate_normalizes_at_compatibility_boundary() -> None:
    result = normalized(
        "导出库存",
        data_type_intent={"state": "resolved", "values": ["inventory-month-end"]},
    )

    assert result["intent"]["data_type_intent"] == {
        "state": "resolved",
        "values": ["inventory-current-snapshot"],
    }
    assert result["effective_request"]["data_types"] == ["inventory-current-snapshot"]


@pytest.mark.parametrize("legacy_type", ["sales-monthly", "sales-90d"])
def test_legacy_sales_candidates_normalize_to_inventory_sales(legacy_type: str) -> None:
    result = normalized(
        "导出销量",
        data_type_intent={"state": "resolved", "values": [legacy_type]},
    )

    assert result["intent"]["data_type_intent"] == {
        "state": "resolved",
        "values": ["inventory-sales"],
    }
    assert result["effective_request"]["data_types"] == ["inventory-sales"]


@pytest.mark.parametrize(
    "values",
    [
        ["sales-monthly", "sales-90d"],
        ["inventory-sales", "sales-monthly"],
    ],
)
def test_distinct_legacy_sales_aliases_collapse_to_one_inventory_sales_type(values: list[str]) -> None:
    result = normalized(
        "导出销量",
        data_type_intent={"state": "resolved", "values": values},
    )

    assert result["intent"]["data_type_intent"]["values"] == ["inventory-sales"]
    assert result["effective_request"]["data_types"] == ["inventory-sales"]


def test_genuinely_duplicate_sales_candidate_is_still_rejected() -> None:
    with pytest.raises(ValueError, match="不允许重复"):
        normalized(
            "导出销量",
            data_type_intent={"state": "resolved", "values": ["sales-monthly", "sales-monthly"]},
        )


@pytest.mark.parametrize(
    "text",
    ["90天逐日销量", "90天每天销量", "日销量明细", "逐日销量"],
)
def test_daily_sales_detail_is_unsupported_not_a_cumulative_report(text: str) -> None:
    result = normalized(text)

    assert result["requires_clarification"] is False
    assert result["intent"]["data_type_intent"] == {"state": "unsupported"}
    assert result["effective_request"]["data_types"] == []
    assert result["preflight_issues"][0]["code"] == "UNSUPPORTED_DATA_TYPE"


@pytest.mark.parametrize(
    "text",
    [
        "导出销量",
        "导出7天销量",
        "导出15天销量",
        "导出30天销量",
        "导出60天销量",
        "导出90天销量",
        "导出库存动销",
        "导出库存和销量",
        "导出动销数据",
    ],
)
def test_sales_language_resolves_to_complete_inventory_sales(text: str) -> None:
    result = normalized(text)

    assert result["requires_clarification"] is False
    assert result["effective_request"]["data_types"] == ["inventory-sales"]


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("导出最近30天销量", ["inventory-sales"]),
        ("导出7/15/30销量", ["inventory-sales"]),
        ("导出60天销量", ["inventory-sales"]),
        ("导出最近30天销售", ["inventory-sales"]),
        ("近一个月销售情况", ["inventory-sales"]),
        ("最近一个月出货", ["inventory-sales"]),
        ("最近30天卖了多少", ["inventory-sales"]),
        ("一周销量", ["inventory-sales"]),
        ("两周销量", ["inventory-sales"]),
        ("一个月销量", ["inventory-sales"]),
        ("导出近90天销量", ["inventory-sales"]),
        ("导出近三个月销量", ["inventory-sales"]),
        ("最近三个月销售趋势", ["inventory-sales"]),
        ("导出当前库存", ["inventory-current-snapshot"]),
        ("导出现在库存", ["inventory-current-snapshot"]),
        ("导出库存现状", ["inventory-current-snapshot"]),
        ("导出库存快照", ["inventory-current-snapshot"]),
        ("现在还有多少货", ["inventory-current-snapshot"]),
        ("还剩多少货", ["inventory-current-snapshot"]),
        ("仓里还有多少", ["inventory-current-snapshot"]),
        ("当前剩多少", ["inventory-current-snapshot"]),
        ("目前库存", ["inventory-current-snapshot"]),
        ("导出什么时候上架", ["inbound-listing-time"]),
        ("什么时候进仓", ["inbound-listing-time"]),
        ("哪天入仓", ["inbound-listing-time"]),
        ("产品什么时候上的架", ["inbound-listing-time"]),
        ("这批货什么时候进来的", ["inbound-listing-time"]),
        ("一次性导出仓库产品", ["inbound-listing-time"]),
    ],
)
def test_supported_colloquial_types_map_to_fixed_canonical_types(
    text: str,
    expected: list[str],
) -> None:
    result = normalized(text)

    assert result["effective_request"]["data_types"] == expected
    assert result["requires_clarification"] is False


@pytest.mark.parametrize(
    "text",
    [
        "导出最近卖得怎么样",
        "导出最近销售情况",
        "导出库存相关",
    ],
)
def test_true_semantic_ambiguity_requires_clarification(text: str) -> None:
    result = normalized(text)

    assert result["requires_clarification"] is True
    assert result["effective_request"] is None
    assert result["questions"]


def test_generic_sales_with_relative_creation_filter_resolves_complete_report() -> None:
    result = normalized("最近7天创建的商品销量")

    assert result["intent"]["data_type_intent"] == {
        "state": "resolved",
        "values": ["inventory-sales"],
    }
    assert result["intent"]["created_date_filter"] == {
        "state": "resolved",
        "mode": "relative_days",
        "days": 7,
    }
    assert result["requires_clarification"] is False
    assert result["effective_request"]["data_types"] == ["inventory-sales"]


def test_inventory_plus_both_sales_selects_one_complete_report() -> None:
    result = normalized("库存和两种销量都要")

    assert result["effective_request"]["data_types"] == ["inventory-sales"]


@pytest.mark.parametrize(
    "text",
    ["全部数据", "所有数据", "完整数据", "全套", "四类", "导一套", "雅仓都要"],
)
def test_all_data_phrases_select_all_three_types(text: str) -> None:
    result = normalized(text)

    assert result["intent"]["data_type_intent"] == {
        "state": "resolved",
        "values": list(ALL_DATA_TYPES),
    }
    assert result["effective_request"]["data_types"] == list(ALL_DATA_TYPES)


@pytest.mark.parametrize("text", ["导出四仓月底库存", "导出月末库存", "导出月末快照"])
def test_bare_month_end_inventory_requires_clarification(text: str) -> None:
    result = normalized(text)

    assert result["intent"]["inventory_snapshot_intent"] == {"state": "ambiguous"}
    assert result["effective_request"] is None
    assert result["requires_clarification"] is True
    assert result["questions"] == [
        {
            "dimension": "inventory_snapshot",
            "code": "AMBIGUOUS_INVENTORY_SNAPSHOT",
            "message": "请确认需要当前库存，还是指定历史月份的月末库存。",
        }
    ]


@pytest.mark.parametrize("text", ["导出当前库存", "现在库存多少", "还剩多少货"])
def test_current_inventory_phrases_resolve_current_snapshot(text: str) -> None:
    result = normalized(text)

    assert result["intent"]["inventory_snapshot_intent"] == {"state": "current"}
    assert result["effective_request"]["data_types"] == ["inventory-current-snapshot"]
    assert result["requires_clarification"] is False


@pytest.mark.parametrize(
    "text",
    ["导出上个月月底库存", "导出上月月末库存", "导出8月31日库存"],
)
def test_historical_inventory_phrases_are_unsupported_without_current_snapshot(text: str) -> None:
    result = normalized(text)

    assert result["intent"]["data_type_intent"] == {"state": "unsupported"}
    assert result["intent"]["inventory_snapshot_intent"] == {"state": "historical"}
    assert result["effective_request"]["data_types"] == []
    assert result["requires_clarification"] is False
    assert result["preflight_issues"] == [
        {
            "kind": "unsupported",
            "code": "UNSUPPORTED_HISTORICAL_INVENTORY",
            "message": "当前雅仓能力不支持指定历史日期或历史月末库存快照。",
        }
    ]


@pytest.mark.parametrize("case", EVAL_CASES, ids=lambda case: case["id"])
def test_data_driven_natural_language_eval(case: dict[str, Any]) -> None:
    result = normalized(case["text"])

    assert result["intent"]["data_type_intent"]["state"] == case["expected_state"]
    if case.get("expected_requires_clarification"):
        assert result["requires_clarification"] is True
        assert result["effective_request"] is None
        return
    if case["expected_state"] == "resolved":
        assert result["effective_request"]["data_types"] == case["data_types"]
        if "warehouses" in case:
            assert result["effective_request"]["warehouses"] == case["warehouses"]
    if case["expected_state"] == "ambiguous":
        assert result["requires_clarification"] is True
        assert result["effective_request"] is None
    if case["expected_state"] == "unsupported":
        assert result["requires_clarification"] is False
        assert result["preflight_issues"][0]["code"] == case["diagnostic_code"]
        if "requested_sales_window_days" in case:
            assert result["preflight_issues"][0]["requested_value"] == {
                "sales_window_days": case["requested_sales_window_days"]
            }


def test_sales_clarification_uses_business_labels_not_internal_windows() -> None:
    result = normalized("导出最近卖得怎么样")

    assert result["requires_clarification"] is True
    assert result["questions"][0]["message"] == "请确认是否需要导出完整库存动销报表。"
    assert "7/15/30" not in result["questions"][0]["message"]


def test_relative_creation_days_are_calculated_only_by_deterministic_layer() -> None:
    result = normalized("导出最近30天创建商品的月度销量")

    assert result["intent"]["created_date_filter"] == {
        "state": "resolved",
        "mode": "relative_days",
        "days": 30,
    }
    assert result["effective_request"]["created_date_filter"] == {
        "mode": "relative_days",
        "created_start_date": "2026-08-15",
        "created_end_date": "2026-09-14",
        "source": "deterministic_relative_days",
        "input_fragments": ["最近30天创建"],
        "normalization_rules": ["relative_creation_days"],
    }


@pytest.mark.parametrize(
    ("text", "expected_rule"),
    [
        ("导出创建日期2026-09-01 到 2026-09-10的月度销量", "explicit_iso_range"),
        ("导出创建日期2026年9月1日到2026年9月10日的月度销量", "explicit_chinese_range"),
        ("导出创建日期9月1日到9月10日的月度销量", "execution_year_inference"),
    ],
)
def test_explicit_creation_ranges_are_normalized_from_raw_text(
    text: str,
    expected_rule: str,
) -> None:
    result = normalized(
        text,
        created_date_filter={"state": "resolved", "mode": "explicit_range"},
    )
    effective = result["effective_request"]["created_date_filter"]

    assert effective["created_start_date"] == "2026-09-01"
    assert effective["created_end_date"] == "2026-09-10"
    assert expected_rule in effective["normalization_rules"]
    assert effective["input_fragments"]


@pytest.mark.parametrize(
    "text",
    [
        "导出创建日期2026-09-01的月度销量",
        "导出创建日期2026-09-10到2026-09-01的月度销量",
        "导出创建日期12月20日到1月5日的月度销量",
    ],
)
def test_incomplete_invalid_or_cross_year_ranges_require_clarification(text: str) -> None:
    result = normalized(text)

    assert result["requires_clarification"] is True
    assert result["effective_request"] is None


@pytest.mark.parametrize("days", [45, 56, 120])
def test_custom_sales_windows_are_deterministic_unsupported_output(days: int) -> None:
    result = normalized(f"导出{days}天销量")

    assert result["intent"]["data_type_intent"] == {"state": "unsupported"}
    assert result["effective_request"]["data_types"] == []
    assert result["requires_clarification"] is False
    assert result["preflight_issues"] == [
        {
            "kind": "unsupported",
            "code": "UNSUPPORTED_SALES_WINDOW",
            "requested_value": {"sales_window_days": days},
            "message": "当前完整库存动销报表只包含固定的销量窗口，不支持自定义销量天数",
        }
    ]
    assert "requested_value" not in result["effective_request"]


def test_7_15_30_wording_selects_complete_inventory_sales_report() -> None:
    result = normalized("导出7/15/30销量")

    assert result["intent"]["data_type_intent"] == {
        "state": "resolved",
        "values": ["inventory-sales"],
    }
    assert result["effective_request"]["data_types"] == ["inventory-sales"]
    assert result["preflight_issues"] == []
    assert "sales_window_days" not in result["effective_request"]


@pytest.mark.parametrize("text", ["导出雅仓利润", "导出雅仓订单"])
def test_explicit_unknown_business_is_unsupported_instead_of_defaulting_all(text: str) -> None:
    result = normalized(text)

    assert result["intent"]["data_type_intent"] == {"state": "unsupported"}
    assert result["effective_request"]["data_types"] == []
    assert result["preflight_issues"][0]["code"] == "UNSUPPORTED_DATA_TYPE"
    assert result["requires_clarification"] is False


def test_mixed_unsupported_window_keeps_only_supported_type() -> None:
    result = normalized("导出当前库存和56天销量")

    assert result["intent"]["data_type_intent"] == {"state": "unsupported"}
    assert result["effective_request"]["data_types"] == ["inventory-current-snapshot"]
    assert result["preflight_issues"][0]["code"] == "UNSUPPORTED_SALES_WINDOW"


def test_plain_sales_number_does_not_become_creation_filter() -> None:
    result = normalized("导出最近30天销量")

    assert result["intent"]["created_date_filter"] == {"state": "omitted"}
    assert result["effective_request"]["created_date_filter"]["mode"] == "default"


def test_warehouse_defaults_subset_and_unknown_are_deterministic() -> None:
    default = normalized("导出当前库存")
    subset = normalized("导出 MY8801、TH8802 当前库存")
    unknown = normalized("导出 XX9999 当前库存")

    assert default["effective_request"]["warehouses"] == list(WAREHOUSE_CODES)
    assert subset["effective_request"]["warehouses"] == ["MY8801", "TH8802"]
    assert unknown["requires_clarification"] is True
    assert unknown["effective_request"] is None


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("导出马来西亚仓当前库存", ["MY8801"]),
        ("导出马来西亚当前库存", ["MY8801"]),
        ("导出马来仓当前库存", ["MY8801"]),
        ("导出马来当前库存", ["MY8801"]),
        ("导出菲律宾仓当前库存", ["PH8805"]),
        ("导出菲律宾当前库存", ["PH8805"]),
        ("导出菲仓当前库存", ["PH8805"]),
        ("导出泰国仓当前库存", ["TH8802"]),
        ("导出泰国当前库存", ["TH8802"]),
        ("导出泰仓当前库存", ["TH8802"]),
        ("导出越南仓当前库存", ["VN8806"]),
        ("导出越南当前库存", ["VN8806"]),
        ("导出越仓当前库存", ["VN8806"]),
        ("导出 MY 当前库存", ["MY8801"]),
        ("导出 PH 当前库存", ["PH8805"]),
        ("导出 TH 当前库存", ["TH8802"]),
        ("导出 VN 当前库存", ["VN8806"]),
    ],
)
def test_chinese_warehouse_aliases_normalize_to_canonical_codes(
    text: str,
    expected: list[str],
) -> None:
    result = normalized(text)

    assert result["requires_clarification"] is False
    assert result["effective_request"]["warehouses"] == expected
    assert result["intent"]["warehouse_intent"] == {
        "state": "resolved",
        "values": expected,
    }


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("马来和菲律宾当前库存", ["MY8801", "PH8805"]),
        ("马来、泰国、越南当前库存", ["MY8801", "TH8802", "VN8806"]),
        ("马来西亚仓和PH8805的月度销量", ["MY8801", "PH8805"]),
        ("马来西亚仓和MY8801的月度销量", ["MY8801"]),
    ],
)
def test_chinese_and_code_warehouse_combinations_are_ordered_and_deduplicated(
    text: str,
    expected: list[str],
) -> None:
    result = normalized(text)

    assert result["requires_clarification"] is False
    assert result["effective_request"]["warehouses"] == expected


@pytest.mark.parametrize("marker", ["四仓", "四个仓", "全部仓库", "所有仓库"])
def test_all_warehouse_markers_expand_to_all_canonical_codes(marker: str) -> None:
    result = normalized(f"导出{marker}当前库存")

    assert result["requires_clarification"] is False
    assert result["effective_request"]["warehouses"] == list(WAREHOUSE_CODES)


def test_specific_alias_and_all_warehouses_remain_a_scope_conflict() -> None:
    result = normalized("导出马来仓和全部仓库当前库存")

    assert result["requires_clarification"] is True
    assert result["effective_request"] is None
    assert any(
        question["code"] == "WAREHOUSE_SCOPE_CONFLICT"
        for question in result["questions"]
    )


@pytest.mark.parametrize("text", ["导出美国仓当前库存", "导出某仓当前库存"])
def test_unrecognized_warehouse_phrases_remain_ambiguous(text: str) -> None:
    result = normalized(text)

    assert result["requires_clarification"] is True
    assert result["effective_request"] is None
    assert result["intent"]["warehouse_intent"] == {"state": "ambiguous"}


def test_inbound_warehouse_alias_is_non_failing_request_context() -> None:
    result = normalized("导出马来仓入库时间")

    assert result["requires_clarification"] is False
    assert result["effective_request"]["data_types"] == ["inbound-listing-time"]
    assert result["effective_request"]["warehouses"] == ["MY8801"]
    assert result["preflight_issues"] == []


def test_legacy_agent_candidate_aligns_with_canonical_raw_sales_signal() -> None:
    result = normalized(
        "导出近90天销量",
        data_type_intent={"state": "resolved", "values": ["sales-monthly"]},
    )

    assert result["requires_clarification"] is False
    assert result["effective_request"]["data_types"] == ["inventory-sales"]


def test_agent_warehouse_candidate_cannot_override_explicit_raw_warehouse() -> None:
    result = normalized(
        "导出 MY8801 当前库存",
        warehouse_intent={"state": "resolved", "values": ["TH8802"]},
    )

    assert result["requires_clarification"] is True
    assert any(question["code"] == "WAREHOUSE_INTENT_CONFLICT" for question in result["questions"])


def test_agent_relative_days_must_match_raw_creation_phrase() -> None:
    result = normalized(
        "导出最近7天创建商品的月度销量",
        created_date_filter={"state": "resolved", "mode": "relative_days", "days": 30},
    )

    assert result["requires_clarification"] is True
    assert any(
        question["code"] == "CREATED_DATE_INTENT_CONFLICT"
        for question in result["questions"]
    )


def test_agent_inventory_candidate_cannot_override_historical_raw_intent() -> None:
    result = normalized(
        "导出上个月月底库存",
        inventory_snapshot_intent={"state": "current"},
    )

    assert result["requires_clarification"] is False
    assert result["intent"]["inventory_snapshot_intent"] == {"state": "historical"}
    assert result["effective_request"]["data_types"] == []
    assert result["preflight_issues"][0]["code"] == "UNSUPPORTED_HISTORICAL_INVENTORY"


def test_omitted_candidate_does_not_hide_strong_raw_signal() -> None:
    result = normalized(
        "导出 MY8801 当前库存",
        data_type_intent={"state": "omitted"},
        warehouse_intent={"state": "omitted"},
    )

    assert result["effective_request"]["data_types"] == ["inventory-current-snapshot"]
    assert result["effective_request"]["warehouses"] == ["MY8801"]


@pytest.mark.parametrize(
    ("text", "kwargs", "code"),
    [
        (
            "导出当前库存",
            {"created_date_filter": {"state": "resolved", "mode": "default"}},
            "INVALID_CREATED_DATE_SCOPE",
        ),
        (
            "导出月度销量",
            {"inventory_snapshot_intent": {"state": "current"}},
            "INVALID_INVENTORY_INTENT_SCOPE",
        ),
        (
            "导出最近7天创建商品的上架时间",
            {},
            "UNSUPPORTED_INBOUND_CREATED_DATE_FILTER",
        ),
    ],
)
def test_cross_field_scope_errors_are_preflight_issues(
    text: str,
    kwargs: dict[str, Any],
    code: str,
) -> None:
    result = normalized(text, **kwargs)

    assert result["requires_clarification"] is False
    assert any(issue["code"] == code for issue in result["preflight_issues"])


def test_mixed_sales_and_inbound_keeps_shared_filters_at_request_scope_only() -> None:
    result = normalized("导出 MY8801 最近7天创建商品的月度销量和上架时间")

    assert result["effective_request"] == {
        "data_types": ["inventory-sales", "inbound-listing-time"],
        "warehouses": ["MY8801"],
        "created_date_filter": {
            "mode": "relative_days",
            "created_start_date": "2026-09-07",
            "created_end_date": "2026-09-14",
            "source": "deterministic_relative_days",
            "input_fragments": ["最近7天创建"],
            "normalization_rules": ["relative_creation_days"],
        },
    }
    assert result["preflight_issues"] == []
