"""Persistence and aggregate queries for per-turn skill/tool usage stats.

``record_turn_usage`` consumes the plain-dict record produced by
``agent_runtime.usage_stats.TurnUsageReport.to_record()``. Item kinds:

- ``tool``: one row per tool per turn (calls/errors/duration aggregated)
- ``skill_activation``: one row per skill per turn
- ``skill_execution``: one row per execution (calls=1, errors 0/1)
"""
from __future__ import annotations

import time
from typing import Any

from .engine import connection_scope

KIND_TOOL = "tool"
KIND_SKILL_ACTIVATION = "skill_activation"
KIND_SKILL_EXECUTION = "skill_execution"

_MAX_DAYS = 365


def _clean_int(value: Any, *, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _cutoff_ts(days: int) -> float:
    safe_days = max(1, min(_clean_int(days, default=30), _MAX_DAYS))
    return time.time() - safe_days * 86400.0


def record_turn_usage(record: dict[str, Any] | None) -> None:
    data = dict(record or {})
    turn_id = str(data.get("turn_id") or "").strip()
    if not turn_id:
        return
    session_id = str(data.get("session_id") or "").strip()
    started_at = float(data.get("started_at") or 0.0) or time.time()

    items: list[tuple[str, str, str, int, int, int, str]] = []
    for tool in list(data.get("tools") or []):
        entry = dict(tool or {})
        name = str(entry.get("name") or "").strip()
        if not name:
            continue
        items.append(
            (
                KIND_TOOL,
                name,
                "",
                _clean_int(entry.get("calls")),
                _clean_int(entry.get("errors")),
                _clean_int(entry.get("duration_ms")),
                "",
            )
        )
    for activation in list(data.get("activations") or []):
        entry = dict(activation or {})
        skill = str(entry.get("skill") or "").strip()
        if not skill:
            continue
        items.append((KIND_SKILL_ACTIVATION, skill, str(entry.get("module") or ""), 1, 0, 0, ""))
    for execution in list(data.get("executions") or []):
        entry = dict(execution or {})
        skill = str(entry.get("skill") or "").strip()
        if not skill:
            continue
        items.append(
            (
                KIND_SKILL_EXECUTION,
                skill,
                str(entry.get("module") or ""),
                1,
                0 if bool(entry.get("success")) else 1,
                _clean_int(entry.get("duration_ms")),
                str(entry.get("command") or ""),
            )
        )

    with connection_scope() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            """
            INSERT OR REPLACE INTO turn_usage
                (turn_id, session_id, started_at, status, elapsed_ms,
                 llm_calls, tool_calls, input_tokens, output_tokens)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                turn_id,
                session_id,
                started_at,
                str(data.get("status") or ""),
                _clean_int(data.get("elapsed_ms")),
                _clean_int(data.get("llm_calls")),
                _clean_int(data.get("tool_calls")),
                _clean_int(data.get("input_tokens")),
                _clean_int(data.get("output_tokens")),
            ),
        )
        conn.execute("DELETE FROM turn_usage_items WHERE turn_id = ?", (turn_id,))
        conn.executemany(
            """
            INSERT INTO turn_usage_items
                (turn_id, session_id, started_at, kind, name, module,
                 calls, errors, duration_ms, detail)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            [(turn_id, session_id, started_at, *item) for item in items],
        )


def export_turn_usage(*, days: int = 30, turn_limit: int = 5000) -> list[dict[str, Any]]:
    """Recent turn usage with nested items, shaped for the data-server snapshot."""
    cutoff = _cutoff_ts(days)
    safe_turn_limit = max(1, min(_clean_int(turn_limit, default=5000), 50000))
    with connection_scope() as conn:
        turn_rows = conn.execute(
            """
            SELECT turn_id, session_id, started_at, status, elapsed_ms,
                   llm_calls, tool_calls, input_tokens, output_tokens
            FROM turn_usage
            WHERE started_at >= ?
            ORDER BY started_at ASC
            LIMIT ?
            """,
            (cutoff, safe_turn_limit),
        ).fetchall()
        turns: dict[str, dict[str, Any]] = {}
        for row in turn_rows:
            turn_id = str(row["turn_id"] or "")
            turns[turn_id] = {
                "turn_id": turn_id,
                "session_id": str(row["session_id"] or ""),
                "started_at": float(row["started_at"] or 0.0),
                "status": str(row["status"] or ""),
                "elapsed_ms": _clean_int(row["elapsed_ms"]),
                "llm_calls": _clean_int(row["llm_calls"]),
                "tool_calls": _clean_int(row["tool_calls"]),
                "input_tokens": _clean_int(row["input_tokens"]),
                "output_tokens": _clean_int(row["output_tokens"]),
                "items": [],
            }
        if turns:
            item_rows = conn.execute(
                """
                SELECT turn_id, kind, name, module, calls, errors, duration_ms, detail
                FROM turn_usage_items
                WHERE started_at >= ?
                ORDER BY item_id ASC
                """,
                (cutoff,),
            ).fetchall()
            for row in item_rows:
                turn = turns.get(str(row["turn_id"] or ""))
                if turn is None:
                    continue
                turn["items"].append(
                    {
                        "kind": str(row["kind"] or ""),
                        "name": str(row["name"] or ""),
                        "module": str(row["module"] or ""),
                        "calls": _clean_int(row["calls"]),
                        "errors": _clean_int(row["errors"]),
                        "duration_ms": _clean_int(row["duration_ms"]),
                        "detail": str(row["detail"] or ""),
                    }
                )
    return list(turns.values())


