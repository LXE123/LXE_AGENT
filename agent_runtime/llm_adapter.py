"""LLM adapter for the unified agent loop.

The runtime speaks one canonical tool schema internally and converts it
to the provider-specific wire format only at request time.
"""
from __future__ import annotations

import asyncio
import inspect
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

from requests import exceptions as requests_exceptions

from shared.llm.agent_planner import active_agent_planner_descriptor
from shared.llm.errors import AnthropicStreamError
from shared.llm.events import LLMStreamEvent, LLMToolCall
from shared.llm.provider_catalog import ProviderDescriptor
from shared.llm import runtime_config as runtime_settings
from shared.llm.transports.anthropic_sdk_stream import stream_message_events as sdk_stream_message_events
from shared.llm.transports.wire_trace import WireTraceContext
from shared.logging import logger

from .tool_schema_adapter import adapt_tool_schemas
from .types import ToolSchema

ToolChoiceMode = Literal["auto", "none"]
_DEEPSEEK_PROVIDER_NAME = "deepseek"
_DEEPSEEK_IMAGE_PLACEHOLDER = "[image omitted: DeepSeek Anthropic API does not support image content]"
_DEEPSEEK_REDACTED_THINKING_PLACEHOLDER = (
    "[redacted thinking omitted: DeepSeek Anthropic API does not support redacted_thinking content]"
)


@dataclass(frozen=True, slots=True)
class LLMResponse:
    """Parsed LLM response - either text, tool calls, or both."""
    text: str
    public_text: str = ""
    assistant_content: list[dict[str, Any]] = field(default_factory=list)
    tool_calls: list[LLMToolCall] = field(default_factory=list)
    raw: dict[str, Any] = field(default_factory=dict)
    usage: dict[str, Any] = field(default_factory=dict)
    latency_ms: int = 0

    @property
    def is_tool_call(self) -> bool:
        return bool(self.tool_calls)

    @property
    def tool_call(self) -> LLMToolCall | None:
        return self.tool_calls[0] if self.tool_calls else None


def _config_int(name: str, default: int) -> int:
    try:
        return int(getattr(runtime_settings, name, default) or default)
    except Exception:
        return int(default)


def agent_provider_descriptor() -> ProviderDescriptor:
    return active_agent_planner_descriptor()


def _collect_anthropic_public_text(content_blocks: list[dict[str, Any]] | None) -> str:
    parts: list[str] = []
    for raw_block in list(content_blocks or []):
        block = dict(raw_block or {})
        block_type = str(block.get("type") or "").strip()
        if block_type == "text":
            text = str(block.get("text") or "")
        else:
            continue
        if text:
            parts.append(text)
    return "".join(parts).strip()


def _canonicalize_anthropic_content_blocks(content_blocks: list[dict[str, Any]] | None) -> list[dict[str, Any]]:
    canonical_blocks: list[dict[str, Any]] = []
    for raw_block in list(content_blocks or []):
        block = dict(raw_block or {})
        block_type = str(block.get("type") or "").strip()
        if block_type == "thinking":
            thinking = str(block.get("thinking") or "")
            signature = str(block.get("signature") or "").strip()
            if thinking or signature:
                canonical_blocks.append(
                    {
                        "type": "thinking",
                        "thinking": thinking,
                        "signature": signature,
                    }
                )
            continue
        if block_type == "redacted_thinking":
            canonical_blocks.append(
                {
                    "type": "redacted_thinking",
                    "data": str(block.get("data") or ""),
                }
            )
            continue
        if block_type == "text":
            canonical_blocks.append({"type": "text", "text": str(block.get("text") or "")})
            continue
        if block_type != "tool_use":
            continue
        canonical_blocks.append(
            {
                "type": "tool_call",
                "id": str(block.get("id") or "").strip(),
                "name": str(block.get("name") or "").strip(),
                "arguments": dict(block.get("input") or {}),
            }
        )
    return canonical_blocks


