from __future__ import annotations

import math
from datetime import date

import pytest

from services.agent_cli.yacang.export_inbound_listing_time import run as run_inbound
from services.agent_cli.yacang.export_inventory_month_end import run as run_inventory
from services.agent_cli.yacang.export_inventory_sales import run as run_inventory_sales
from services.agent_cli.yacang.export_sales_monthly import run as run_sales_monthly
from services.agent_cli.yacang.export_workflow import run as run_workflow


@pytest.mark.parametrize(
    "forbidden",
    ["url", "headers", "task_type", "param_where", "oss_url", "token", "cookie"],
)
def test_low_level_http_arguments_are_rejected_by_cli(forbidden: str) -> None:
    result = run_inventory_sales({
        "start_date": "2026-09-01",
        "end_date": "2026-09-13",
        forbidden: "must-not-pass",
    })
    assert result["success"] is False
    assert result["error_type"] == "ValueError"
    assert "不允许的雅仓参数" in result["exception"]


@pytest.mark.parametrize("value", [float("nan"), float("inf"), -1, 1, 31, 601])
def test_retry_and_polling_controls_have_hard_cli_bounds(value: float) -> None:
    arguments = {
        "start_date": "2026-09-01",
        "end_date": "2026-09-13",
        "poll_interval_seconds": value,
    }
    if math.isfinite(value) and 2 <= value <= 30:
        pytest.skip("inside allowed poll interval")
    result = run_inventory_sales(arguments)
    assert result["success"] is False
    assert result["error_type"] == "ValueError"


def test_inbound_listing_time_rejects_warehouse_and_sales_window() -> None:
    for arguments in ({"warehouse": "MY8801"}, {"range_days": 15}):
        result = run_inbound(arguments)
        assert result["success"] is False
        assert "不允许的雅仓参数" in result["exception"]


def test_monthly_sales_window_is_fixed_and_not_llm_selectable() -> None:
    result = run_sales_monthly({"range_days": 15})
    assert result["success"] is False
    assert "不允许的雅仓参数" in result["exception"]


def test_inventory_warehouse_allowlist_is_enforced_before_production() -> None:
    result = run_inventory({"warehouse": "UNKNOWN", "as_of_date": date.today().isoformat()})
    assert result["success"] is False
    assert "warehouse 必须是" in result["exception"]


def test_invalid_date_is_rejected_before_production() -> None:
    result = run_inventory_sales({"start_date": "not-a-date", "end_date": "2026-09-13"})
    assert result["success"] is False
    assert "YYYY-MM-DD" in result["exception"]


@pytest.mark.parametrize(
    "forbidden",
    ["url", "headers", "token", "cookie", "authorization", "oss_url", "task_type", "param_where"],
)
def test_unified_natural_language_cli_rejects_low_level_arguments(forbidden: str) -> None:
    result = run_workflow({
        "request_text": "导出当前库存",
        forbidden: "must-not-pass",
    })

    assert result["success"] is False
    assert result["diagnostics"][0]["code"] == "VALUEERROR"
    assert "不允许的雅仓参数" in result["diagnostics"][0]["message"]