def usage_overview(*, days: int = 30) -> dict[str, Any]:
    cutoff = _cutoff_ts(days)
    with connection_scope() as conn:
        totals_row = conn.execute(
            """
            SELECT COUNT(*) AS turns,
                   COALESCE(SUM(tool_calls), 0) AS tool_calls,
                   COALESCE(SUM(llm_calls), 0) AS llm_calls,
                   COALESCE(SUM(input_tokens), 0) AS input_tokens,
                   COALESCE(SUM(output_tokens), 0) AS output_tokens,
                   COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error_turns
            FROM turn_usage WHERE started_at >= ?
            """,
            (cutoff,),
        ).fetchone()
        exec_row = conn.execute(
            """
            SELECT COALESCE(SUM(calls), 0) AS executions,
                   COALESCE(SUM(errors), 0) AS failures
            FROM turn_usage_items
            WHERE kind = ? AND started_at >= ?
            """,
            (KIND_SKILL_EXECUTION, cutoff),
        ).fetchone()
        module_rows = conn.execute(
            """
            SELECT module,
                   COUNT(DISTINCT name) AS skills,
                   COUNT(DISTINCT turn_id) AS turns,
                   COALESCE(SUM(calls), 0) AS executions,
                   COALESCE(SUM(errors), 0) AS failures,
                   COALESCE(SUM(duration_ms), 0) AS duration_ms
            FROM turn_usage_items
            WHERE kind = ? AND started_at >= ?
            GROUP BY module
            ORDER BY executions DESC, module ASC
            """,
            (KIND_SKILL_EXECUTION, cutoff),
        ).fetchall()
        daily_rows = conn.execute(
            """
            SELECT date(started_at, 'unixepoch', 'localtime') AS day,
                   COUNT(*) AS turns,
                   COALESCE(SUM(tool_calls), 0) AS tool_calls
            FROM turn_usage
            WHERE started_at >= ?
            GROUP BY day
            ORDER BY day ASC
            """,
            (cutoff,),
        ).fetchall()
        daily_exec_rows = conn.execute(
            """
            SELECT date(started_at, 'unixepoch', 'localtime') AS day,
                   COALESCE(SUM(calls), 0) AS executions,
                   COALESCE(SUM(errors), 0) AS failures
            FROM turn_usage_items
            WHERE kind = ? AND started_at >= ?
            GROUP BY day
            ORDER BY day ASC
            """,
            (KIND_SKILL_EXECUTION, cutoff),
        ).fetchall()

    executions_by_day = {row["day"]: row for row in daily_exec_rows}
    daily = []
    for row in daily_rows:
        exec_entry = executions_by_day.get(row["day"])
        daily.append(
            {
                "day": row["day"],
                "turns": _clean_int(row["turns"]),
                "tool_calls": _clean_int(row["tool_calls"]),
                "executions": _clean_int(exec_entry["executions"]) if exec_entry else 0,
                "failures": _clean_int(exec_entry["failures"]) if exec_entry else 0,
            }
        )
    return {
        "days": max(1, min(_clean_int(days, default=30), _MAX_DAYS)),
        "totals": {
            "turns": _clean_int(totals_row["turns"]),
            "error_turns": _clean_int(totals_row["error_turns"]),
            "tool_calls": _clean_int(totals_row["tool_calls"]),
            "llm_calls": _clean_int(totals_row["llm_calls"]),
            "input_tokens": _clean_int(totals_row["input_tokens"]),
            "output_tokens": _clean_int(totals_row["output_tokens"]),
            "skill_executions": _clean_int(exec_row["executions"]),
            "skill_failures": _clean_int(exec_row["failures"]),
        },
        "modules": [
            {
                "module": str(row["module"] or ""),
                "skills": _clean_int(row["skills"]),
                "turns": _clean_int(row["turns"]),
                "executions": _clean_int(row["executions"]),
                "failures": _clean_int(row["failures"]),
                "duration_ms": _clean_int(row["duration_ms"]),
            }
            for row in module_rows
        ],
        "daily": daily,
    }