async def _maybe_emit_stream_event(
    on_stream_event: Callable[[LLMStreamEvent], Awaitable[None] | None] | None,
    event: LLMStreamEvent,
) -> None:
    if on_stream_event is None:
        return
    result = on_stream_event(event)
    if inspect.isawaitable(result):
        await result


async def _stream_anthropic_events(
    *,
    descriptor: ProviderDescriptor,
    system_prompt: str,
    messages: list[dict[str, Any]],
    tool_schemas: list[dict[str, Any]] | None,
    tool_choice_mode: ToolChoiceMode,
    max_tokens: int | None,
    temperature: float,
    timeout_s: int,
    wire_trace_context: WireTraceContext | None = None,
    thread_cancel_event: Any = None,
    provider_cancel_registrar: Callable[[Callable[[], None] | None], None] | None = None,
):
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[object] = asyncio.Queue()
    sentinel = object()

    def _worker() -> None:
        try:
            for event in sdk_stream_message_events(
                descriptor=descriptor,
                system_prompt=system_prompt,
                messages=messages,
                tool_schemas=tool_schemas,
                tool_choice_mode=tool_choice_mode,
                max_tokens=max_tokens,
                temperature=temperature,
                timeout_s=timeout_s,
                wire_trace_context=wire_trace_context,
                cancel_event=thread_cancel_event,
                provider_cancel_registrar=provider_cancel_registrar,
            ):
                loop.call_soon_threadsafe(queue.put_nowait, event)
        except Exception as exc:
            loop.call_soon_threadsafe(queue.put_nowait, exc)
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, sentinel)

    thread = threading.Thread(target=_worker, name=f"{descriptor.name}-sdk-stream-reader", daemon=True)
    thread.start()

    while True:
        try:
            item = await asyncio.wait_for(queue.get(), timeout=0.1)
        except asyncio.TimeoutError:
            if thread_cancel_event is not None and bool(thread_cancel_event.is_set()):
                yield LLMStreamEvent(event_type="cancelled")
                break
            continue
        if item is sentinel:
            break
        if isinstance(item, Exception):
            raise item
        yield item


