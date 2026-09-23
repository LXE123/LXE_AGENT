from __future__ import annotations

import math
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager
from typing import Callable, Iterator, Mapping, Protocol

from services.yacang.errors import YacangError
from shared.db.sqlite.engine import connection_scope


PRODUCTION_ENABLED_ENV = "LXE_YACANG_PROD_ENABLED"
RATE_LIMIT_COOLDOWN_SECONDS = 15 * 60
MINIMUM_REQUEST_INTERVAL_SECONDS = 1.0
REQUEST_LEASE_SECONDS = 180.0
REQUEST_GATE_WAIT_SECONDS = 185.0


def production_enabled(environment: Mapping[str, str] | None = None) -> bool:
    env = os.environ if environment is None else environment
    return str(env.get(PRODUCTION_ENABLED_ENV) or "").strip().lower() == "true"


class CooldownBackend(Protocol):
    def remaining_seconds(self) -> int: ...

    def activate(self, seconds: int = RATE_LIMIT_COOLDOWN_SECONDS) -> int: ...


class RequestGateBackend(Protocol):
    @contextmanager
    def slot(self) -> Iterator[None]: ...


class YacangCooldownStore:
    """Persist only provider cooldown metadata in the Python-owned CLI database."""

    def __init__(self, *, clock: Callable[[], float] = time.time) -> None:
        self.clock = clock

    @staticmethod
    def _ensure_schema(conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS yacang_provider_cooldowns (
                provider TEXT PRIMARY KEY,
                cooldown_until INTEGER NOT NULL,
                reason TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """
        )

    def remaining_seconds(self) -> int:
        now = int(self.clock())
        with connection_scope() as conn:
            self._ensure_schema(conn)
            row = conn.execute(
                "SELECT cooldown_until FROM yacang_provider_cooldowns WHERE provider = ?",
                ("yacang",),
            ).fetchone()
            if row is None:
                return 0
            remaining = int(row["cooldown_until"]) - now
            if remaining <= 0:
                conn.execute(
                    "DELETE FROM yacang_provider_cooldowns WHERE provider = ?",
                    ("yacang",),
                )
                return 0
            return remaining

    def activate(self, seconds: int = RATE_LIMIT_COOLDOWN_SECONDS) -> int:
        now = int(self.clock())
        until = now + int(seconds)
        with connection_scope() as conn:
            self._ensure_schema(conn)
            conn.execute(
                """
                INSERT INTO yacang_provider_cooldowns(provider, cooldown_until, reason, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(provider) DO UPDATE SET
                    cooldown_until = MAX(cooldown_until, excluded.cooldown_until),
                    reason = excluded.reason,
                    updated_at = excluded.updated_at
                """,
                ("yacang", until, "rate_limited", now),
            )
        return until


class MemoryCooldownStore:
    def __init__(self, *, clock: Callable[[], float] = time.time) -> None:
        self.clock = clock
        self.cooldown_until = 0

    def remaining_seconds(self) -> int:
        return max(0, self.cooldown_until - int(self.clock()))

    def activate(self, seconds: int = RATE_LIMIT_COOLDOWN_SECONDS) -> int:
        self.cooldown_until = max(self.cooldown_until, int(self.clock()) + int(seconds))
        return self.cooldown_until


class YacangRequestGate:
    """Serialize production requests across processes using the existing CLI DB."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], None] = time.sleep,
        minimum_interval_seconds: float = MINIMUM_REQUEST_INTERVAL_SECONDS,
        lease_seconds: float = REQUEST_LEASE_SECONDS,
        max_wait_seconds: float = REQUEST_GATE_WAIT_SECONDS,
    ) -> None:
        self.clock = clock
        self.sleep = sleep
        self.minimum_interval_seconds = float(minimum_interval_seconds)
        self.lease_seconds = float(lease_seconds)
        self.max_wait_seconds = float(max_wait_seconds)

    @staticmethod
    def _ensure_schema(conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS yacang_request_gate (
                provider TEXT PRIMARY KEY,
                owner TEXT NOT NULL,
                lease_until REAL NOT NULL,
                next_allowed_at REAL NOT NULL,
                updated_at REAL NOT NULL
            )
            """
        )

    def _try_acquire(self, owner: str) -> tuple[bool, float]:
        now = float(self.clock())
        with connection_scope() as conn:
            self._ensure_schema(conn)
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT owner, lease_until, next_allowed_at FROM yacang_request_gate WHERE provider = ?",
                ("yacang",),
            ).fetchone()
            if row is None:
                conn.execute(
                    """
                    INSERT INTO yacang_request_gate(
                        provider, owner, lease_until, next_allowed_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    ("yacang", owner, now + self.lease_seconds, now, now),
                )
                return True, 0.0
            locked_by = str(row["owner"] or "")
            lease_until = float(row["lease_until"] or 0)
            next_allowed_at = float(row["next_allowed_at"] or 0)
            if (not locked_by or lease_until <= now) and next_allowed_at <= now:
                conn.execute(
                    """
                    UPDATE yacang_request_gate
                    SET owner = ?, lease_until = ?, updated_at = ?
                    WHERE provider = ?
                    """,
                    (owner, now + self.lease_seconds, now, "yacang"),
                )
                return True, 0.0
            wait_until = max(
                next_allowed_at,
                lease_until if locked_by and lease_until > now else now,
            )
            return False, max(0.05, wait_until - now)

    def _release(self, owner: str) -> None:
        now = float(self.clock())
        with connection_scope() as conn:
            self._ensure_schema(conn)
            conn.execute(
                """
                UPDATE yacang_request_gate
                SET owner = '', lease_until = 0,
                    next_allowed_at = MAX(next_allowed_at, ?), updated_at = ?
                WHERE provider = ? AND owner = ?
                """,
                (now + self.minimum_interval_seconds, now, "yacang", owner),
            )

    @contextmanager
    def slot(self) -> Iterator[None]:
        owner = uuid.uuid4().hex
        started = float(self.clock())
        while True:
            acquired, wait_seconds = self._try_acquire(owner)
            if acquired:
                break
            elapsed = float(self.clock()) - started
            if elapsed + wait_seconds > self.max_wait_seconds:
                raise YacangError(
                    "生产请求串行化",
                    "等待全局雅仓请求锁超时，未发出网络请求",
                    code="YACANG_REQUEST_GATE_TIMEOUT",
                    scope="global",
                )
            self.sleep(min(wait_seconds, 1.0))
        try:
            yield
        finally:
            self._release(owner)


class MemoryRequestGate:
    def __init__(self) -> None:
        self.entries = 0

    @contextmanager
    def slot(self) -> Iterator[None]:
        self.entries += 1
        yield


class YacangProductionGuard:
    def __init__(
        self,
        *,
        enabled: bool | None = None,
        cooldown: CooldownBackend | None = None,
        request_gate: RequestGateBackend | None = None,
    ) -> None:
        self.enabled = production_enabled() if enabled is None else bool(enabled)
        self.cooldown = cooldown or YacangCooldownStore()
        self.request_gate = request_gate or YacangRequestGate()

    def assert_allowed(self) -> None:
        if not self.enabled:
            raise YacangError(
                "生产访问检查",
                f"未显式设置 {PRODUCTION_ENABLED_ENV}=true，已拒绝真实雅仓请求",
                code="YACANG_PROD_DISABLED",
                scope="global",
            )
        remaining = self.cooldown.remaining_seconds()
        if remaining > 0:
            raise YacangError(
                "生产访问检查",
                f"雅仓仍处于 rate_limited cooldown，剩余 {math.ceil(remaining)} 秒",
                code="YACANG_RATE_LIMIT_COOLDOWN",
                http_status=429,
                scope="global",
            )

    def activate_rate_limit(self) -> None:
        self.cooldown.activate(RATE_LIMIT_COOLDOWN_SECONDS)

    @contextmanager
    def request_slot(self) -> Iterator[None]:
        self.assert_allowed()
        with self.request_gate.slot():
            self.assert_allowed()
            yield


__all__ = [
    "PRODUCTION_ENABLED_ENV",
    "RATE_LIMIT_COOLDOWN_SECONDS",
    "MemoryCooldownStore",
    "MemoryRequestGate",
    "YacangCooldownStore",
    "YacangProductionGuard",
    "YacangRequestGate",
    "production_enabled",
]
