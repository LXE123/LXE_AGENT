from __future__ import annotations

import importlib
import inspect
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
