from openpyxl import Workbook
import pytest

from services.yacang import validation
from services.yacang.errors import YacangError


@pytest.mark.parametrize("validator,kwargs", [
    (validation.validate_inventory_sales_workbook, {"warehouse_code": "MY8801"}),
    (validation.validate_inventory_list_workbook, {"warehouse_code": "MY8801"}),
    (validation.validate_warehouse_products_workbook, {}),
])
@pytest.mark.parametrize("invalid", ["headers", "multiple_sheets", "truncated"])
def test_validation_failure_releases_file_while_traceback_is_retained(tmp_path, validator, kwargs, invalid):
    path = tmp_path / "invalid.xlsx"
    workbook = Workbook()
    workbook.active.append(["invalid header"])
    if invalid == "multiple_sheets":
        workbook.create_sheet("extra")
    workbook.save(path)
    workbook.close()
    if invalid == "truncated":
        path.write_bytes(path.read_bytes()[:100])
    with pytest.raises(YacangError) as caught:
        validator(path, **kwargs)
    assert caught.value.__traceback__ is not None
    # Windows rejects these operations if any parser/ZIP handle is still open.
    moved = path.with_name("moved.xlsx")
    path.rename(moved)
    moved.unlink()