def skill_usage_stats(*, days: int = 30) -> list[dict[str, Any]]:
    cutoff = _cutoff_ts(days)
    with connection_scope() as conn:
        rows = conn.execute(
            """
            SELECT name,
                   MAX(module) AS module,
                   COALESCE(SUM(CASE WHEN kind = ? THEN calls ELSE 0 END), 0) AS activations,
                   COALESCE(SUM(CASE WHEN kind = ? THEN calls ELSE 0 END), 0) AS executions,
                   COALESCE(SUM(CASE WHEN kind = ? THEN errors ELSE 0 END), 0) AS failures,
                   COUNT(DISTINCT CASE WHEN kind = ? THEN turn_id END) AS execution_turns,
                   COALESCE(SUM(CASE WHEN kind = ? THEN duration_ms ELSE 0 END), 0) AS duration_ms,
                   MAX(started_at) AS last_used_at
            FROM turn_usage_items
            WHERE kind IN (?, ?) AND started_at >= ?
            GROUP BY name
            ORDER BY executions DESC, activations DESC, name ASC
            """,
            (
                KIND_SKILL_ACTIVATION,
                KIND_SKILL_EXECUTION,
                KIND_SKILL_EXECUTION,
                KIND_SKILL_EXECUTION,
                KIND_SKILL_EXECUTION,
                KIND_SKILL_ACTIVATION,
                KIND_SKILL_EXECUTION,
                cutoff,
            ),
        ).fetchall()
    return [
        {
            "name": str(row["name"] or ""),
            "module": str(row["module"] or ""),
            "activations": _clean_int(row["activations"]),
            "executions": _clean_int(row["executions"]),
            "failures": _clean_int(row["failures"]),
            "execution_turns": _clean_int(row["execution_turns"]),
            "duration_ms": _clean_int(row["duration_ms"]),
            "last_used_at": float(row["last_used_at"] or 0.0),
        }
        for row in rows
    ]


def skill_usage_detail(name: str, *, days: int = 30, failure_limit: int = 10) -> dict[str, Any]:
    safe_name = str(name or "").strip()
    cutoff = _cutoff_ts(days)
    safe_failure_limit = max(1, min(_clean_int(failure_limit, default=10), 50))
    with connection_scope() as conn:
        daily_rows = conn.execute(
            """
            SELECT date(started_at, 'unixepoch', 'localtime') AS day,
                   COALESCE(SUM(CASE WHEN kind = ? THEN calls ELSE 0 END), 0) AS activations,
                   COALESCE(SUM(CASE WHEN kind = ? THEN calls ELSE 0 END), 0) AS executions,
                   COALESCE(SUM(CASE WHEN kind = ? THEN errors ELSE 0 END), 0) AS failures
            FROM turn_usage_items
            WHERE name = ? AND kind IN (?, ?) AND started_at >= ?
            GROUP BY day
            ORDER BY day ASC
            """,
            (
                KIND_SKILL_ACTIVATION,
                KIND_SKILL_EXECUTION,
                KIND_SKILL_EXECUTION,
                safe_name,
                KIND_SKILL_ACTIVATION,
                KIND_SKILL_EXECUTION,
                cutoff,
            ),
        ).fetchall()
        failure_rows = conn.execute(
            """
            SELECT turn_id, session_id, started_at, detail
            FROM turn_usage_items
            WHERE name = ? AND kind = ? AND errors > 0 AND started_at >= ?
            ORDER BY started_at DESC
            LIMIT ?
            """,
            (safe_name, KIND_SKILL_EXECUTION, cutoff, safe_failure_limit),
        ).fetchall()
    return {
        "name": safe_name,
        "daily": [
            {
                "day": row["day"],
                "activations": _clean_int(row["activations"]),
                "executions": _clean_int(row["executions"]),
                "failures": _clean_int(row["failures"]),
            }
            for row in daily_rows
        ],
        "recent_failures": [
            {
                "turn_id": str(row["turn_id"] or ""),
                "session_id": str(row["session_id"] or ""),
                "started_at": float(row["started_at"] or 0.0),
                "command": str(row["detail"] or ""),
            }
            for row in failure_rows
        ],
    }


def tool_usage_stats(*, days: int = 30) -> list[dict[str, Any]]:
    cutoff = _cutoff_ts(days)
    with connection_scope() as conn:
        rows = conn.execute(
            """
            SELECT name,
                   COALESCE(SUM(calls), 0) AS calls,
                   COALESCE(SUM(errors), 0) AS errors,
                   COALESCE(SUM(duration_ms), 0) AS duration_ms,
                   COUNT(DISTINCT turn_id) AS turns,
                   MAX(started_at) AS last_used_at
            FROM turn_usage_items
            WHERE kind = ? AND started_at >= ?
            GROUP BY name
            ORDER BY calls DESC, name ASC
            """,
            (KIND_TOOL, cutoff),
        ).fetchall()
    return [
        {
            "name": str(row["name"] or ""),
            "calls": _clean_int(row["calls"]),
            "errors": _clean_int(row["errors"]),
            "duration_ms": _clean_int(row["duration_ms"]),
            "turns": _clean_int(row["turns"]),
            "last_used_at": float(row["last_used_at"] or 0.0),
        }
        for row in rows
    ]


__all__ = [
    "KIND_SKILL_ACTIVATION",
    "KIND_SKILL_EXECUTION",
    "KIND_TOOL",
    "export_turn_usage",
    "record_turn_usage",
    "skill_usage_detail",
    "skill_usage_stats",
    "tool_usage_stats",
    "usage_overview",
]
