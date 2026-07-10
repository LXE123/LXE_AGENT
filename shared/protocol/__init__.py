from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal, cast

from jsonschema import Draft202012Validator


ContractName = Literal[
    "inbound_event",
    "agent_job",
    "emit_request",
    "worker_envelope",
]

_SCHEMA_ROOT = Path(__file__).resolve().parents[2] / "packages" / "protocol" / "schemas"
_SCHEMA_FILES: dict[ContractName, str] = {
    "inbound_event": "inbound-event.schema.json",
    "agent_job": "agent-job.schema.json",
    "emit_request": "emit-request.schema.json",
    "worker_envelope": "worker-envelope.schema.json",
}


@lru_cache(maxsize=len(_SCHEMA_FILES))
def load_schema(contract_name: ContractName) -> dict[str, Any]:
    """Load one canonical JSON Schema shared with the Bun workspace."""

    try:
        schema_file = _SCHEMA_FILES[contract_name]
    except KeyError as exc:
        raise ValueError(f"unknown protocol contract: {contract_name}") from exc

    schema = json.loads((_SCHEMA_ROOT / schema_file).read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return cast(dict[str, Any], schema)


@lru_cache(maxsize=len(_SCHEMA_FILES))
def _validator(contract_name: ContractName) -> Draft202012Validator:
    return Draft202012Validator(load_schema(contract_name))


def validate_contract(contract_name: ContractName, payload: object) -> None:
    """Raise ``ValidationError`` when a protocol payload violates its contract."""

    _validator(contract_name).validate(payload)


def is_valid_contract(contract_name: ContractName, payload: object) -> bool:
    """Return whether a protocol payload conforms to its canonical schema."""

    return _validator(contract_name).is_valid(payload)


__all__ = [
    "ContractName",
    "is_valid_contract",
    "load_schema",
    "validate_contract",
]
