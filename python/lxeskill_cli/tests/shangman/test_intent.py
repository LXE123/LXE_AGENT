from __future__ import annotations

import pytest

from services.shangman.intent import build_goods_export_plan


BASE_PARAMS = {
    "platform": "上马印尼",
    "country": "印尼",
    "operation": "goods_export",
}


def test_structured_params_map_to_one_goods_export_plan() -> None:
    result = build_goods_export_plan(BASE_PARAMS)

    assert result["status"] == "ready"
    assert result["params"] == BASE_PARAMS
    assert result["intent"] == {
        "type": "goods-export",
        "platform": "上马印尼",
        "country": "印尼",
        "operation": "goods_export",
        "params": BASE_PARAMS,
    }
    assert result["plan"] == {
        "type": "goods-export",
        "tasks": [{"type": "goods-export", "params": BASE_PARAMS}],
        "source_notice": "该文件保留平台原始商品导出字段，不包含逐日销量、14天销量或历史月末快照。",
    }


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("platform", "其他平台"),
        ("country", "美国"),
        ("operation", "inventory_export"),
    ],
)
def test_rejects_params_outside_the_declared_contract(field: str, value: object) -> None:
    params = dict(BASE_PARAMS)
    params[field] = value

    result = build_goods_export_plan(params)

    assert result["status"] == "blocked"
    assert result["error"]["code"] == "params_invalid"


def test_rejects_missing_or_non_object_params() -> None:
    assert build_goods_export_plan(None)["error"]["code"] == "params_invalid"
    assert build_goods_export_plan({})["error"]["code"] == "params_invalid"


def test_rejects_the_retired_wisdom_platform_label() -> None:
    result = build_goods_export_plan({**BASE_PARAMS, "platform": "智慧"})

    assert result["status"] == "blocked"
    assert result["error"]["code"] == "params_invalid"


@pytest.mark.parametrize(
    "extra",
    [
        {"requested_metrics": ["sales", "inventory"]},
        {"sales_windows_days": [7, 30]},
        {"snapshot_type": "month_end"},
        {"date_window": "90d"},
    ],
)
def test_rejects_execution_fields_that_do_not_change_the_export(extra: dict[str, object]) -> None:
    result = build_goods_export_plan({**BASE_PARAMS, **extra})

    assert result["status"] == "blocked"
    assert result["error"]["code"] == "params_invalid"