async def chat_with_tools_streaming(
    *,
    system_prompt: str,
    messages: list[dict[str, Any]],
    tool_schemas: list[ToolSchema] | None = None,
    tool_choice_mode: ToolChoiceMode = "auto",
    max_tokens: int | None = None,
    temperature: float = 0.1,
    timeout_s: int | None = None,
    descriptor: ProviderDescriptor | None = None,
    on_stream_event: Callable[[LLMStreamEvent], Awaitable[None] | None] | None = None,
    wire_trace_context: WireTraceContext | None = None,
    thread_cancel_event: Any = None,
    provider_cancel_registrar: Callable[[Callable[[], None] | None], None] | None = None,
) -> LLMResponse:
    desc = descriptor or agent_provider_descriptor()
    effective_timeout = timeout_s or max(10, _config_int("LLM_REQUEST_TIMEOUT_S", 30))
    started_at = time.perf_counter()

    if desc.api_style != "anthropic-messages":
        raise RuntimeError(f"Unsupported agent LLM api_style: {desc.api_style}")

    adapted_tool_schemas = adapt_tool_schemas(tool_schemas, desc.api_style)
    adapted_messages = adapt_messages_for_anthropic(messages, provider_name=desc.name)
    text_parts_by_index: dict[int, list[str]] = {}
    thinking_parts_by_index: dict[int, list[str]] = {}
    thinking_signatures_by_index: dict[int, str] = {}
    redacted_data_by_index: dict[int, str] = {}
    tool_calls_by_index: dict[int, LLMToolCall] = {}
    block_type_by_index: dict[int, str] = {}
    usage: dict[str, Any] = {}
    message_id = ""
    model = ""
    stop_reason = ""
    saw_message_stop = False
    stream_events: list[dict[str, Any]] = []

    try:
        async for event in _stream_anthropic_events(
            descriptor=desc,
            system_prompt=system_prompt,
            messages=adapted_messages,
            tool_schemas=adapted_tool_schemas,
            tool_choice_mode=tool_choice_mode,
            max_tokens=max_tokens,
            temperature=temperature,
            timeout_s=effective_timeout,
            wire_trace_context=wire_trace_context,
            thread_cancel_event=thread_cancel_event,
            provider_cancel_registrar=provider_cancel_registrar,
        ):
            stream_events.append(
                {
                    "event_type": event.event_type,
                    "index": event.index,
                    "stop_reason": event.stop_reason,
                }
            )
            if event.event_type == "message_start":
                if event.message_id:
                    message_id = event.message_id
                if event.model:
                    model = event.model
                if event.usage:
                    usage.update(event.usage)
            elif event.event_type == "text_delta":
                block_type_by_index[int(event.index)] = "text"
                text_parts_by_index.setdefault(event.index, []).append(str(event.text or ""))
            elif event.event_type == "thinking_delta":
                block_type_by_index[int(event.index)] = "thinking"
                chunk = str(event.thinking_text or event.text or "")
                thinking_parts_by_index.setdefault(event.index, []).append(chunk)
            elif event.event_type == "thinking_signature":
                block_type_by_index.setdefault(int(event.index), "thinking")
                if event.signature:
                    thinking_signatures_by_index[int(event.index)] = str(event.signature or "").strip()
            elif event.event_type == "redacted_thinking":
                block_type_by_index[int(event.index)] = "redacted_thinking"
                redacted_data_by_index[int(event.index)] = str(event.redacted_data or "")
            elif event.event_type == "tool_use" and event.tool_call is not None:
                block_type_by_index[int(event.index)] = "tool_use"
                tool_calls_by_index[int(event.index)] = event.tool_call
            elif event.event_type == "message_delta":
                if event.stop_reason:
                    stop_reason = event.stop_reason
                if event.usage:
                    usage.update(event.usage)
            elif event.event_type == "message_stop":
                saw_message_stop = True
            await _maybe_emit_stream_event(on_stream_event, event)

        if not saw_message_stop:
            raise AnthropicStreamError("stream ended before message_stop")

        latency_ms = int((time.perf_counter() - started_at) * 1000)
        content_blocks: list[dict[str, Any]] = []
        for index in sorted(block_type_by_index):
            block_type = str(block_type_by_index.get(index) or "").strip()
            if block_type == "thinking":
                content_blocks.append(
                    {
                        "type": "thinking",
                        "thinking": "".join(thinking_parts_by_index.get(index) or []),
                        "signature": str(thinking_signatures_by_index.get(index) or "").strip(),
                    }
                )
                continue
            if block_type == "redacted_thinking":
                content_blocks.append(
                    {
                        "type": "redacted_thinking",
                        "data": str(redacted_data_by_index.get(index) or ""),
                    }
                )
                continue
            if block_type == "text":
                content_blocks.append(
                    {
                        "type": "text",
                        "text": "".join(text_parts_by_index.get(index) or []),
                    }
                )
                continue
            if block_type == "tool_use" and index in tool_calls_by_index:
                tool_call = tool_calls_by_index[index]
                content_blocks.append(
                    {
                        "type": "tool_use",
                        "id": tool_call.id,
                        "name": tool_call.name,
                        "input": dict(tool_call.arguments or {}),
                    }
                )

        raw = {
            "id": message_id,
            "type": "message",
            "role": "assistant",
            "model": model,
            "content": content_blocks,
            "usage": usage,
            "stop_reason": stop_reason,
            "stream_events": stream_events,
        }
        return LLMResponse(
            text="\n".join(
                "".join(text_parts_by_index.get(index) or [])
                for index in sorted(text_parts_by_index)
                if "".join(text_parts_by_index.get(index) or []).strip()
            ).strip(),
            public_text=_collect_anthropic_public_text(content_blocks),
            assistant_content=_canonicalize_anthropic_content_blocks(content_blocks),
            tool_calls=[tool_calls_by_index[index] for index in sorted(tool_calls_by_index)],
            raw=raw,
            usage=usage,
            latency_ms=latency_ms,
        )
    except requests_exceptions.Timeout:
        logger.warning(f"[LLMAdapter] streaming request timed out after {effective_timeout}s")
        raise
    except requests_exceptions.HTTPError as exc:
        logger.error(f"[LLMAdapter] streaming HTTP error: {exc}")
        raise


