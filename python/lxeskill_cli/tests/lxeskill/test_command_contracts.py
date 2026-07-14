from __future__ import annotations

import importlib
import inspect
from dataclasses import dataclass
from typing import Any

import pytest

from lxeskill.business import load_catalog


def _command(entry: dict[str, Any]) -> str:
    return " ".join(str(part) for part in entry["command_path"])


def _module_entries() -> tuple[dict[str, Any], ...]:
    return tuple(
        entry
        for entry in load_catalog().values()
        if str(entry.get("module") or "").strip()
    )


MODULE_ENTRIES = _module_entries()
PARAMETERIZED_MODULE_COMMANDS = frozenset(_command(entry) for entry in MODULE_ENTRIES)


def _schema_value(name: str, schema: dict[str, Any]) -> Any:
    if schema.get("enum"):
        return schema["enum"][0]
    value_type = schema.get("type")
    if isinstance(value_type, list):
        value_type = value_type[0]
    if value_type == "array":
        return [_schema_value(name, dict(schema.get("items") or {}))]
    if value_type == "number":
        return 0.3
    if value_type == "integer":
        return 1
    if value_type == "boolean":
        return True
    if value_type == "object":
        return {}
    if name == "delivery_no":
        return "SP260508022"
    if name == "ship_no":
        return "SP260226004"
    if name == "store_name":
        return "Contract-Test"
    return f"contract-{name}"


def _required_cases() -> tuple[tuple[dict[str, Any], str, dict[str, Any]], ...]:
    cases: list[tuple[dict[str, Any], str, dict[str, Any]]] = []
    for entry in MODULE_ENTRIES:
        schema = dict(entry.get("input_schema") or {})
        properties = dict(schema.get("properties") or {})
        required = [str(name) for name in schema.get("required") or []]
        for missing in required:
            arguments = {
                name: _schema_value(name, dict(properties.get(name) or {}))
                for name in required
                if name != missing
            }
            cases.append((entry, missing, arguments))
    return tuple(cases)


REQUIRED_CASES = _required_cases()

# These stage adapters intentionally retain their established workflow envelope.
# The catalog/schema discrepancy is recorded in docs/record rather than hidden by
# accepting arbitrary false-like fields for every business command.
KNOWN_REQUIRED_FAILURE_FLAGS = {
    "fba shipment confirm-own-carrier": "params_ready",
    "fba shipment enter-tracking-codes": "params_ready",
    "fba shipment prepare-multi-box": "params_ready",
    "fba shipment prepare-upload": "params_ready",
}


@dataclass(frozen=True)
class FailureCase:
    arguments: dict[str, Any]
    expected_context: dict[str, Any]
    exception_fragment: str
    patch_target: str | None = None
    patch_exception: str | None = None


FAILURE_CASES = {
    "fba stock-sku download": (
        FailureCase({}, {"delivery_no": ""}, "delivery_no 不能为空"),
        FailureCase(
            {"delivery_no": "FBA123"},
            {"delivery_no": "FBA123"},
            "delivery_no 格式无效: FBA123",
        ),
    ),
    "fba shipment delivery-csv-download": (
        FailureCase({}, {"delivery_no": ""}, "delivery_no 不能为空"),
        FailureCase(
            {"delivery_no": "FBA123"},
            {"delivery_no": "FBA123"},
            "delivery_no 格式无效: FBA123",
        ),
        FailureCase(
            {"delivery_no": "SP260508022"},
            {"delivery_no": "SP260508022"},
            "download failed for SP260508022",
            "download_fba_delivery_csv",
            "download failed for SP260508022",
        ),
    ),
    "fba export-tax delivery-summary": (
        FailureCase({}, {"delivery_no": ""}, "delivery_no 不能为空"),
        FailureCase(
            {"delivery_no": "FBA123"},
            {"delivery_no": "FBA123"},
            "delivery_no 格式无效: FBA123",
        ),
    ),
    "fba msku detail-download": (
        FailureCase({}, {"ship_no": ""}, "ship_no 不能为空"),
        FailureCase(
            {"ship_no": "FBA123"},
            {"ship_no": "FBA123"},
            "ship_no 格式无效: FBA123",
        ),
        FailureCase(
            {"ship_no": "SP260414001"},
            {"ship_no": "SP260414001"},
            "download failed for SP260414001",
            "download_msku_detail_excel",
            "download failed for SP260414001",
        ),
    ),
    "fba shipment wms-box-download": (
        FailureCase({}, {"ship_no": ""}, "ship_no 不能为空"),
        FailureCase(
            {"ship_no": "FBA123"},
            {"ship_no": "FBA123"},
            "ship_no 格式无效: FBA123",
        ),
        FailureCase(
            {"ship_no": "SP260226004"},
            {"ship_no": "SP260226004"},
            "WMS failed for SP260226004",
            "download_consignment_excel_from_wms",
            "WMS failed for SP260226004",
        ),
    ),
    "replenish inventory restock-snapshot-build": (
        FailureCase({}, {"store_name": ""}, "store_name 不能为空"),
    ),
    "replenish msku download": (
        FailureCase(
            {"store_id": "697456821", "id_type": "shopId"},
            {"store_name": "", "store_id": "697456821", "id_type": "shopId"},
            "store_name 不能为空",
        ),
        FailureCase(
            {
                "store_id": "697456821",
                "id_type": "shopId",
                "store_name": "Amazon-Lerxiuer-FR",
            },
            {
                "store_name": "Amazon-Lerxiuer-FR",
                "store_id": "697456821",
                "id_type": "shopId",
            },
            "download failed for 697456821",
            "download_store_msku_excel",
            "download failed for 697456821",
        ),
    ),
    "replenish calculate": (
        FailureCase({}, {"store_name": ""}, "store_name 不能为空"),
    ),
    "replenish sales analyze": (
        FailureCase({}, {"store_name": ""}, "store_name 不能为空"),
    ),
    "replenish inventory actual-export": (
        FailureCase({}, {"store_name": ""}, "store_name 不能为空"),
    ),
    "replenish shipments unlinked-download": (
        FailureCase({}, {"store_name": ""}, "store_name 不能为空"),
        FailureCase(
            {"store_name": "Amazon-Test-US"},
            {"store_name": "Amazon-Test-US"},
            "download failed for Amazon-Test-US",
            "download_store_unlinked_shipments",
            "download failed for Amazon-Test-US",
        ),
    ),
}

