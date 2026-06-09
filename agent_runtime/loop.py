"""Unified ReAct agent loop with turn-based context management."""
from __future__ import annotations

import copy
import time
import traceback
from typing import Any, Awaitable, Callable, Literal
from uuid import uuid4

from shared.llm.transports.wire_trace import WireTraceContext, load_wire_trace_config, wire_trace_turn_dir
from shared.llm.errors import LLMProviderError
from shared.logging import logger

from .context_pipeline import (
    append_messages_to_state,
    apply_message_history_limit,
    build_llm_messages,
    build_system_prompt,
    estimate_tokens,
    is_context_overflow_error,
    make_assistant_content_message,
    make_assistant_text_message,
    make_tool_results_message,
    make_user_message,
    maybe_compact_history,
    prune_processed_history_images,
    prune_tool_results,
)
from .llm_adapter import LLMResponse, LLMStreamEvent, agent_provider_descriptor, chat_with_tools_streaming
from .stream_logging import (
    StepStreamObserver,
    TurnTraceWriter,
    format_log_payload_preview,
    load_stream_logging_config,
)
from .tool_executor import ToolExecutionContext, clear_tool_context, set_tool_context
from .tool_registry import (
    UnifiedToolRegistry,
    ensure_all_tools_registered,
    get_registry,
)
from .types import (
    ContextBuildStats,
    StepLog,
    StreamStepSummary,
    ToolResult,
    TurnInput,
    TurnLog,
    TurnOutcome,
    tool_content_preview_text,
)


ProgressCallback = Callable[[str], Awaitable[None]]
FinalTextCallback = Callable[[str], Awaitable[None]]
StreamCancelCallback = Callable[[], Awaitable[None]]

MAX_STEPS = 50
_LLM_STEP_TIMEOUT_S = 25
_LLM_STEP_MAX_ATTEMPTS = 3
_TOOL_TRACEBACK_HEAD_CHARS = 2000
_TOOL_TRACEBACK_TAIL_CHARS = 1000
_LLM_ERROR_REPLY = "LLM 通信连续失败，请稍后重试。"
_DEFAULT_EMPTY_REPLY = "我不确定该如何继续。"
_MAX_STEPS_TERMINAL_REPLY = "本轮已达到最大步骤，请发送下一条消息继续。"
_INTERRUPTED_TOOL_RESULT = "[The conversation was interrupted before this tool could finish.]"


class _TurnCancelledError(RuntimeError):
    pass


def _model_context_window() -> int:
    """Return the context window size for the current model (re-uses context_pipeline logic)."""
    try:
        from .context_pipeline import _model_context_window_tokens
        return _model_context_window_tokens()
    except Exception:
        return 128000


def _active_tool_names(*, tool_registry: UnifiedToolRegistry) -> list[str]:
    return sorted(tool_registry.all_names())


def _tool_traceback_excerpt(error: BaseException) -> str:
    try:
        formatted = "".join(
            traceback.format_exception(type(error), error, error.__traceback__)
        ).strip()
    except Exception:
        formatted = ""
    if not formatted:
        formatted = f"{type(error).__name__}: {error}".strip() or "Unknown tool error"
    max_len = _TOOL_TRACEBACK_HEAD_CHARS + _TOOL_TRACEBACK_TAIL_CHARS
    if len(formatted) <= max_len:
        return formatted
    omitted = len(formatted) - max_len
    head = formatted[:_TOOL_TRACEBACK_HEAD_CHARS]
    tail = formatted[-_TOOL_TRACEBACK_TAIL_CHARS:]
    return f"{head}\n...[omitted {omitted} chars]...\n{tail}"


def _tool_exception_observation(tool_name: str, error: BaseException) -> str:
    safe_tool_name = str(tool_name or "").strip() or "unknown_tool"
    excerpt = _tool_traceback_excerpt(error)
    return f"工具执行失败: {safe_tool_name}\n\nTraceback (excerpt):\n{excerpt}"


def _record_llm_usage(step_log: StepLog, response: LLMResponse) -> None:
    usage = dict(getattr(response, "usage", None) or {})
    step_log.llm_input_tokens = int(usage.get("input_tokens") or 0)
    step_log.llm_output_tokens = int(usage.get("output_tokens") or 0)
    step_log.llm_latency_ms = int(getattr(response, "latency_ms", 0) or 0)


