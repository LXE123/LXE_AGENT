from __future__ import annotations

import ast
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_runtime import loop as loop_module
from agent_runtime import tool_executor
from agent_runtime.facts import ToolExecutionFact
from agent_runtime.stream_logging import StepStreamObserver, StreamLoggingConfig
from agent_runtime.tool_executor import ToolExecutionContext
from agent_runtime.types import ContextBuildStats, StepLog, TurnLog
from gateway.heartbeat_wake import HeartbeatWakeManager
from shared.llm.events import LLMStreamEvent


_PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _records(caplog, *, level: int | None = None, marker: str = "") -> list[logging.LogRecord]:
    records = [record for record in caplog.records if record.name.startswith("agent_runtime.")]
    if level is not None:
        records = [record for record in records if record.levelno == level]
    if marker:
        records = [record for record in records if marker in record.getMessage()]
    return records


def _logger_method_for_marker(relative_path: str, marker: str) -> str:
    tree = ast.parse((_PROJECT_ROOT / relative_path).read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        if not isinstance(node.func.value, ast.Name) or node.func.value.id != "logger":
            continue
        if not node.args or not isinstance(node.args[0], ast.Constant):
            continue
        if marker in str(node.args[0].value or ""):
            return node.func.attr
    raise AssertionError(f"log marker not found: {relative_path}: {marker}")


def test_stream_frames_are_debug_but_stream_errors_remain_warning(caplog, tmp_path: Path) -> None:
    caplog.set_level(logging.DEBUG, logger="agent_runtime.stream_logging")
    observer = StepStreamObserver(
        step_idx=2,
        provider="test",
        config=StreamLoggingConfig(
            mode="trace",
            trace_enabled=False,
            heartbeat_ms=0,
            heartbeat_chars=1,
            debug_preview_chars=80,
            trace_dir=tmp_path,
        ),
        trace_writer=None,
    )

    observer.start_attempt(1)
    observer.observe(LLMStreamEvent(event_type="text_delta", text="hello", index=0))
    observer.fail_attempt(RuntimeError("provider unavailable"))

    detail_records = _records(caplog, marker="[Turn:STREAM]") + _records(caplog, marker="[Turn:SSE]")
    assert detail_records
    assert all(
        record.levelno == logging.DEBUG
        for record in detail_records
        if "phase=error" not in record.getMessage()
    )
    error_records = [record for record in detail_records if "phase=error" in record.getMessage()]
    assert len(error_records) == 1
    assert error_records[0].levelno == logging.WARNING


def test_turn_start_has_concise_info_and_detailed_debug(caplog) -> None:
    caplog.set_level(logging.DEBUG, logger="agent_runtime.loop")
    turn_log = TurnLog(
        session_id="session-secret",
        turn_id="turn-secret",
        user_input_preview="private user message",
        context_stats_before=ContextBuildStats(estimated_tokens=3200, raw_turn_count=4),
        system_prompt_tokens=1200,
        context_window_tokens=128000,
    )

    loop_module._log_turn_start(turn_log)

    info_records = _records(caplog, level=logging.INFO)
    debug_records = _records(caplog, level=logging.DEBUG)
    assert len(info_records) == 1
    assert "turn started" in info_records[0].getMessage()
    assert "message_turns=4" in info_records[0].getMessage()
    assert "private user message" not in info_records[0].getMessage()
    assert "session-secret" not in info_records[0].getMessage()
    assert any("private user message" in record.getMessage() for record in debug_records)


def test_tool_step_info_omits_arguments_but_debug_keeps_detail(caplog) -> None:
    caplog.set_level(logging.DEBUG, logger="agent_runtime.loop")
    step = StepLog(
        step=3,
        event="tool_call",
        tool_name="read",
        tool_args={"path": "/private/workbook.xlsx"},
        llm_latency_ms=125,
        llm_input_tokens=200,
        llm_output_tokens=40,
    )

    loop_module._log_step(step)

    info_records = _records(caplog, level=logging.INFO)
    debug_records = _records(caplog, level=logging.DEBUG)
    assert len(info_records) == 1
    assert "tool started" in info_records[0].getMessage()
    assert "tool=read" in info_records[0].getMessage()
    assert "args=" not in info_records[0].getMessage()
    assert any("args=" in record.getMessage() for record in debug_records)


def test_turn_end_is_one_info_summary_with_debug_context_detail(caplog) -> None:
    caplog.set_level(logging.DEBUG, logger="agent_runtime.loop")
    turn_log = TurnLog(
        status="done",
        elapsed_ms=4200,
        steps=[StepLog(step=0, event="tool_call", tool_name="read")],
        total_input_tokens=2000,
        total_output_tokens=300,
        total_llm_calls=2,
        total_tool_calls=1,
        tools_used=["read"],
        context_stats_before=ContextBuildStats(estimated_tokens=3000),
        context_stats_after=ContextBuildStats(estimated_tokens=3400),
        context_window_tokens=128000,
    )

    loop_module._log_turn_end(turn_log)

    info_records = _records(caplog, level=logging.INFO)
    debug_records = _records(caplog, level=logging.DEBUG)
    assert len(info_records) == 1
    summary = info_records[0].getMessage()
    assert "turn completed" in summary
    assert "status=done" in summary
    assert "elapsed=4200ms" in summary
    assert "tools=1" in summary
    assert any("context_after=" in record.getMessage() for record in debug_records)


def test_heartbeat_queue_bookkeeping_is_debug(caplog) -> None:
    class FakeScheduler:
        pass

    async def scenario() -> None:
        manager = HeartbeatWakeManager(scheduler=FakeScheduler())  # type: ignore[arg-type]
        try:
            await manager.request_now(session_id="session-1", reason="exec-event")
            await manager.request_now(session_id="session-1", reason="exec-event")
        finally:
            await manager.stop()

    import asyncio

    caplog.set_level(logging.DEBUG, logger="gateway.heartbeat_wake")
    asyncio.run(scenario())

    records = [record for record in caplog.records if record.name == "gateway.heartbeat_wake"]
    assert records
    assert all(record.levelno == logging.DEBUG for record in records)


def test_browser_tool_arguments_and_success_details_are_debug(monkeypatch, caplog) -> None:
    async def fake_execute_browser_tool(**_kwargs):
        return {}, ToolExecutionFact(tool_name="browser_test", success=True, summary="browser step complete")

    import agent_runtime.packs.browser.tools as browser_tools

    monkeypatch.setattr(tool_executor, "_execute_browser_tool", fake_execute_browser_tool)
    monkeypatch.setattr(
        browser_tools,
        "build_browser_tool_call",
        lambda **kwargs: SimpleNamespace(name=kwargs["name"], arguments=kwargs["arguments"]),
    )
    tool_executor.set_tool_context(ToolExecutionContext(session=object(), state_data={}))
    caplog.set_level(logging.DEBUG, logger="agent_runtime.tool_executor")
    try:
        import asyncio

        asyncio.run(tool_executor.make_browser_tool_handler("browser_test")(token="secret"))
    finally:
        tool_executor.clear_tool_context()

    detail_records = [
        record
        for record in caplog.records
        if record.name == "agent_runtime.tool_executor"
        and ("[ToolCall]" in record.getMessage() or "[ToolResult]" in record.getMessage())
    ]
    assert detail_records
    assert all(record.levelno == logging.DEBUG for record in detail_records)


@pytest.mark.parametrize(
    ("relative_path", "marker", "expected_method"),
    [
        ("agent_runtime/tools/process_sessions.py", "notify skipped:", "debug"),
        ("agent_runtime/tools/process_sessions.py", "notify start:", "debug"),
        ("agent_runtime/tools/process_sessions.py", "event enqueued:", "debug"),
        ("agent_runtime/tools/process_sessions.py", "wake requested:", "debug"),
        ("agent_runtime/tools/process_sessions.py", "notify done:", "debug"),
        ("agent_runtime/tools/process_sessions.py", "completion consumed:", "debug"),
        ("agent_runtime/tools/process_sessions.py", "exec started:", "debug"),
        ("agent_runtime/tools/process_sessions.py", "exec finished:", "debug"),
        ("agent_runtime/tools/process_sessions.py", "process started:", "info"),
        ("agent_runtime/tools/process_sessions.py", "process finished:", "info"),
        ("agent_runtime/turn_handler.py", "heartbeat start:", "debug"),
        ("agent_runtime/turn_handler.py", "heartbeat popped events:", "debug"),
        ("agent_runtime/turn_handler.py", "heartbeat noop:", "debug"),
        ("agent_runtime/turn_handler.py", "heartbeat prompt ready:", "debug"),
        ("agent_runtime/loop.py", "[Turn:TRACE]", "debug"),
        ("agent_runtime/skill_index.py", "skipping external skill", "debug"),
        ("agent_runtime/skill_index.py", "[SkillIndex] loaded", "debug"),
        ("platforms/feishu/cardkit_sender.py", "CardKit card created", "debug"),
        ("platforms/feishu/cardkit_sender.py", "CardKit stream message sent", "debug"),
        ("gateway/session_router.py", "[SessionRouter] inbound event", "debug"),
        ("gateway/session_router.py", "rebound session source", "debug"),
        ("gateway/session_router.py", "created session:", "debug"),
        ("gateway/app.py", "execute agent job inline", "debug"),
        ("agent_runtime/packs/browser/executor.py", "clicked element:", "debug"),
        ("agent_runtime/tools/feishu_im_tools.py", "raw message dump skipped", "debug"),
        ("agent_runtime/tools/feishu_im_tools.py", "raw message dump saved", "debug"),
        ("agent_runtime/tools/feishu_im_tools.py", "downloaded resource:", "debug"),
        ("agent_runtime/tools/coding_tools.py", "normalized project Python command", "debug"),
    ],
)
def test_diagnostic_markers_use_expected_level(relative_path: str, marker: str, expected_method: str) -> None:
    assert _logger_method_for_marker(relative_path, marker) == expected_method
