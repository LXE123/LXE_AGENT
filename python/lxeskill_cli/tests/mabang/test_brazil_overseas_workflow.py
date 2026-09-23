from __future__ import annotations

import asyncio

import pytest

from services.mabang.brazil_overseas import workflow
from services.mabang.brazil_overseas.allocation import BrazilOverseasAllocationExportResult
from services.mabang.brazil_overseas.contracts import BrazilExportKind
from services.mabang.brazil_overseas.inventory import BrazilOverseasInventoryExportResult


def test_routes_structured_inventory_parameters(monkeypatch) -> None:
    calls: list[dict] = []

    async def fake_inventory_export(**kwargs):
        calls.append(kwargs)
        return BrazilOverseasInventoryExportResult(xlsx_path="/artifacts/replenish/brazil_overseas/inventory.xlsx")

    monkeypatch.setattr(workflow, "export_brazil_overseas_inventory_sales_snapshot", fake_inventory_export)

    result = asyncio.run(workflow.export_brazil_overseas(warehouse="brazil_overseas", export_kind=BrazilExportKind.INVENTORY_SALES_SNAPSHOT.value))

    assert result.kind is BrazilExportKind.INVENTORY_SALES_SNAPSHOT
    assert result.xlsx_path == "/artifacts/replenish/brazil_overseas/inventory.xlsx"
    assert result.source_data_note == "平台原始库存文件仅含7/28/42天累计销量"
    assert calls == [{}]


@pytest.mark.parametrize(
    ("kind", "expected_path"),
    [
        (BrazilExportKind.ALLOCATION_SIGNED_BEFORE_3M, "/artifacts/replenish/brazil_overseas/signed.xlsx"),
        (BrazilExportKind.ALLOCATION_PENDING_DEFAULT_3M, "/artifacts/replenish/brazil_overseas/pending.xlsx"),
    ],
)
def test_routes_allocation_parameters_to_matching_export(monkeypatch, kind, expected_path) -> None:
    calls: list[tuple[BrazilExportKind, dict]] = []

    async def fake_allocation_export(actual_kind: BrazilExportKind, **kwargs):
        calls.append((actual_kind, kwargs))
        return BrazilOverseasAllocationExportResult(kind=actual_kind, xlsx_path=expected_path)

    monkeypatch.setattr(workflow, "export_brazil_overseas_allocation", fake_allocation_export)

    result = asyncio.run(workflow.export_brazil_overseas(warehouse="brazil_overseas", export_kind=kind.value))

    assert result.kind is kind
    assert result.xlsx_path == expected_path
    assert calls == [(kind, {})]


def test_routes_unspecified_documents_to_pending_and_signed_exports(monkeypatch) -> None:
    calls: list[BrazilExportKind] = []
    paths = {
        BrazilExportKind.ALLOCATION_PENDING_DEFAULT_3M: "/artifacts/replenish/brazil_overseas/pending.xls",
        BrazilExportKind.ALLOCATION_SIGNED_BEFORE_3M: "/artifacts/replenish/brazil_overseas/signed.xls",
    }

    async def fake_allocation_export(kind: BrazilExportKind, **_kwargs):
        calls.append(kind)
        return BrazilOverseasAllocationExportResult(kind=kind, xlsx_path=paths[kind])

    monkeypatch.setattr(workflow, "export_brazil_overseas_allocation", fake_allocation_export)

    result = asyncio.run(
        workflow.export_brazil_overseas(
            warehouse="brazil_overseas",
            export_kind=BrazilExportKind.ALLOCATION_BOTH.value,
        )
    )

    assert result.kind is BrazilExportKind.ALLOCATION_BOTH
    assert result.xlsx_path == ""
    assert result.xlsx_paths == (
        "/artifacts/replenish/brazil_overseas/pending.xls",
        "/artifacts/replenish/brazil_overseas/signed.xls",
    )
    assert calls == [
        BrazilExportKind.ALLOCATION_PENDING_DEFAULT_3M,
        BrazilExportKind.ALLOCATION_SIGNED_BEFORE_3M,
    ]


def test_returns_actionable_clarification_without_calling_erp() -> None:
    with pytest.raises(workflow.BrazilOverseasRequestClarificationError) as raised:
        asyncio.run(workflow.export_brazil_overseas(warehouse="brazil_overseas", export_kind="unknown"))
    assert raised.value.code == "brazil_export_kind_required"
