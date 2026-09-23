from __future__ import annotations

import math
from datetime import date

import pytest

import services.agent_cli.yacang.export_workflow as workflow_adapter
from services.agent_cli.yacang.export_inbound_listing_time import run as run_inbound
from services.agent_cli.yacang.export_inventory_month_end import run as run_inventory
from services.agent_cli.yacang.export_inventory_sales import run as run_inventory_sales
from services.agent_cli.yacang.export_sales_monthly import run as run_sales_monthly
from services.agent_cli.yacang.export_workflow import run as run_workflow


_STRUCTURED_ARGUMENTS = {
    "data_type_intent": {"state": "resolved", "values": ["inventory-sales"]},
    "warehouse_intent": {"state": "resolved", "values": ["MY8801"]},
    "created_date_filter": {"state": "resolved", "mode": "default"},
    "inventory_snapshot_intent": {"state": "omitted"},
}


def _projected_result(monkeypatch, result: dict) -> dict:
    monkeypatch.setattr(workflow_adapter, "run_export_workflow", lambda *args, **kwargs: result)
    return workflow_adapter.run(dict(_STRUCTURED_ARGUMENTS))


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


def test_structured_cli_accepts_ai_intent_without_raw_request_text() -> None:
    result = run_workflow({
        "data_type_intent": {"state": "ambiguous"},
        "warehouse_intent": {"state": "omitted"},
        "created_date_filter": {"state": "omitted"},
        "inventory_snapshot_intent": {"state": "omitted"},
    })

    assert result["success"] is False
    assert result["overall_status"] == "needs_clarification"
    assert result["questions"][0]["code"] == "DATA_TYPE_REQUIRED"


def test_internal_compatibility_adapter_still_accepts_request_text() -> None:
    result = run_workflow({"request_text": "最近卖得怎么样"})

    assert result["success"] is False
    assert result["overall_status"] == "needs_clarification"
    assert result["questions"][0]["code"] == "AMBIGUOUS_SALES_TYPE"


def test_yacang_terminal_projection_hides_full_success_payload(monkeypatch) -> None:
    result = _projected_result(monkeypatch, {
        "schema_version": "1",
        "overall_status": "success",
        "tasks": [{
            "task_id": "inventory-sales:MY8801",
            "data_type": "inventory-sales",
            "warehouse": "MY8801",
            "status": "success",
            "effective_parameters": {"created_start_date": "2026-09-22"},
        }],
        "artifacts": [{"path": "/safe/inventory.xlsx"}],
        "questions": [],
        "diagnostics": [],
    })

    assert result["success"] is True
    assert result["terminal_projection"] == {
        "data": {
            "platform": "yacang",
            "business_type": "export",
            "status": "success",
            "partial": False,
            "file_count": 1,
        },
    }
    assert "tasks" not in result["terminal_projection"]["data"]
    assert "effective_parameters" not in result["terminal_projection"]["data"]


def test_yacang_terminal_projection_preserves_partial_files_and_failed_tasks(monkeypatch) -> None:
    result = _projected_result(monkeypatch, {
        "schema_version": "1",
        "overall_status": "partial_success",
        "tasks": [
            {
                "task_id": "inventory-sales:MY8801",
                "data_type": "inventory-sales",
                "warehouse": "MY8801",
                "status": "success",
                "effective_parameters": {"created_start_date": "2026-09-22"},
            },
            {
                "task_id": "inventory-sales:PH8805",
                "data_type": "inventory-sales",
                "warehouse": "PH8805",
                "status": "failed",
                "effective_parameters": {"created_start_date": "2026-09-22"},
                "diagnostic_codes": ["YACANG_RATE_LIMITED"],
            },
        ],
        "artifacts": [{"path": "/safe/inventory-MY8801.xlsx"}],
        "questions": [],
        "diagnostics": [],
    })

    assert result["success"] is False
    assert result["terminal_projection"] == {
        "data": {
            "platform": "yacang",
            "business_type": "export",
            "status": "partial_success",
            "partial": True,
            "file_count": 1,
            "failed_tasks": [{
                "task_id": "inventory-sales:PH8805",
                "data_type": "inventory-sales",
                "warehouse": "PH8805",
                "status": "failed",
                "error_code": "YACANG_RATE_LIMITED",
            }],
        },
        "error": {
            "code": "yacang_partial_success",
            "message": "雅仓导出部分任务成功，部分任务失败",
        },
    }


def test_yacang_terminal_projection_preserves_failure_summary(monkeypatch) -> None:
    result = _projected_result(monkeypatch, {
        "schema_version": "1",
        "overall_status": "failed",
        "tasks": [{
            "task_id": "inventory-sales:VN8806",
            "data_type": "inventory-sales",
            "warehouse": "VN8806",
            "status": "failed",
            "diagnostic_codes": ["YACANG_FORBIDDEN"],
            "effective_parameters": {"created_start_date": "2026-09-22"},
        }],
        "artifacts": [],
        "questions": [],
        "diagnostics": [{
            "task_id": "inventory-sales:VN8806",
            "code": "YACANG_FORBIDDEN",
            "message": "remote access forbidden",
        }],
    })

    assert result["success"] is False
    assert result["terminal_projection"]["data"]["partial"] is False
    assert result["terminal_projection"]["data"]["failed_tasks"] == [{
        "task_id": "inventory-sales:VN8806",
        "data_type": "inventory-sales",
        "warehouse": "VN8806",
        "status": "failed",
        "error_code": "YACANG_FORBIDDEN",
    }]
    assert result["terminal_projection"]["error"] == {
        "code": "YACANG_FORBIDDEN",
        "message": "remote access forbidden",
    }


def test_yacang_terminal_projection_keeps_clarification_questions(monkeypatch) -> None:
    result = _projected_result(monkeypatch, {
        "schema_version": "1",
        "overall_status": "needs_clarification",
        "tasks": [],
        "artifacts": [],
        "questions": [{"code": "DATA_TYPE_REQUIRED", "message": "请选择数据类型"}],
        "diagnostics": [],
    })

    assert result["success"] is False
    assert result["terminal_projection"] == {
        "data": {
            "platform": "yacang",
            "business_type": "export",
            "status": "needs_clarification",
            "partial": False,
            "file_count": 0,
            "questions": [{"code": "DATA_TYPE_REQUIRED", "message": "请选择数据类型"}],
        },
        "error": {
            "code": "yacang_needs_clarification",
            "message": "雅仓导出需要澄清业务意图",
        },
    }


def test_structured_cli_rejects_singular_value_shape_before_execution() -> None:
    result = run_workflow({
        "data_type_intent": {"state": "resolved", "value": "inventory-sales"},
        "warehouse_intent": {"state": "omitted"},
        "created_date_filter": {"state": "omitted"},
        "inventory_snapshot_intent": {"state": "omitted"},
    })

    assert result["success"] is False
    assert result["overall_status"] == "failed"
    assert result["diagnostics"][0]["code"] == "VALUEERROR"
    assert "不允许字段 value" in result["diagnostics"][0]["message"]
    assert "缺少字段 values" in result["diagnostics"][0]["message"]
