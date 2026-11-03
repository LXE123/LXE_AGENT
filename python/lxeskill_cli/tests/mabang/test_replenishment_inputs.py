"""Shipment parsing and aggregation use actual files, including mixed valid/bad rows."""
import pytest

from replenishment_cases import STORE, write_table
from services.mabang.amazon.fba import unlinked_shipments as shipments


@pytest.mark.parametrize("raw", [True, False], ids=["download", "snapshot"])
@pytest.mark.parametrize("quantity", [None, "", True, "invalid", "NaN", "Infinity", -1])
def test_invalid_quantity_is_not_silently_treated_as_zero(tmp_path, raw, quantity):
    field = "MSKU发货量" if raw else "未关联数量"
    path = write_table(tmp_path / "shipments.xlsx", [
        {"店铺": STORE, "MSKU": "GOOD", field: 17}, {"店铺": STORE, "MSKU": "BAD", field: quantity},
    ], sheet="原始下载" if raw else "未关联货件汇总")
    with pytest.raises(shipments.UnlinkedShipmentError) as error:
        if raw:
            shipments.build_store_unlinked_shipments_snapshot([path], store_name=STORE, output_dir=tmp_path / "out")
        else:
            shipments.load_unlinked_shipment_quantities(path, store_name=STORE)
    assert all(value in str(error.value) for value in ("BAD", field, str(path)))
    assert not list((tmp_path / "out").glob("*.xlsx"))


def test_zero_and_fractional_shipments_survive_aggregation(tmp_path):
    path = write_table(tmp_path / "raw.xlsx", [
        {"店铺": STORE, "MSKU": msku, "MSKU发货量": quantity}
        for msku, quantity in (("ZERO", 0), ("ZERO", "0"), ("SUM", 17), ("SUM", "2.5"))
    ])
    result = shipments.build_store_unlinked_shipments_snapshot([path], store_name=STORE, output_dir=tmp_path / "out")
    assert result.total_unlinked_quantity == 19.5 and not result.confirmed_empty
    assert shipments.load_unlinked_shipment_quantities(result.snapshot_xlsx_path, store_name=STORE) == {"ZERO": 0, "SUM": 19.5}
