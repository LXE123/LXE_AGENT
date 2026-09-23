from __future__ import annotations

from services.agent_cli.mabang import brazil_overseas_export as cli
from services.mabang.brazil_overseas.contracts import BrazilExportKind
from services.mabang.brazil_overseas.workflow import BrazilOverseasWorkflowResult
from services.mabang.errors import MabangAuthError


def test_cli_returns_one_deliverable_path(monkeypatch) -> None:
    async def fake_workflow(*, warehouse: str, export_kind: str):
        assert warehouse == "brazil_overseas"
        assert export_kind == "inventory_sales_snapshot"
        return BrazilOverseasWorkflowResult(
            kind=BrazilExportKind.INVENTORY_SALES_SNAPSHOT,
            xlsx_path="/artifacts/replenish/brazil_overseas/inventory.xlsx",
            source_data_note="平台原始库存文件仅含7/28/42天累计销量",
        )

    monkeypatch.setattr(cli, "export_brazil_overseas", fake_workflow)

    result = cli.run({"warehouse": "brazil_overseas", "export_kind": "inventory_sales_snapshot"})

    assert result == {
        "success": True,
        "kind": "inventory_sales_snapshot",
        "xlsx_path": "/artifacts/replenish/brazil_overseas/inventory.xlsx",
        "warehouse_id": "1072376",
        "warehouse_label": "巴西海外仓",
        "source_data_note": "平台原始库存文件仅含7/28/42天累计销量",
        "terminal_projection": {"data": {"platform": "mabang", "business_type": "brazil_overseas_export", "export_kind": "inventory_sales_snapshot"}},
    }
    assert not ({"pending", "processing", "next_action", "retry_required"} & result.keys())


def test_cli_returns_both_document_paths(monkeypatch) -> None:
    async def fake_workflow(*, warehouse: str, export_kind: str):
        assert warehouse == "brazil_overseas"
        assert export_kind == "allocation_both"
        return BrazilOverseasWorkflowResult(
            kind=BrazilExportKind.ALLOCATION_BOTH,
            xlsx_paths=(
                "/artifacts/replenish/brazil_overseas/pending.xls",
                "/artifacts/replenish/brazil_overseas/signed.xls",
            ),
            source_data_note="马帮分仓调拨原始导出",
        )

    monkeypatch.setattr(cli, "export_brazil_overseas", fake_workflow)

    result = cli.run({"warehouse": "brazil_overseas", "export_kind": "allocation_both"})

    assert result == {
        "success": True,
        "kind": "allocation_both",
        "xlsx_paths": [
            "/artifacts/replenish/brazil_overseas/pending.xls",
            "/artifacts/replenish/brazil_overseas/signed.xls",
        ],
        "warehouse_id": "1072376",
        "warehouse_label": "巴西海外仓",
        "source_data_note": "马帮分仓调拨原始导出",
        "terminal_projection": {"data": {"platform": "mabang", "business_type": "brazil_overseas_export", "export_kind": "allocation_both"}},
    }
    assert not ({"pending", "processing", "next_action", "retry_required"} & result.keys())


def test_cli_preserves_auth_failure_without_requesting_a_retry(monkeypatch) -> None:
    async def fail_workflow(*, warehouse: str, export_kind: str):
        raise MabangAuthError("实际认证错误")

    monkeypatch.setattr(cli, "export_brazil_overseas", fail_workflow)

    result = cli.run({"warehouse": "brazil_overseas", "export_kind": "inventory_sales_snapshot"})

    assert result == {
        "success": False,
        "warehouse": "brazil_overseas",
        "export_kind": "inventory_sales_snapshot",
        "exception": "实际认证错误",
        "auth_refresh_required": False,
        "terminal_projection": {"data": {"platform": "mabang", "business_type": "brazil_overseas_export", "export_kind": "inventory_sales_snapshot"}, "error": {"code": "mabang_brazil_overseas_failed", "message": "实际认证错误"}},
    }
    assert not ({"xlsx_path", "xlsx_paths", "pending", "processing", "next_action", "retry_required"} & result.keys())


def test_cli_rejects_missing_structured_parameters() -> None:
    assert cli.run({}) == {
        "success": False,
        "warehouse": "",
        "export_kind": "",
        "exception": "warehouse 和 export_kind 不能为空",
        "auth_refresh_required": False,
        "terminal_projection": {"data": {"platform": "mabang", "business_type": "brazil_overseas_export", "export_kind": ""}, "error": {"code": "mabang_brazil_overseas_invalid", "message": "warehouse 和 export_kind 不能为空"}},
    }
