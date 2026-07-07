from __future__ import annotations

import re

from agent_runtime.types import StepLog, TurnLog
from agent_runtime.usage_stats import (
    SkillCommandIndex,
    build_skill_command_index,
    collect_turn_usage,
)


def _index() -> SkillCommandIndex:
    signature = "services.agent_cli.mabang.calculate_store_msku_replenishment"
    resolve_signature = "services.agent_cli.mabang.resolve_fba_store"
    return SkillCommandIndex(
        dirs={
            "replenishment-calculate": ("replenishment-calculate", "amazon_replenish"),
            "replenishment-store-resolve": ("replenishment-store-resolve", "amazon_replenish"),
            "dws": ("dws", "lark"),
        },
        commands=[
            (
                signature,
                "replenishment-calculate",
                "amazon_replenish",
                re.compile(rf"(?<![\w.]){re.escape(signature)}(?![\w.])"),
            ),
            (
                resolve_signature,
                "replenishment-store-resolve",
                "amazon_replenish",
                re.compile(rf"(?<![\w.]){re.escape(resolve_signature)}(?![\w.])"),
            ),
        ],
    )


def _turn_log(steps: list[StepLog], *, started_at: float = 1000.0) -> TurnLog:
    log = TurnLog(session_id="s1", turn_id="t1", started_at=started_at, steps=steps)
    log.finalize("done")
    return log


def test_activation_dedupes_repeated_skill_md_reads() -> None:
    steps = [
        StepLog(step=0, event="tool_call", tool_name="read",
                tool_args={"path": "skills/replenishment-calculate/SKILL.md"}),
        StepLog(step=0, event="tool_result", tool_name="read", success=True, duration_ms=5),
        StepLog(step=1, event="tool_call", tool_name="read",
                tool_args={"path": "skills\\replenishment-calculate\\SKILL.md"}),
        StepLog(step=1, event="tool_result", tool_name="read", success=True, duration_ms=5),
    ]
    report = collect_turn_usage(_turn_log(steps), index=_index())
    assert [a.skill for a in report.activations] == ["replenishment-calculate"]
    assert report.executions == []


def test_execution_counts_every_run_and_attributes_to_owner() -> None:
    calc = "uv run --frozen python -m services.agent_cli.mabang.calculate_store_msku_replenishment --store-name A"
    resolve = "uv run --frozen python -m services.agent_cli.mabang.resolve_fba_store --store-name A"
    steps = [
        StepLog(step=0, event="tool_call", tool_name="exec", tool_args={"command": resolve}),
        StepLog(step=0, event="tool_result", tool_name="exec", tool_args={"command": resolve},
                success=True, duration_ms=100),
        StepLog(step=1, event="tool_call", tool_name="exec", tool_args={"command": calc}),
        StepLog(step=1, event="tool_error", tool_name="exec", tool_args={"command": calc},
                success=False, duration_ms=50),
        StepLog(step=2, event="tool_call", tool_name="exec", tool_args={"command": calc}),
        StepLog(step=2, event="tool_result", tool_name="exec", tool_args={"command": calc},
                success=True, duration_ms=200),
    ]
    report = collect_turn_usage(_turn_log(steps), index=_index())
    by_skill = {}
    for execution in report.executions:
        by_skill.setdefault(execution.skill, []).append(execution)
    assert len(by_skill["replenishment-store-resolve"]) == 1
    calc_runs = by_skill["replenishment-calculate"]
    assert len(calc_runs) == 2
    assert sorted(run.success for run in calc_runs) == [False, True]


def test_execution_matches_skill_scripts_path() -> None:
    command = 'uv run --frozen python "skills/dws/scripts/bitable_import.py" --dry-run'
    steps = [
        StepLog(step=0, event="tool_call", tool_name="exec", tool_args={"command": command}),
        StepLog(step=0, event="tool_result", tool_name="exec", tool_args={"command": command},
                success=True, duration_ms=10),
    ]
    report = collect_turn_usage(_turn_log(steps), index=_index())
    assert len(report.executions) == 1
    assert report.executions[0].skill == "dws"


def test_signature_matching_requires_module_boundary() -> None:
    command = "python -m services.agent_cli.mabang.resolve_fba_store_v2 --x"
    steps = [
        StepLog(step=0, event="tool_call", tool_name="exec", tool_args={"command": command}),
        StepLog(step=0, event="tool_result", tool_name="exec", tool_args={"command": command},
                success=True, duration_ms=10),
    ]
    report = collect_turn_usage(_turn_log(steps), index=_index())
    assert report.executions == []


