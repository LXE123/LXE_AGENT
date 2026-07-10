from __future__ import annotations

import asyncio

from tests.gateway_core_parity import build_fixture


def test_gateway_core_parity_fixture_is_deterministic_and_complete() -> None:
    first = asyncio.run(build_fixture())
    second = asyncio.run(build_fixture())

    assert first == second
    assert set(first) == {"env", "permission", "sessions", "router", "scheduler"}
    assert first["scheduler"]["worker_lifecycle"]["before_completion"] == ["turn.start.result"]
    assert first["scheduler"]["worker_lifecycle"]["after_completion"][-1] == "runtime.turn.completed"