def _stream_summary_suffix(summary: StreamStepSummary | None) -> str:
    if summary is None or summary.attempts <= 0:
        return ""
    return (
        f" attempts={summary.attempts}"
        f" stop={summary.stop_reason or '-'}"
        f" stream_events={summary.event_count}"
        f" text_chars={summary.text_chars}"
        f" thinking_chars={summary.thinking_chars}"
        f" thinking_blocks={summary.thinking_blocks}"
        f" redacted_thinking_blocks={summary.redacted_thinking_blocks}"
        f" tool_uses={summary.tool_use_count}"
    )


def _response_public_text(response: LLMResponse) -> str:
    return str(getattr(response, "public_text", "") or getattr(response, "text", "") or "").strip()


def _llm_error_reply(error: BaseException) -> str:
    if isinstance(error, LLMProviderError):
        return str(error.user_message or "").strip() or _LLM_ERROR_REPLY
    return _LLM_ERROR_REPLY


def _copy_messages_for_persistence(messages: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    return copy.deepcopy(list(messages or []))


def _assistant_history_blocks(response: LLMResponse) -> list[dict[str, Any]]:
    assistant_content = list(getattr(response, "assistant_content", None) or [])
    if assistant_content:
        return assistant_content
    blocks: list[dict[str, Any]] = []
    text = str(getattr(response, "text", "") or "").strip()
    if text:
        blocks.append({"type": "text", "text": text})
    for tool_call in list(getattr(response, "tool_calls", None) or []):
        blocks.append(
            {
                "type": "tool_call",
                "id": str(tool_call.id or "").strip(),
                "name": str(tool_call.name or "").strip(),
                "arguments": dict(tool_call.arguments or {}),
            }
        )
    return blocks


def _tool_call_id(tool_call: Any) -> str:
    return str(getattr(tool_call, "id", "") or "").strip()


def _synthetic_cancel_tool_result_block(tool_call: Any) -> dict[str, Any]:
    return {
        "type": "tool_result",
        "tool_name": str(getattr(tool_call, "name", "") or "").strip(),
        "tool_call_id": _tool_call_id(tool_call),
        "content": _INTERRUPTED_TOOL_RESULT,
        "is_error": True,
    }


def _completed_tool_result_ids(tool_result_blocks: list[dict[str, Any]]) -> set[str]:
    completed: set[str] = set()
    for raw_block in list(tool_result_blocks or []):
        block = dict(raw_block or {})
        tool_call_id = str(block.get("tool_call_id") or "").strip()
        if tool_call_id:
            completed.add(tool_call_id)
    return completed


def _append_synthetic_cancel_results(
    *,
    tool_calls: list[Any],
    tool_result_blocks: list[dict[str, Any]],
) -> None:
    completed = _completed_tool_result_ids(tool_result_blocks)
    for tool_call in list(tool_calls or []):
        tool_call_id = _tool_call_id(tool_call)
        if not tool_call_id or tool_call_id in completed:
            continue
        tool_result_blocks.append(_synthetic_cancel_tool_result_block(tool_call))
        completed.add(tool_call_id)


def _log_step(step_log: StepLog) -> None:
    """Log a single step immediately after it completes."""
    event = step_log.event
    args_suffix = ""
    if event in ("tool_call", "tool_error"):
        args_suffix = f" args={format_log_payload_preview(step_log.tool_args)}"
    if event in ("text_reply", "tool_call", "llm_error"):
        logger.info(
            "[Turn:STEP] step=%d event=%s llm_latency=%dms tokens_in=%d tokens_out=%d%s%s%s",
            step_log.step,
            event,
            step_log.llm_latency_ms,
            step_log.llm_input_tokens,
            step_log.llm_output_tokens,
            f" tool={step_log.tool_name}" if step_log.tool_name else "",
            _stream_summary_suffix(step_log.stream_summary),
            args_suffix if event == "tool_call" else "",
        )
    elif event in ("tool_result", "tool_error"):
        logger.info(
            "[Turn:STEP] step=%d event=%s tool=%s duration=%dms success=%s%s",
            step_log.step,
            event,
            step_log.tool_name,
            step_log.duration_ms,
            step_log.success,
            args_suffix if event == "tool_error" else "",
        )


def _log_turn_start(turn_log: TurnLog) -> None:
    """Log context snapshot at the beginning of a turn."""
    stats = turn_log.context_stats_before
    if stats is None:
        return
    ctx_window = turn_log.context_window_tokens
    usage_pct = (stats.estimated_tokens / ctx_window * 100) if ctx_window > 0 else 0
    logger.info(
        "[Turn:START] session=%s user=\"%s\" message_turns=%d"
        " context={sys=%d, msg=%d, total=%d, capacity=%d, usage=%.1f%%}",
        turn_log.session_id,
        turn_log.user_input_preview[:50],
        stats.raw_turn_count,
        turn_log.system_prompt_tokens,
        stats.estimated_tokens - turn_log.system_prompt_tokens,
        stats.estimated_tokens,
        ctx_window,
        usage_pct,
    )


_CONTEXT_USAGE_WARN_THRESHOLD = 0.8


def _log_context_warnings(stats: ContextBuildStats, context_window: int) -> None:
    """Emit warnings when context health thresholds are breached."""
    if context_window > 0:
        usage = stats.estimated_tokens / context_window
        if usage > _CONTEXT_USAGE_WARN_THRESHOLD:
            logger.warning(
                "[Turn:CONTEXT] ⚠ token usage %.0f%% (%d/%d) — approaching compaction threshold",
                usage * 100,
                stats.estimated_tokens,
                context_window,
            )


def _log_turn_end(turn_log: TurnLog) -> None:
    """Log comprehensive turn summary at end."""
    stats_before = turn_log.context_stats_before
    stats_after = turn_log.context_stats_after
    ctx_window = turn_log.context_window_tokens

    # Line 1: core metrics
    logger.info(
        "[Turn:END] status=%s elapsed=%dms steps=%d llm_calls=%d tool_calls=%d"
        " tokens_in=%d tokens_out=%d tools=%s",
        turn_log.status,
        turn_log.elapsed_ms,
        len(turn_log.steps),
        turn_log.total_llm_calls,
        turn_log.total_tool_calls,
        turn_log.total_input_tokens,
        turn_log.total_output_tokens,
        turn_log.tools_used or "[]",
    )

    # Line 2: context before → after delta
    if stats_after is not None:
        after_usage_pct = (stats_after.estimated_tokens / ctx_window * 100) if ctx_window > 0 else 0
        before_tokens = stats_before.estimated_tokens if stats_before else 0
        delta = stats_after.estimated_tokens - before_tokens
        logger.info(
            "[Turn:END] context_after={total=%d, usage=%.1f%%}"
            " delta=%+d prune=%s(recovered=%d) compaction=%s",
            stats_after.estimated_tokens,
            after_usage_pct,
            delta,
            turn_log.prune_performed,
            turn_log.prune_recovered_tokens,
            turn_log.compaction_performed,
        )

    if turn_log.error_summary:
        logger.error("[Turn:END] error: %s", turn_log.error_summary)


class AgentLoop:
    def __init__(
        self,
        *,
        session: Any,
        state_data: dict[str, Any],
        on_progress: ProgressCallback | None = None,
        on_final_text_delta: FinalTextCallback | None = None,
        on_stream_cancel: StreamCancelCallback | None = None,
        cancellation_check: Callable[[], Awaitable[bool]] | None = None,
        cancel_event: Any = None,
        thread_cancel_event: Any = None,
        provider_cancel_registrar: Callable[[Callable[[], None] | None], None] | None = None,
        tool_run_registrar: Callable[[str, str, Callable[[], None] | None], None] | None = None,
        tool_run_finisher: Callable[[str], None] | None = None,
    ) -> None:
        self.session = session
        self.state_data = dict(state_data or {})
        self.on_progress = on_progress
        self.on_final_text_delta = on_final_text_delta
        self.on_stream_cancel = on_stream_cancel
        self.cancellation_check = cancellation_check
        self.cancel_event = cancel_event
        self.thread_cancel_event = thread_cancel_event
        self.provider_cancel_registrar = provider_cancel_registrar
        self.tool_run_registrar = tool_run_registrar
        self.tool_run_finisher = tool_run_finisher
        self.tool_registry = ensure_all_tools_registered(get_registry())
        self.stream_logging_config = load_stream_logging_config()
        self.wire_trace_config = load_wire_trace_config()
        self._turn_trace_writer: TurnTraceWriter | None = None
        self._last_stream_summary: StreamStepSummary | None = None
        self._trace_session_id = ""
        self._trace_turn_id = ""
        self._trace_turn_started_at = 0.0
        self._wire_trace_turn_dir = ""
        self._stream_cancel_notified = False

    def _take_last_stream_summary(self) -> StreamStepSummary | None:
        summary = self._last_stream_summary
        self._last_stream_summary = None
        return summary

    async def _cancel_requested(self) -> bool:
        return self.cancellation_check is not None and await self.cancellation_check()

    async def _notify_stream_cancel(self) -> None:
        if self._stream_cancel_notified:
            return
        self._stream_cancel_notified = True
        if self.on_stream_cancel is not None:
            await self.on_stream_cancel()

    async def _cancel_outcome(
        self,
        *,
        messages_to_persist: list[dict[str, Any]] | None = None,
    ) -> TurnOutcome:
        await self._notify_stream_cancel()
        return TurnOutcome(
            status="cancelled",
            reply="",
            messages_to_persist=_copy_messages_for_persistence(messages_to_persist),
        )

    def _register_tool_run(self, tool_call: Any) -> Callable[[], None]:
        tool_call_id = _tool_call_id(tool_call)
        tool_name = str(getattr(tool_call, "name", "") or "").strip()
        if tool_call_id and self.tool_run_registrar is not None:
            self.tool_run_registrar(tool_call_id, tool_name, None)

        def _finish() -> None:
            if tool_call_id and self.tool_run_finisher is not None:
                self.tool_run_finisher(tool_call_id)

        return _finish

    async def _request_llm_step(
        self,
        *,
        step_idx: int,
        system_prompt: str,
        messages: list[dict[str, Any]],
        tool_schemas: list[dict[str, Any]],
        tool_choice_mode: Literal["auto", "none"] = "auto",
        on_stream_event: Callable[[LLMStreamEvent], Awaitable[None] | None] | None = None,
    ) -> LLMResponse:
        self._last_stream_summary = None

        async def _forward_stream_event(event: LLMStreamEvent) -> None:
            if await self._cancel_requested():
                await self._notify_stream_cancel()
                raise _TurnCancelledError()
            observer.observe(event)
            if on_stream_event is not None:
                result = on_stream_event(event)
                if hasattr(result, "__await__"):
                    await result
            if event.event_type not in {"text_delta", "thinking_delta", "redacted_thinking"} or self.on_final_text_delta is None:
                return
            text = str(event.text or "")
            if text:
                await self.on_final_text_delta(text)

        try:
            provider_name = agent_provider_descriptor().name
        except Exception:
            provider_name = "-"
        observer = StepStreamObserver(
            step_idx=step_idx,
            provider=provider_name,
            config=self.stream_logging_config,
            trace_writer=self._turn_trace_writer,
        )
        stream_callback = _forward_stream_event
        last_error: Exception | None = None
        wire_trace_paths: list[str] = []

        def _remember_wire_trace_path(context: WireTraceContext | None) -> None:
            path = str(getattr(context, "trace_path", "") or "").strip()
            if path and path not in wire_trace_paths:
                wire_trace_paths.append(path)

        def _build_summary() -> StreamStepSummary:
            summary = observer.summary()
            summary.wire_trace_paths = list(wire_trace_paths)
            return summary

        for attempt in range(1, _LLM_STEP_MAX_ATTEMPTS + 1):
            observer.start_attempt(attempt)
            wire_trace_context = WireTraceContext(
                session_id=self._trace_session_id,
                turn_id=self._trace_turn_id,
                step=step_idx,
                attempt=attempt,
                provider=provider_name,
                turn_started_at=self._trace_turn_started_at,
            )
            try:
                response = await chat_with_tools_streaming(
                    system_prompt=system_prompt,
                    messages=messages,
                    tool_schemas=tool_schemas,
                    tool_choice_mode=tool_choice_mode,
                    timeout_s=_LLM_STEP_TIMEOUT_S,
                    on_stream_event=stream_callback,
                    wire_trace_context=wire_trace_context,
                    thread_cancel_event=self.thread_cancel_event,
                    provider_cancel_registrar=self.provider_cancel_registrar,
                )
                _remember_wire_trace_path(wire_trace_context)
                observer.finish_attempt(response)
                self._last_stream_summary = _build_summary()
                return response
            except _TurnCancelledError:
                _remember_wire_trace_path(wire_trace_context)
                self._last_stream_summary = _build_summary()
                raise
            except Exception as error:
                _remember_wire_trace_path(wire_trace_context)
                observer.fail_attempt(error if isinstance(error, Exception) else RuntimeError(str(error)))
                if is_context_overflow_error(error):
                    self._last_stream_summary = _build_summary()
                    raise
                if isinstance(error, LLMProviderError) and not error.retryable:
                    self._last_stream_summary = _build_summary()
                    raise
                last_error = error if isinstance(error, Exception) else RuntimeError(str(error))
                logger.warning(
                    "[Turn:LLM] step=%d attempt=%d/%d failed after %ds: %s",
                    step_idx,
                    attempt,
                    _LLM_STEP_MAX_ATTEMPTS,
                    _LLM_STEP_TIMEOUT_S,
                    error,
                )
                if attempt >= _LLM_STEP_MAX_ATTEMPTS:
                    break
        assert last_error is not None
        self._last_stream_summary = _build_summary()
        raise last_error

    def _complete_text_reply(
        self,
        *,
        step_idx: int,
        response: LLMResponse,
        append_message: Callable[[dict[str, Any]], None],
        turn_log: TurnLog,
        fallback_text: str = "",
        stream_summary: StreamStepSummary | None = None,
    ) -> TurnOutcome:
        final_text = _response_public_text(response) or str(fallback_text or "").strip() or _DEFAULT_EMPTY_REPLY
        final_step = StepLog(
            step=step_idx,
            event="text_reply",
            reasoning_preview=final_text,
            stream_summary=stream_summary,
        )
        _record_llm_usage(final_step, response)
        turn_log.steps.append(final_step)
        _log_step(final_step)
        assistant_blocks = _assistant_history_blocks(response)
        if assistant_blocks and not fallback_text:
            append_message(make_assistant_content_message(content=assistant_blocks))
        else:
            append_message(make_assistant_text_message(final_text))
        return TurnOutcome(
            status="done",
            reply=final_text,
        )

    async def run(self, turn: TurnInput) -> TurnOutcome:
        if turn.provider_cancel_registrar is not None:
            self.provider_cancel_registrar = turn.provider_cancel_registrar
        if turn.tool_run_registrar is not None:
            self.tool_run_registrar = turn.tool_run_registrar
        if turn.tool_run_finisher is not None:
            self.tool_run_finisher = turn.tool_run_finisher

        user_input = str(turn.user_input or "").strip()
        user_content_blocks = list(turn.user_content_blocks or [])
        available_skills = list(turn.available_skills or [])

        turn_log = TurnLog(
            session_id=turn.session_id,
            turn_id=str(turn.run_id or "").strip() or uuid4().hex,
            user_input_preview=user_input[:100],
            started_at=time.time(),
        )
        self._trace_session_id = turn_log.session_id
        self._trace_turn_id = turn_log.turn_id
        self._trace_turn_started_at = turn_log.started_at
        self._wire_trace_turn_dir = wire_trace_turn_dir(
            self.wire_trace_config,
            session_id=turn_log.session_id,
            turn_id=turn_log.turn_id,
            started_at=turn_log.started_at,
        )
        self._turn_trace_writer = TurnTraceWriter(
            session_id=turn_log.session_id,
            turn_id=turn_log.turn_id,
            config=self.stream_logging_config,
            started_at=turn_log.started_at,
        )
        logger.info(
            "[Turn:TRACE] session=%s turn=%s mode=%s trace=%s wire=%s",
            turn_log.session_id,
            turn_log.turn_id,
            self.stream_logging_config.mode,
            self._turn_trace_writer.trace_path or "-",
            self._wire_trace_turn_dir or "-",
        )

        self.state_data, _ = prune_processed_history_images(self.state_data)
        request_user_message = make_user_message(user_content_blocks if user_content_blocks else user_input)
        current_turn_messages: list[dict[str, Any]] = [request_user_message]
        session_source = dict(getattr(self.session, "source", {}) or {})
        platform = str(session_source.get("platform") or "feishu").strip()
        tool_names = _active_tool_names(tool_registry=self.tool_registry)
        tool_schemas = self.tool_registry.tool_schemas(tool_names)
        system_prompt = build_system_prompt(
            platform=platform,
            tool_schemas=tool_schemas,
            available_skills=available_skills,
            state_data=self.state_data,
        )

        # --- prune tool results & record stats ---
        _, pre_prune_stats = build_llm_messages(
            state_data=self.state_data,
            current_turn_messages=current_turn_messages,
            system_prompt=system_prompt,
        )
        self.state_data, _prune_final_stats, prune_performed = prune_tool_results(
            state_data=self.state_data,
            system_prompt=system_prompt,
        )
        turn_log.prune_performed = prune_performed

        messages, context_stats = build_llm_messages(
            state_data=self.state_data,
            current_turn_messages=current_turn_messages,
            system_prompt=system_prompt,
        )

        # --- populate context snapshot for logging ---
        system_prompt_tokens = estimate_tokens(system_prompt)
        context_window = _model_context_window()
        turn_log.system_prompt_tokens = system_prompt_tokens
        turn_log.context_window_tokens = context_window
        turn_log.context_stats_before = context_stats
        if prune_performed:
            turn_log.prune_recovered_tokens = max(
                0, pre_prune_stats.estimated_tokens - context_stats.estimated_tokens
            )

        _log_turn_start(turn_log)
        _log_context_warnings(context_stats, context_window)

        exec_ctx = ToolExecutionContext(
            session=self.session,
            state_data=self.state_data,
            on_progress=self.on_progress,
            cancellation_check=self.cancellation_check,
            turn_id=turn_log.turn_id,
            response_route_id=str(turn.response_route_id or "").strip(),
            cancel_event=self.cancel_event,
        )
        set_tool_context(exec_ctx)
        try:
            outcome = await self._loop(
                current_turn_messages=current_turn_messages,
                messages=messages,
                system_prompt=system_prompt,
                tool_schemas=tool_schemas,
                turn_log=turn_log,
                exec_ctx=exec_ctx,
                session_id=turn.session_id,
            )
        finally:
            clear_tool_context()
            self.state_data = dict(exec_ctx.state_data)
            if self._turn_trace_writer is not None:
                self._turn_trace_writer.close()
                self._turn_trace_writer = None
            self._trace_session_id = ""
            self._trace_turn_id = ""
            self._trace_turn_started_at = 0.0
            self._wire_trace_turn_dir = ""

        messages_to_append = (
            list(outcome.messages_to_persist or [])
            if outcome.status == "cancelled"
            else current_turn_messages
        )
        if messages_to_append:
            self.state_data = append_messages_to_state(
                self.state_data,
                messages=messages_to_append,
            )

            self.state_data, compacted = await maybe_compact_history(
                state_data=self.state_data,
                session_id=turn.session_id,
                system_prompt=system_prompt,
                trigger="post_turn",
            )
            turn_log.compaction_performed = compacted

            is_group = bool(
                str(getattr(self.session, "conversation_type", "") or "").strip() == "2"
            )
            self.state_data = apply_message_history_limit(
                self.state_data,
                platform=platform,
                is_group=is_group,
            )

        state_patch = dict(self.state_data)

        # --- final context snapshot after compaction & limits ---
        _, after_stats = build_llm_messages(
            state_data=self.state_data,
            current_turn_messages=[],
            system_prompt=system_prompt,
        )
        turn_log.context_stats_after = after_stats

        turn_log.finalize(outcome.status)
        if outcome.status == "error":
            turn_log.error_summary = outcome.reply[:200]
        _log_turn_end(turn_log)

        return TurnOutcome(
            status=outcome.status,
            reply=outcome.reply,
            state_data_patch=state_patch,
            turn_log=turn_log,
        )

    async def _loop(
        self,
        *,
        current_turn_messages: list[dict[str, Any]],
        messages: list[dict[str, Any]],
        system_prompt: str,
        tool_schemas: list[dict[str, Any]],
        turn_log: TurnLog,
        exec_ctx: ToolExecutionContext,
        session_id: str,
    ) -> TurnOutcome:
        overflow_recovered = False

        def _append_message(message: dict[str, Any]) -> None:
            current_turn_messages.append(message)
            messages.append(message)

        for step_idx in range(MAX_STEPS):
            if await self._cancel_requested():
                return await self._cancel_outcome(messages_to_persist=current_turn_messages)

            is_last_step = step_idx == MAX_STEPS - 1
            request_tool_schemas = [] if is_last_step else tool_schemas
            tool_choice_mode: Literal["auto", "none"] = "none" if is_last_step else "auto"

            try:
                response = await self._request_llm_step(
                    step_idx=step_idx,
                    system_prompt=system_prompt,
                    messages=messages,
                    tool_schemas=request_tool_schemas,
                    tool_choice_mode=tool_choice_mode,
                )
                overflow_recovered = False
            except _TurnCancelledError:
                return await self._cancel_outcome(messages_to_persist=current_turn_messages)
            except Exception as error:
                if is_context_overflow_error(error) and not overflow_recovered:
                    exec_ctx.state_data, compacted = await maybe_compact_history(
                        state_data=exec_ctx.state_data,
                        session_id=session_id,
                        system_prompt=system_prompt,
                        trigger="overflow",
                    )
                    if compacted:
                        messages, _ = build_llm_messages(
                            state_data=exec_ctx.state_data,
                            current_turn_messages=current_turn_messages,
                            system_prompt=system_prompt,
                        )
                        self._take_last_stream_summary()
                        overflow_recovered = True
                        continue

                _err_step = StepLog(
                    step=step_idx,
                    event="llm_error",
                    tool_result_preview=str(error),
                    stream_summary=self._take_last_stream_summary(),
                )
                turn_log.steps.append(_err_step)
                _log_step(_err_step)
                reply = _llm_error_reply(error)
                _append_message(make_assistant_text_message(reply))
                return TurnOutcome(
                    status="error",
                    reply=reply,
                )

            stream_summary = self._take_last_stream_summary()
            if not response.is_tool_call:
                outcome = self._complete_text_reply(
                    step_idx=step_idx,
                    response=response,
                    append_message=_append_message,
                    turn_log=turn_log,
                    stream_summary=stream_summary,
                )
                if await self._cancel_requested():
                    return await self._cancel_outcome(messages_to_persist=current_turn_messages)
                return outcome

            tool_calls = list(response.tool_calls or [])
            if not tool_calls:
                outcome = self._complete_text_reply(
                    step_idx=step_idx,
                    response=response,
                    append_message=_append_message,
                    turn_log=turn_log,
                    stream_summary=stream_summary,
                )
                if await self._cancel_requested():
                    return await self._cancel_outcome(messages_to_persist=current_turn_messages)
                return outcome

            if is_last_step:
                logger.warning(
                    "[Turn:STEP] step=%d provider returned tool_use despite tool_choice=none; ignoring %d tool call(s)",
                    step_idx,
                    len(tool_calls),
                )
                return self._complete_text_reply(
                    step_idx=step_idx,
                    response=response,
                    append_message=_append_message,
                    turn_log=turn_log,
                    fallback_text=_MAX_STEPS_TERMINAL_REPLY,
                    stream_summary=stream_summary,
                )

            for tool_index, tool_call in enumerate(tool_calls):
                step_log = StepLog(
                    step=step_idx,
                    event="tool_call",
                    tool_name=tool_call.name,
                    tool_args=dict(tool_call.arguments or {}),
                    reasoning_preview=_response_public_text(response) if tool_index == 0 else "",
                    stream_summary=stream_summary if tool_index == 0 else None,
                )
                if tool_index == 0:
                    _record_llm_usage(step_log, response)
                turn_log.steps.append(step_log)
                _log_step(step_log)

            _append_message(make_assistant_content_message(content=_assistant_history_blocks(response)))

            tool_result_blocks: list[dict[str, Any]] = []
            for tool_call in tool_calls:
                if await self._cancel_requested():
                    _append_synthetic_cancel_results(
                        tool_calls=tool_calls,
                        tool_result_blocks=tool_result_blocks,
                    )
                    if tool_result_blocks:
                        _append_message(make_tool_results_message(tool_results=tool_result_blocks))
                    return await self._cancel_outcome(messages_to_persist=current_turn_messages)
                if self.on_progress is not None:
                    await self.on_progress(f"🔧 {tool_call.name}")

                tool_def = self.tool_registry.get(tool_call.name)
                if tool_def is None:
                    observation = f"Unknown tool: {tool_call.name}"
                    tool_result_blocks.append(
                        {
                            "type": "tool_result",
                            "tool_name": tool_call.name,
                            "tool_call_id": tool_call.id,
                            "content": observation,
                            "is_error": True,
                        }
                    )
                    _unk_step = StepLog(
                        step=step_idx,
                        event="tool_error",
                        tool_name=tool_call.name,
                        tool_args=dict(tool_call.arguments or {}),
                        tool_result_preview=observation,
                        success=False,
                    )
                    turn_log.steps.append(_unk_step)
                    _log_step(_unk_step)
                    if await self._cancel_requested():
                        _append_synthetic_cancel_results(
                            tool_calls=tool_calls,
                            tool_result_blocks=tool_result_blocks,
                        )
                        if tool_result_blocks:
                            _append_message(make_tool_results_message(tool_results=tool_result_blocks))
                        return await self._cancel_outcome(messages_to_persist=current_turn_messages)
                    continue

                started_at = time.time()
                finish_tool_run = self._register_tool_run(tool_call)
                try:
                    result: ToolResult = await tool_def.handler(**tool_call.arguments)
                except Exception as error:
                    logger.error("[Turn:TOOL] failure: tool=%s error=%s", tool_call.name, error, exc_info=True)
                    observation = _tool_exception_observation(tool_call.name, error)
                    tool_result_blocks.append(
                        {
                            "type": "tool_result",
                            "tool_name": tool_call.name,
                            "tool_call_id": tool_call.id,
                            "content": observation,
                            "is_error": True,
                        }
                    )
                    _te_step = StepLog(
                        step=step_idx,
                        event="tool_error",
                        tool_name=tool_call.name,
                        tool_args=dict(tool_call.arguments or {}),
                        tool_result_preview=observation[:200],
                        success=False,
                        duration_ms=int((time.time() - started_at) * 1000),
                    )
                    turn_log.steps.append(_te_step)
                    _log_step(_te_step)
                    if await self._cancel_requested():
                        _append_synthetic_cancel_results(
                            tool_calls=tool_calls,
                            tool_result_blocks=tool_result_blocks,
                        )
                        if tool_result_blocks:
                            _append_message(make_tool_results_message(tool_results=tool_result_blocks))
                        return await self._cancel_outcome(messages_to_persist=current_turn_messages)
                    continue
                finally:
                    finish_tool_run()

                tool_result_blocks.append(
                    {
                        "type": "tool_result",
                        "tool_name": tool_call.name,
                        "tool_call_id": tool_call.id,
                        "content": list(result.content or []),
                        "is_error": False,
                    }
                )
                observation = tool_content_preview_text(result.content)
                _tr_step = StepLog(
                    step=step_idx,
                    event="tool_result",
                    tool_name=tool_call.name,
                    tool_result_preview=observation[:200],
                    success=True,
                    duration_ms=int((time.time() - started_at) * 1000),
                )
                turn_log.steps.append(_tr_step)
                _log_step(_tr_step)
                if await self._cancel_requested():
                    _append_synthetic_cancel_results(
                        tool_calls=tool_calls,
                        tool_result_blocks=tool_result_blocks,
                    )
                    if tool_result_blocks:
                        _append_message(make_tool_results_message(tool_results=tool_result_blocks))
                    return await self._cancel_outcome(messages_to_persist=current_turn_messages)

            if tool_result_blocks:
                _append_message(make_tool_results_message(tool_results=tool_result_blocks))

        _append_message(make_assistant_text_message(_MAX_STEPS_TERMINAL_REPLY))
        return TurnOutcome(
            status="done",
            reply=_MAX_STEPS_TERMINAL_REPLY,
        )


async def run_agent_turn(
    *,
    session: Any,
    state_data: dict[str, Any],
    user_text: str,
    user_content_blocks: list[dict[str, Any]] | None = None,
    session_id: str = "",
    user_id: str = "",
    run_id: str = "",
    response_route_id: str = "",
    available_skills: list[Any] | None = None,
    on_progress: ProgressCallback | None = None,
    on_final_text_delta: FinalTextCallback | None = None,
    on_stream_cancel: StreamCancelCallback | None = None,
    cancellation_check: Callable[[], Awaitable[bool]] | None = None,
    cancel_event: Any = None,
    thread_cancel_event: Any = None,
    provider_cancel_registrar: Callable[[Callable[[], None] | None], None] | None = None,
    tool_run_registrar: Callable[[str, str, Callable[[], None] | None], None] | None = None,
    tool_run_finisher: Callable[[str], None] | None = None,
) -> TurnOutcome:
    loop = AgentLoop(
        session=session,
        state_data=state_data,
        on_progress=on_progress,
        on_final_text_delta=on_final_text_delta,
        on_stream_cancel=on_stream_cancel,
        cancellation_check=cancellation_check,
        cancel_event=cancel_event,
        thread_cancel_event=thread_cancel_event,
        provider_cancel_registrar=provider_cancel_registrar,
        tool_run_registrar=tool_run_registrar,
        tool_run_finisher=tool_run_finisher,
    )
    turn_input = TurnInput(
        user_input=user_text,
        session_id=session_id or str(getattr(session, "session_id", "") or "").strip(),
        user_id=user_id or str(getattr(session, "owner_user_id", "") or "").strip(),
        available_skills=list(available_skills or []),
        user_content_blocks=list(user_content_blocks or []),
        run_id=str(run_id or "").strip(),
        response_route_id=str(response_route_id or "").strip(),
        provider_cancel_registrar=provider_cancel_registrar,
        tool_run_registrar=tool_run_registrar,
        tool_run_finisher=tool_run_finisher,
    )
    return await loop.run(turn_input)


__all__ = ["AgentLoop", "MAX_STEPS", "run_agent_turn"]
