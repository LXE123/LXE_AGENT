from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
from typing import Any, Awaitable, Callable, TypedDict

from .skill_manifest import SkillQueueItem


class ToolSchema(TypedDict):
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass
class ToolDefinition:
    name: str
    description: str
    parameters: dict[str, Any]  # JSON Schema
    handler: Callable[..., Awaitable[ToolResult]]
    requires_resource: str | None = None


@dataclass
class ToolResult:
    content: list[dict[str, Any]]
    details: dict[str, Any] = field(default_factory=dict)


class ToolExecutionError(RuntimeError):
    """Tool failure safe to expose to the model."""


def text_content_block(text: str) -> dict[str, Any]:
    return {"type": "text", "text": str(text or "")}


def image_content_block(*, media_type: str, data: str) -> dict[str, Any]:
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": str(media_type or "").strip(),
            "data": str(data or ""),
        },
    }


def text_tool_result(text: str, *, details: dict[str, Any] | None = None) -> ToolResult:
    return ToolResult(content=[text_content_block(text)], details=dict(details or {}))


def tool_content_preview_text(content: Any) -> str:
    if isinstance(content, str):
        return str(content).strip()
    lines: list[str] = []
    for raw_block in list(content or []):
        block = dict(raw_block or {})
        block_type = str(block.get("type") or "").strip()
        if block_type == "text":
            text = str(block.get("text") or "").strip()
            if text:
                lines.append(text)
            continue
        if block_type == "image":
            source = dict(block.get("source") or {})
            media_type = str(source.get("media_type") or "").strip() or "image"
            lines.append(f"[image:{media_type}]")
    if lines:
        return "\n".join(lines).strip()
    try:
        return json.dumps(content, ensure_ascii=False)
    except Exception:
        return str(content or "").strip()


@dataclass
class ContextBuildStats:
    estimated_tokens: int = 0
    raw_turn_count: int = 0
    retained_turn_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class TurnInput:
    user_input: str
    session_id: str
    user_id: str
    available_skills: list[SkillQueueItem]
    user_content_blocks: list[dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Structured observability: StepLog + TurnLog
# ---------------------------------------------------------------------------

@dataclass
class StreamStepSummary:
    attempts: int = 0
    event_count: int = 0
    text_chars: int = 0
    text_blocks: int = 0
    thinking_chars: int = 0
    thinking_blocks: int = 0
    redacted_thinking_blocks: int = 0
    tool_use_count: int = 0
    stop_reason: str = ""
    message_id: str = ""
    model: str = ""
    trace_path: str = ""
    wire_trace_paths: list[str] = field(default_factory=list)


@dataclass
class StepLog:
    """Structured record for one loop iteration (LLM call + optional tool)."""
    step: int
    event: str  # "tool_call" | "tool_result" | "tool_error" | "text_reply" | "llm_error"
    tool_name: str = ""
    tool_args: dict[str, Any] = field(default_factory=dict)
    tool_result_preview: str = ""   # first 200 chars of tool output
    success: bool | None = None
    duration_ms: int = 0            # wall-clock time for this step (tool execution)
    llm_input_tokens: int = 0
    llm_output_tokens: int = 0
    llm_latency_ms: int = 0
    reasoning_preview: str = ""     # first 200 chars of LLM reasoning text
    stream_summary: StreamStepSummary | None = None

@dataclass
class TurnLog:
    """Structured summary of an entire turn's execution."""
    session_id: str = ""
    turn_id: str = ""
    user_input_preview: str = ""    # first 100 chars
    started_at: float = 0.0         # time.time()
    finished_at: float = 0.0
    status: str = ""                # mirrors TurnOutcome.status
    steps: list[StepLog] = field(default_factory=list)

    # Aggregated counters (computed at turn end)
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_llm_calls: int = 0
    total_tool_calls: int = 0
    tools_used: list[str] = field(default_factory=list)
    elapsed_ms: int = 0
    error_summary: str = ""

    # Context snapshot (set by the loop before/after execution)
    context_stats_before: ContextBuildStats | None = None
    context_stats_after: ContextBuildStats | None = None
    system_prompt_tokens: int = 0
    context_window_tokens: int = 0
    prune_performed: bool = False
    prune_recovered_tokens: int = 0
    compaction_performed: bool = False

    def finalize(self, status: str) -> None:
        """Compute aggregated counters from steps."""
        self.status = status
        self.finished_at = __import__("time").time()
        self.elapsed_ms = int((self.finished_at - self.started_at) * 1000)

        seen_tools: set[str] = set()
        for s in self.steps:
            self.total_input_tokens += s.llm_input_tokens
            self.total_output_tokens += s.llm_output_tokens
            if s.llm_latency_ms > 0:
                self.total_llm_calls += 1
            if s.event in ("tool_call", "tool_result") and s.tool_name:
                seen_tools.add(s.tool_name)
                if s.event == "tool_call":
                    self.total_tool_calls += 1
        self.tools_used = sorted(seen_tools)

@dataclass
class TurnOutcome:
    """The single output contract of the agent loop.

    The worker layer reads these fields directly — no intermediate
    translation needed.
    """
    status: str  # "done" | "waiting" | "cancelled" | "error"
    reply: str
    state_data_patch: dict[str, Any] = field(default_factory=dict)
    turn_log: TurnLog | None = None


__all__ = [
    "ContextBuildStats",
    "StepLog",
    "StreamStepSummary",
    "ToolDefinition",
    "ToolExecutionError",
    "ToolSchema",
    "ToolResult",
    "TurnInput",
    "TurnLog",
    "TurnOutcome",
    "image_content_block",
    "text_content_block",
    "text_tool_result",
    "tool_content_preview_text",
]
