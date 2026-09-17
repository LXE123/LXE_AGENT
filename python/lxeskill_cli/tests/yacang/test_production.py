from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from services.yacang.errors import YacangError
from services.yacang.production import (
    MemoryCooldownStore,
    MemoryRequestGate,
    YacangCooldownStore,
    YacangProductionGuard,
    YacangRequestGate,
    production_enabled,
)


def test_production_requires_explicit_exact_true() -> None:
    assert production_enabled({"LXE_YACANG_PROD_ENABLED": "true"})
    assert production_enabled({"LXE_YACANG_PROD_ENABLED": " TRUE "})
    assert not production_enabled({})
    assert not production_enabled({"LXE_YACANG_PROD_ENABLED": "1"})
    assert not production_enabled({
        "LXE_YACANG_MOBILE": "configured",
        "LXE_YACANG_PASSWORD": "configured",
    })


def test_disabled_guard_rejects_before_request_gate() -> None:
    gate = MemoryRequestGate()
    guard = YacangProductionGuard(
        enabled=False,
        cooldown=MemoryCooldownStore(),
        request_gate=gate,
    )

    with pytest.raises(YacangError) as caught:
        with guard.request_slot():
            raise AssertionError("request body must not run")

    assert caught.value.code == "YACANG_PROD_DISABLED"
    assert gate.entries == 0


def test_rate_limit_cooldown_persists_and_expires(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "lxeskill.sqlite3"
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(db_path))
    now = [1_000.0]

    first = YacangCooldownStore(clock=lambda: now[0])
    first.activate(900)
    second = YacangCooldownStore(clock=lambda: now[0])
    assert second.remaining_seconds() == 900

    guard = YacangProductionGuard(
        enabled=True,
        cooldown=second,
        request_gate=MemoryRequestGate(),
    )
    with pytest.raises(YacangError) as caught:
        guard.assert_allowed()
    assert caught.value.code == "YACANG_RATE_LIMIT_COOLDOWN"
    assert "900" in str(caught.value)

    now[0] = 1_901.0
    guard.assert_allowed()
    assert second.remaining_seconds() == 0

    with sqlite3.connect(db_path) as conn:
        columns = {
            str(row[1])
            for row in conn.execute("PRAGMA table_info(yacang_provider_cooldowns)")
        }
    assert columns == {"provider", "cooldown_until", "reason", "updated_at"}


def test_persistent_request_gate_serializes_processes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(tmp_path / "lxeskill.sqlite3"))
    now = [2_000.0]
    first = YacangRequestGate(clock=lambda: now[0], sleep=lambda _seconds: None)
    second = YacangRequestGate(clock=lambda: now[0], sleep=lambda _seconds: None)

    acquired, _wait = first._try_acquire("owner-one")
    assert acquired
    acquired, wait = second._try_acquire("owner-two")
    assert not acquired
    assert wait == 180.0

    first._release("owner-one")
    now[0] += 1.0
    acquired, _wait = second._try_acquire("owner-two")
    assert acquired
    second._release("owner-two")