def test_tool_usage_aggregation() -> None:
    steps = [
        StepLog(step=0, event="tool_call", tool_name="read", tool_args={"path": "a.txt"}),
        StepLog(step=0, event="tool_result", tool_name="read", success=True, duration_ms=3),
        StepLog(step=1, event="tool_call", tool_name="exec", tool_args={"command": "ls"}),
        StepLog(step=1, event="tool_error", tool_name="exec", tool_args={"command": "ls"},
                success=False, duration_ms=7),
    ]
    report = collect_turn_usage(_turn_log(steps), index=_index())
    tools = {tool.name: tool for tool in report.tools}
    assert tools["read"].calls == 1 and tools["read"].errors == 0 and tools["read"].duration_ms == 3
    assert tools["exec"].calls == 1 and tools["exec"].errors == 1 and tools["exec"].duration_ms == 7


def test_real_skill_index_builds_and_owns_resolve_store() -> None:
    index = build_skill_command_index()
    owners = {sig: skill for sig, skill, _module, _matcher in index.commands}
    assert owners["services.agent_cli.mabang.resolve_fba_store"] == "replenishment-store-resolve"
    assert "replenishment-calculate" in index.dirs


def test_sqlite_roundtrip(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(tmp_path / "stats.sqlite3"))
    from shared.db.sqlite import bootstrap, usage_stats as db_usage

    bootstrap.init_schema()
    steps = [
        StepLog(step=0, event="tool_call", tool_name="read",
                tool_args={"path": "skills/replenishment-calculate/SKILL.md"}),
        StepLog(step=0, event="tool_result", tool_name="read", success=True, duration_ms=5),
        StepLog(
            step=1, event="tool_call", tool_name="exec",
            tool_args={"command": "python -m services.agent_cli.mabang.calculate_store_msku_replenishment"},
        ),
        StepLog(
            step=1, event="tool_result", tool_name="exec",
            tool_args={"command": "python -m services.agent_cli.mabang.calculate_store_msku_replenishment"},
            success=True, duration_ms=1200,
        ),
    ]
    import time

    report = collect_turn_usage(_turn_log(steps, started_at=time.time()), index=_index())
    db_usage.record_turn_usage(report.to_record())
    # idempotent re-record must not duplicate items
    db_usage.record_turn_usage(report.to_record())

    skills = {row["name"]: row for row in db_usage.skill_usage_stats(days=7)}
    calc = skills["replenishment-calculate"]
    assert calc["activations"] == 1
    assert calc["executions"] == 1
    assert calc["failures"] == 0
    assert calc["execution_turns"] == 1
    assert calc["module"] == "amazon_replenish"

    overview = db_usage.usage_overview(days=7)
    assert overview["totals"]["turns"] == 1
    assert overview["totals"]["skill_executions"] == 1
    assert overview["modules"][0]["module"] == "amazon_replenish"
    assert len(overview["daily"]) == 1

    tools = {row["name"]: row for row in db_usage.tool_usage_stats(days=7)}
    assert tools["exec"]["calls"] == 1
    assert tools["read"]["calls"] == 1

    detail = db_usage.skill_usage_detail("replenishment-calculate", days=7)
    assert detail["daily"][0]["executions"] == 1
    assert detail["recent_failures"] == []

    exported = db_usage.export_turn_usage(days=7)
    assert len(exported) == 1
    turn = exported[0]
    assert turn["turn_id"] == "t1"
    assert turn["session_id"] == "s1"
    kinds = sorted(item["kind"] for item in turn["items"])
    assert kinds == ["skill_activation", "skill_execution", "tool", "tool"]
    execution_item = next(item for item in turn["items"] if item["kind"] == "skill_execution")
    assert execution_item["name"] == "replenishment-calculate"
    assert execution_item["module"] == "amazon_replenish"
    assert execution_item["errors"] == 0
    assert execution_item["detail"] == "services.agent_cli.mabang.calculate_store_msku_replenishment"


def test_snapshot_includes_turn_usage(tmp_path, monkeypatch) -> None:
    import time

    monkeypatch.setenv("LXE_SQLITE_DB_PATH", str(tmp_path / "snapshot.sqlite3"))
    from shared.db.sqlite import bootstrap, usage_stats as db_usage
    from shared.data_server.snapshot import build_agent_snapshot

    bootstrap.init_schema()
    steps = [
        StepLog(step=0, event="tool_call", tool_name="exec",
                tool_args={"command": "python -m services.agent_cli.mabang.resolve_fba_store"}),
        StepLog(step=0, event="tool_result", tool_name="exec",
                tool_args={"command": "python -m services.agent_cli.mabang.resolve_fba_store"},
                success=True, duration_ms=80),
    ]
    report = collect_turn_usage(_turn_log(steps, started_at=time.time()), index=_index())
    db_usage.record_turn_usage(report.to_record())

    snapshot = build_agent_snapshot(machine_id="machine-test", usage_days=7)
    usage = snapshot["turn_usage"]
    assert usage["days"] == 7
    assert len(usage["turns"]) == 1
    assert usage["turns"][0]["turn_id"] == "t1"
    assert any(item["kind"] == "skill_execution" for item in usage["turns"][0]["items"])