FAILURE_CASE_PARAMS = tuple(
    pytest.param(command, case, id=f"{command}-{index}")
    for command, cases in FAILURE_CASES.items()
    for index, case in enumerate(cases, start=1)
)


@pytest.mark.parametrize("entry", MODULE_ENTRIES, ids=_command)
def test_catalog_module_exposes_exact_run_contract(entry: dict[str, Any]) -> None:
    module = importlib.import_module(str(entry["module"]))
    run = getattr(module, "run", None)

    assert callable(run), f"{_command(entry)} has no callable run"
    signature = inspect.signature(run)
    assert tuple(signature.parameters) == ("arguments",)
    parameter = signature.parameters["arguments"]
    assert parameter.kind is inspect.Parameter.POSITIONAL_OR_KEYWORD
    assert parameter.default is inspect.Parameter.empty


@pytest.mark.parametrize(
    ("entry", "missing", "arguments"),
    REQUIRED_CASES,
    ids=lambda value: _command(value) if isinstance(value, dict) and "command_path" in value else str(value),
)
def test_catalog_required_field_missing_returns_failure(
    entry: dict[str, Any],
    missing: str,
    arguments: dict[str, Any],
) -> None:
    module = importlib.import_module(str(entry["module"]))
    result = module.run(arguments)

    assert isinstance(result, dict), f"{_command(entry)} missing {missing} returned {type(result).__name__}"
    command = _command(entry)
    known_flag = KNOWN_REQUIRED_FAILURE_FLAGS.get(command)
    if known_flag:
        assert result.get(known_flag) is False
        return
    failure_flags = [key for key in ("success", "ok") if key in result]
    assert failure_flags, f"{command} missing {missing} returned no success/ok flag: {result}"
    assert all(result[key] is False for key in failure_flags)


def test_catalog_module_contract_parameterization_is_complete() -> None:
    catalog_module_commands = {
        _command(entry)
        for entry in load_catalog().values()
        if str(entry.get("module") or "").strip()
    }
    assert catalog_module_commands <= PARAMETERIZED_MODULE_COMMANDS


@pytest.mark.parametrize(
    ("command", "case"),
    FAILURE_CASE_PARAMS,
)
def test_command_failure_contract(
    command: str,
    case: FailureCase,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    entries_by_command = {_command(entry): entry for entry in MODULE_ENTRIES}
    entry = entries_by_command[command]
    module = importlib.import_module(str(entry["module"]))
    if case.patch_target:
        error_message = case.patch_exception or case.exception_fragment

        async def fail_download(*_args: Any, **_kwargs: Any) -> Any:
            raise RuntimeError(error_message)

        monkeypatch.setattr(module, case.patch_target, fail_download)

    result = module.run(dict(case.arguments))

    assert isinstance(result, dict)
    assert result.get("success") is False
    for key, expected in case.expected_context.items():
        assert result.get(key) == expected
    assert case.exception_fragment in str(result.get("exception") or "")
