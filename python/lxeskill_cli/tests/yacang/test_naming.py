from __future__ import annotations

import pytest

from services.yacang.naming import (
    YacangExportKind,
    business_name,
    export_filename,
    inventory_sales_filename,
    safe_windows_component,
)


def test_monthly_sales_filename_uses_business_name_and_warehouse() -> None:
    assert export_filename(
        YacangExportKind.SALES_MONTHLY,
        warehouse_code="MY8801",
        file_date="2026-09-13",
    ) == "雅仓系统-库存动销_马来西亚仓_2026-09-13.xlsx"


def test_all_planned_business_names_are_centralized() -> None:
    assert business_name(YacangExportKind.INVENTORY_SALES) == "雅仓系统-库存动销"
    assert business_name(YacangExportKind.SALES_90D) == "雅仓系统-库存动销"
    assert business_name(YacangExportKind.INVENTORY_CURRENT_SNAPSHOT) == "雅仓系统-库存列表"
    assert business_name(YacangExportKind.INBOUND_LISTING_TIME) == "雅仓系统-产品-仓库产品"
    assert export_filename(
        YacangExportKind.SALES_90D,
        warehouse_code="MY8801",
        file_date="2026-09-13",
    ) == "雅仓系统-库存动销_马来西亚仓_2026-09-13.xlsx"
    assert inventory_sales_filename(
        ["TH8802", "MY8801"],
        file_date="2026-09-13",
    ) == "雅仓系统-库存动销_马来西亚仓-泰国仓_2026-09-13.xlsx"
    assert inventory_sales_filename(
        ["MY8801", "PH8805", "TH8802", "VN8806"],
        file_date="2026-09-13",
    ) == "雅仓系统-库存动销_四仓_2026-09-13.xlsx"
    assert export_filename(
        YacangExportKind.INVENTORY_CURRENT_SNAPSHOT,
        warehouse_code="MY8801",
        file_date="2026-09-13",
    ) == "雅仓系统-库存列表_马来西亚仓_2026-09-13.xlsx"
    assert YacangExportKind.INVENTORY_MONTH_END is YacangExportKind.INVENTORY_CURRENT_SNAPSHOT
    assert export_filename(
        YacangExportKind.INBOUND_LISTING_TIME,
        file_date="2026-09-13",
    ) == "雅仓系统-产品-仓库产品_2026-09-13.xlsx"


def test_filename_contract_rejects_wrong_business_dimensions() -> None:
    with pytest.raises(ValueError, match="固定输出完整库存动销字段"):
        business_name(YacangExportKind.SALES_MONTHLY, range_days=7)
    with pytest.raises(ValueError, match="必须指定 warehouse_code"):
        export_filename(YacangExportKind.SALES_90D, file_date="2026-09-13")
    with pytest.raises(ValueError, match="不接受 warehouse_code"):
        export_filename(
            YacangExportKind.INBOUND_LISTING_TIME,
            warehouse_code="MY8801",
            file_date="2026-09-13",
        )


@pytest.mark.parametrize("value", ["..", "../escape", "folder..name"])
def test_filename_component_rejects_dotdot_path_traversal(value: str) -> None:
    with pytest.raises(ValueError, match=r"不得包含 \.\."):
        safe_windows_component(value)


@pytest.mark.parametrize("character", ['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
def test_filename_component_strips_windows_forbidden_characters(character: str) -> None:
    assert safe_windows_component(f"safe{character}name") == "safename"