async def chat_with_tools(
    *,
    system_prompt: str,
    messages: list[dict[str, Any]],
    tool_schemas: list[ToolSchema] | None = None,
    tool_choice_mode: ToolChoiceMode = "auto",
    max_tokens: int | None = None,
    temperature: float = 0.1,
    timeout_s: int | None = None,
    descriptor: ProviderDescriptor | None = None,
    wire_trace_context: WireTraceContext | None = None,
) -> LLMResponse:
    """Send a multi-turn messages request with optional tool schemas."""
    desc = descriptor or agent_provider_descriptor()
    effective_timeout = timeout_s or max(10, _config_int("LLM_REQUEST_TIMEOUT_S", 30))

    try:
        if desc.api_style == "anthropic-messages":
            return await chat_with_tools_streaming(
                system_prompt=system_prompt,
                messages=messages,
                tool_schemas=tool_schemas,
                tool_choice_mode=tool_choice_mode,
                max_tokens=max_tokens,
                temperature=temperature,
                timeout_s=effective_timeout,
                descriptor=desc,
                wire_trace_context=wire_trace_context,
            )

        raise RuntimeError(f"Unsupported agent LLM api_style: {desc.api_style}")
    except requests_exceptions.Timeout:
        logger.warning(f"[LLMAdapter] request timed out after {effective_timeout}s")
        raise
    except requests_exceptions.HTTPError as exc:
        logger.error(f"[LLMAdapter] HTTP error: {exc}")
        raise


def _is_deepseek_provider(provider_name: str) -> bool:
    return str(provider_name or "").strip() == _DEEPSEEK_PROVIDER_NAME


def _wire_tool_result_content(content: Any, *, provider_name: str = "") -> str | list[dict[str, Any]]:
    if isinstance(content, str):
        return str(content or "").strip()

    if _is_deepseek_provider(provider_name):
        parts: list[str] = []
        for raw_block in list(content or []):
            block = dict(raw_block or {})
            block_type = str(block.get("type") or "").strip()
            if block_type == "text":
                text = str(block.get("text") or "").strip()
                if text:
                    parts.append(text)
                continue
            if block_type == "image":
                parts.append(_DEEPSEEK_IMAGE_PLACEHOLDER)
        return "\n".join(parts).strip()

    blocks: list[dict[str, Any]] = []
    for raw_block in list(content or []):
        block = dict(raw_block or {})
        block_type = str(block.get("type") or "").strip()
        if block_type == "text":
            blocks.append({"type": "text", "text": str(block.get("text") or "")})
            continue
        if block_type == "image":
            source = dict(block.get("source") or {})
            if not source:
                source = {
                    "type": "base64",
                    "media_type": str(block.get("mimeType") or "").strip(),
                    "data": str(block.get("data") or ""),
                }
            blocks.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": str(source.get("media_type") or source.get("mimeType") or "").strip(),
                        "data": str(source.get("data") or ""),
                    },
                }
            )
    if len(blocks) == 1 and str(blocks[0].get("type") or "").strip() == "text":
        return str(blocks[0].get("text") or "").strip()
    return blocks


