from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import ValidationError


FIXTURE_ROOT = Path(__file__).parents[1] / "packages" / "protocol" / "fixtures"


def _fixture(name: str) -> dict[str, object]:
    return json.loads((FIXTURE_ROOT / name).read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    ("contract_name", "fixture_name"),
    [
        ("inbound_event", "valid-inbound-event.json"),
        ("agent_job", "valid-agent-job.json"),
        ("emit_request", "valid-emit-request.json"),
        ("worker_envelope", "valid-worker-envelope.json"),
    ],
)
def test_valid_cross_language_fixtures_pass(
    contract_name: str,
    fixture_name: str,
) -> None:
    from shared.protocol import validate_contract

    validate_contract(contract_name, _fixture(fixture_name))


def test_invalid_worker_protocol_version_fails() -> None:
    from shared.protocol import validate_contract

    with pytest.raises(ValidationError):
        validate_contract(
            "worker_envelope",
            _fixture("invalid-worker-envelope-version.json"),
        )


def test_invalid_payload_shape_fails() -> None:
    from shared.protocol import validate_contract

    with pytest.raises(ValidationError):
        validate_contract("agent_job", _fixture("invalid-agent-job-shape.json"))
