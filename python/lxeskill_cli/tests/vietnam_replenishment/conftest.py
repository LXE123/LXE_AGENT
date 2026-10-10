"""Vietnam calculation tests must never fetch production ERP data."""
import pytest
from services.yacang import workflow as yacang_workflow


@pytest.fixture(autouse=True)
def forbid_implicit_erp_export(monkeypatch):
    def unexpected(*args, **kwargs):
        pytest.fail("Vietnam calculation must consume local reports, never export ERP data")
    monkeypatch.setattr(yacang_workflow, "run", unexpected)