def _anthropic_user_content(content: Any, *, provider_name: str = "") -> str | list[dict[str, Any]]:
    if isinstance(content, str):
        return str(content or "")

    text_parts: list[str] = []
    blocks: list[dict[str, Any]] = []
    has_image = False
    for raw_block in list(content or []):
        block = dict(raw_block or {})
        block_type = str(block.get("type") or "").strip()
        if block_type == "text":
            text = str(block.get("text") or "")
            text_parts.append(text)
            blocks.append({"type": "text", "text": text})
            continue
        if block_type != "image":
            continue
        if _is_deepseek_provider(provider_name):
            text_parts.append(_DEEPSEEK_IMAGE_PLACEHOLDER)
            blocks.append({"type": "text", "text": _DEEPSEEK_IMAGE_PLACEHOLDER})
            has_image = True
            continue
        source = dict(block.get("source") or {})
        if not source:
            source = {
                "type": "base64",
                "media_type": str(block.get("mimeType") or "").strip(),
                "data": str(block.get("data") or ""),
            }
        blocks.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": str(source.get("media_type") or source.get("mimeType") or "").strip(),
                    "data": str(source.get("data") or ""),
                },
            }
        )
        has_image = True

    if has_image:
        return blocks
    if text_parts:
        return "\n".join(text_parts).strip()
    return str(content or "")


def adapt_messages_for_anthropic(messages: list[dict[str, Any]], *, provider_name: str = "") -> list[dict[str, Any]]:
    adapted: list[dict[str, Any]] = []
    is_deepseek = _is_deepseek_provider(provider_name)
    for raw_message in list(messages or []):
        message = dict(raw_message or {})
        role = str(message.get("role") or "").strip()
        content = message.get("content")
        if role == "user":
            adapted.append(
                {
                    "role": "user",
                    "content": _anthropic_user_content(content, provider_name=provider_name),
                }
            )
            continue
        if role == "system":
            adapted.append({"role": "user", "content": f"[System Message]\n{str(content or '')}"})
            continue
        if role == "assistant":
            blocks: list[dict[str, Any]] = []
            for raw_block in list(content or []):
                block = dict(raw_block or {})
                block_type = str(block.get("type") or "").strip()
                if block_type == "thinking":
                    thinking_block = {
                        "type": "thinking",
                        "thinking": str(block.get("thinking") or ""),
                    }
                    if not is_deepseek:
                        thinking_block["signature"] = str(block.get("signature") or "").strip()
                    blocks.append(thinking_block)
                    continue
                if block_type == "redacted_thinking":
                    if is_deepseek:
                        blocks.append({"type": "text", "text": _DEEPSEEK_REDACTED_THINKING_PLACEHOLDER})
                        continue
                    blocks.append(
                        {
                            "type": "redacted_thinking",
                            "data": str(block.get("data") or ""),
                        }
                    )
                    continue
                if block_type == "text":
                    blocks.append({"type": "text", "text": str(block.get("text") or "")})
                    continue
                if block_type != "tool_call":
                    continue
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": str(block.get("id") or "").strip(),
                        "name": str(block.get("name") or "").strip(),
                        "input": dict(block.get("arguments") or {}),
                    }
                )
            adapted.append({"role": "assistant", "content": blocks})
            continue
        if role == "tool":
            blocks: list[dict[str, Any]] = []
            for raw_block in list(content or []):
                block = dict(raw_block or {})
                if str(block.get("type") or "").strip() != "tool_result":
                    continue
                blocks.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": str(block.get("tool_call_id") or "").strip(),
                        "content": _wire_tool_result_content(
                            block.get("content"),
                            provider_name=provider_name,
                        ),
                        "is_error": bool(block.get("is_error")),
                    }
                )
            if blocks:
                adapted.append({"role": "user", "content": blocks})
    return adapted


__all__ = [
    "LLMStreamEvent",
    "LLMResponse",
    "LLMToolCall",
    "adapt_messages_for_anthropic",
    "agent_provider_descriptor",
    "chat_with_tools",
    "chat_with_tools_streaming",
]
