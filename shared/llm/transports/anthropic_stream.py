from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Iterable, Literal

from shared.config import config
from shared.infra.net import llm_requests_session
from shared.llm.model_capabilities import resolve_model_capabilities
from shared.llm.provider_catalog import ProviderDescriptor
from shared.llm.transports.wire_trace import WireTraceContext, WireTraceWriter

ToolChoiceMode = Literal["auto", "none"]
_REDACTED_THINKING_PLACEHOLDER = "[部分思考已加密]"


class AnthropicStreamError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class AnthropicStreamEvent:
    event_type: str
    index: int = -1
    text: str = ""
    thinking_text: str = ""
    signature: str = ""
    redacted_data: str = ""
    tool_id: str = ""
    tool_name: str = ""
    tool_input: dict[str, Any] = field(default_factory=dict)
    usage: dict[str, Any] = field(default_factory=dict)
    stop_reason: str = ""
    message_id: str = ""
    model: str = ""
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class AnthropicStreamCompletion:
    raw: dict[str, Any]
    usage: dict[str, Any]
    stop_reason: str
    message_id: str
    content: list[dict[str, Any]] = field(default_factory=list)


def _message_endpoint(base_url: str) -> str:
    return f"{str(base_url or '').rstrip('/')}/v1/messages"


def _headers(descriptor: ProviderDescriptor) -> dict[str, str]:
    headers = {
        "content-type": "application/json",
        "x-api-key": descriptor.api_key,
    }
    for key, value in dict(descriptor.default_headers or {}).items():
        safe_key = str(key or "").strip()
        safe_value = str(value or "").strip()
        if safe_key and safe_value:
            headers[safe_key] = safe_value
    headers.setdefault("anthropic-version", "2023-06-01")
    return headers


def _include_temperature(descriptor: ProviderDescriptor) -> bool:
    capabilities = resolve_model_capabilities(descriptor.name, descriptor.default_model)
    return bool(capabilities.supports_temperature)


def _thinking_payload(descriptor: ProviderDescriptor) -> dict[str, str] | None:
    if str(descriptor.name or "").strip() == "kimi_coding":
        enabled = bool(getattr(config, "KIMI_CODE_THINKING_ENABLED", True))
        return {"type": "enabled" if enabled else "disabled"}
    capabilities = resolve_model_capabilities(descriptor.name, descriptor.default_model)
    if not capabilities.supports_thinking:
        return {"type": "disabled"}
    return None


def _iter_sse_events(
    lines: Iterable[str],
    *,
    wire_trace_writer: WireTraceWriter | None = None,
) -> Iterable[tuple[str, str]]:
    event_name = "message"
    data_lines: list[str] = []
    for raw_line in lines:
        line = str(raw_line or "")
        if line.endswith("\r"):
            line = line[:-1]
        if not line:
            if data_lines:
                raw_data = "\n".join(data_lines)
                if wire_trace_writer is not None:
                    wire_trace_writer.write_wire_event(event_name=event_name, raw_data=raw_data)
                yield event_name, raw_data
            event_name = "message"
            data_lines = []
            continue
        if line.startswith(":"):
            continue
        field, sep, value = line.partition(":")
        if not sep:
            continue
        if value.startswith(" "):
            value = value[1:]
        if field == "event":
            event_name = value or "message"
            continue
        if field == "data":
            data_lines.append(value)
    if data_lines:
        raw_data = "\n".join(data_lines)
        if wire_trace_writer is not None:
            wire_trace_writer.write_wire_event(event_name=event_name, raw_data=raw_data)
        yield event_name, raw_data


def _error_message(payload: dict[str, Any]) -> str:
    error = payload.get("error")
    if isinstance(error, dict):
        message = str(error.get("message") or "").strip()
        if message:
            return message
    message = str(payload.get("message") or "").strip()
    if message:
        return message
    return str(payload or "stream error")


def iter_anthropic_sse_events(
    lines: Iterable[str],
    *,
    wire_trace_writer: WireTraceWriter | None = None,
) -> Iterable[AnthropicStreamEvent]:
    tool_metadata_by_index: dict[int, dict[str, str]] = {}
    tool_initial_input_by_index: dict[int, dict[str, Any]] = {}
    tool_input_buffer_by_index: dict[int, list[str]] = {}

    for event_name, raw_data in _iter_sse_events(lines, wire_trace_writer=wire_trace_writer):
        if not raw_data or raw_data == "[DONE]" or event_name == "ping":
            continue
        try:
            payload = json.loads(raw_data)
        except json.JSONDecodeError as exc:
            if wire_trace_writer is not None:
                wire_trace_writer.write_parse_error(event_name=event_name, raw_data=raw_data, error=exc)
            raise AnthropicStreamError(f"Invalid SSE payload JSON: {raw_data[:200]}") from exc

        event_type = str(payload.get("type") or event_name or "").strip()
        if event_type == "ping":
            continue
        if event_type == "error" or event_name == "error":
            raise AnthropicStreamError(_error_message(payload))

        if event_type == "message_start":
            message = dict(payload.get("message") or {})
            yield AnthropicStreamEvent(
                event_type="message_start",
                usage=dict(message.get("usage") or {}),
                message_id=str(message.get("id") or "").strip(),
                model=str(message.get("model") or "").strip(),
                raw=payload,
            )
            continue

        if event_type == "content_block_start":
            index = int(payload.get("index") or 0)
            block = dict(payload.get("content_block") or {})
            block_type = str(block.get("type") or "").strip()
            if block_type == "text":
                initial_text = str(block.get("text") or "")
                if initial_text:
                    yield AnthropicStreamEvent(
                        event_type="text_delta",
                        index=index,
                        text=initial_text,
                        raw=payload,
                    )
                continue
            if block_type == "thinking":
                initial_thinking = str(block.get("thinking") or "")
                if initial_thinking:
                    yield AnthropicStreamEvent(
                        event_type="thinking_delta",
                        index=index,
                        text=initial_thinking,
                        thinking_text=initial_thinking,
                        raw=payload,
                    )
                initial_signature = str(block.get("signature") or "").strip()
                if initial_signature:
                    yield AnthropicStreamEvent(
                        event_type="thinking_signature",
                        index=index,
                        signature=initial_signature,
                        raw=payload,
                    )
                continue
            if block_type == "redacted_thinking":
                yield AnthropicStreamEvent(
                    event_type="redacted_thinking",
                    index=index,
                    text=_REDACTED_THINKING_PLACEHOLDER,
                    redacted_data=str(block.get("data") or ""),
                    raw=payload,
                )
                continue
            if block_type == "tool_use":
                tool_metadata_by_index[index] = {
                    "id": str(block.get("id") or "").strip(),
                    "name": str(block.get("name") or "").strip(),
                }
                tool_initial_input_by_index[index] = (
                    dict(block.get("input") or {}) if isinstance(block.get("input"), dict) else {}
                )
                tool_input_buffer_by_index[index] = []
            continue

        if event_type == "content_block_delta":
            index = int(payload.get("index") or 0)
            delta = dict(payload.get("delta") or {})
            delta_type = str(delta.get("type") or "").strip()
            if delta_type == "text_delta":
                yield AnthropicStreamEvent(
                    event_type="text_delta",
                    index=index,
                    text=str(delta.get("text") or ""),
                    raw=payload,
                )
                continue
            if delta_type == "thinking_delta":
                thinking_text = str(delta.get("thinking") or "")
                yield AnthropicStreamEvent(
                    event_type="thinking_delta",
                    index=index,
                    text=thinking_text,
                    thinking_text=thinking_text,
                    raw=payload,
                )
                continue
            if delta_type == "signature_delta":
                yield AnthropicStreamEvent(
                    event_type="thinking_signature",
                    index=index,
                    signature=str(delta.get("signature") or "").strip(),
                    raw=payload,
                )
                continue
            if delta_type == "input_json_delta":
                tool_input_buffer_by_index.setdefault(index, []).append(str(delta.get("partial_json") or ""))
                continue
            continue

        if event_type == "content_block_stop":
            index = int(payload.get("index") or 0)
            if index not in tool_metadata_by_index:
                continue
            raw_json = "".join(tool_input_buffer_by_index.pop(index, [])).strip()
            parsed_input: dict[str, Any] = dict(tool_initial_input_by_index.pop(index, {}) or {})
            if raw_json:
                try:
                    parsed = json.loads(raw_json)
                except json.JSONDecodeError as exc:
                    raise AnthropicStreamError(f"Invalid tool_use JSON for block {index}: {raw_json[:200]}") from exc
                if not isinstance(parsed, dict):
                    raise AnthropicStreamError(f"tool_use input must decode to object for block {index}")
                parsed_input.update(parsed)
            metadata = tool_metadata_by_index.pop(index)
            yield AnthropicStreamEvent(
                event_type="tool_use",
                index=index,
                tool_id=metadata["id"],
                tool_name=metadata["name"],
                tool_input=parsed_input,
                raw=payload,
            )
            continue

        if event_type == "message_delta":
            delta = dict(payload.get("delta") or {})
            yield AnthropicStreamEvent(
                event_type="message_delta",
                stop_reason=str(delta.get("stop_reason") or "").strip(),
                usage=dict(payload.get("usage") or {}),
                raw=payload,
            )
            continue

        if event_type == "message_stop":
            yield AnthropicStreamEvent(event_type="message_stop", raw=payload)
            continue


def parse_anthropic_sse_lines(
    lines: Iterable[str],
    *,
    wire_trace_writer: WireTraceWriter | None = None,
) -> AnthropicStreamCompletion:
    response_payload: dict[str, Any] = {
        "id": "",
        "type": "message",
        "role": "assistant",
        "model": "",
        "content": [],
        "usage": {},
        "stop_reason": "",
        "stream_events": [],
    }
    blocks_by_index: dict[int, dict[str, Any]] = {}
    text_parts_by_index: dict[int, list[str]] = {}
    thinking_parts_by_index: dict[int, list[str]] = {}
    tool_use_by_index: dict[int, dict[str, Any]] = {}
    tool_input_buffer_by_index: dict[int, list[str]] = {}
    saw_message_stop = False

    for event_name, raw_data in _iter_sse_events(lines, wire_trace_writer=wire_trace_writer):
        if not raw_data or raw_data == "[DONE]" or event_name == "ping":
            continue
        try:
            payload = json.loads(raw_data)
        except json.JSONDecodeError as exc:
            if wire_trace_writer is not None:
                wire_trace_writer.write_parse_error(event_name=event_name, raw_data=raw_data, error=exc)
            raise AnthropicStreamError(f"Invalid SSE payload JSON: {raw_data[:200]}") from exc

        event_type = str(payload.get("type") or event_name or "").strip()
        if event_type == "ping":
            continue
        response_payload["stream_events"].append(
            {
                "event": event_name,
                "type": event_type,
                "index": payload.get("index"),
            }
        )
        if event_type == "error" or event_name == "error":
            raise AnthropicStreamError(_error_message(payload))

        if event_type == "message_start":
            message = dict(payload.get("message") or {})
            response_payload["id"] = str(message.get("id") or "").strip()
            response_payload["role"] = str(message.get("role") or "assistant").strip() or "assistant"
            response_payload["model"] = str(message.get("model") or "").strip()
            response_payload["usage"] = dict(message.get("usage") or {})
            continue

        if event_type == "content_block_start":
            index = int(payload.get("index") or 0)
            block = dict(payload.get("content_block") or {})
            block_type = str(block.get("type") or "").strip()
            if block_type == "text":
                text = str(block.get("text") or "")
                blocks_by_index[index] = {"type": "text", "text": text}
                text_parts_by_index[index] = [text]
                continue
            if block_type == "thinking":
                thinking = str(block.get("thinking") or "")
                blocks_by_index[index] = {
                    "type": "thinking",
                    "thinking": thinking,
                    "signature": str(block.get("signature") or "").strip(),
                }
                thinking_parts_by_index[index] = [thinking]
                continue
            if block_type == "redacted_thinking":
                blocks_by_index[index] = {
                    "type": "redacted_thinking",
                    "data": str(block.get("data") or ""),
                }
                continue
            if block_type == "tool_use":
                tool_block = {
                    "type": "tool_use",
                    "id": str(block.get("id") or "").strip(),
                    "name": str(block.get("name") or "").strip(),
                    "input": dict(block.get("input") or {}) if isinstance(block.get("input"), dict) else {},
                }
                blocks_by_index[index] = tool_block
                tool_use_by_index[index] = tool_block
                tool_input_buffer_by_index[index] = []
                continue
            blocks_by_index[index] = dict(block)
            continue

        if event_type == "content_block_delta":
            index = int(payload.get("index") or 0)
            delta = dict(payload.get("delta") or {})
            delta_type = str(delta.get("type") or "").strip()
            if delta_type == "text_delta":
                text_parts_by_index.setdefault(index, []).append(str(delta.get("text") or ""))
                block = blocks_by_index.setdefault(index, {"type": "text", "text": ""})
                if str(block.get("type") or "").strip() == "text":
                    block["text"] = "".join(text_parts_by_index[index])
                continue
            if delta_type == "thinking_delta":
                thinking_parts_by_index.setdefault(index, []).append(str(delta.get("thinking") or ""))
                block = blocks_by_index.setdefault(index, {"type": "thinking", "thinking": "", "signature": ""})
                if str(block.get("type") or "").strip() == "thinking":
                    block["thinking"] = "".join(thinking_parts_by_index[index])
                continue
            if delta_type == "signature_delta":
                block = blocks_by_index.setdefault(index, {"type": "thinking", "thinking": "", "signature": ""})
                if str(block.get("type") or "").strip() == "thinking":
                    block["signature"] = str(delta.get("signature") or "").strip()
                continue
            if delta_type == "input_json_delta":
                tool_input_buffer_by_index.setdefault(index, []).append(str(delta.get("partial_json") or ""))
                continue
            block = blocks_by_index.setdefault(index, {"type": "unknown"})
            block.setdefault("_deltas", []).append(delta)
            continue

        if event_type == "content_block_stop":
            index = int(payload.get("index") or 0)
            if index in text_parts_by_index:
                block = blocks_by_index.setdefault(index, {"type": "text", "text": ""})
                block["text"] = "".join(text_parts_by_index[index])
            if index in thinking_parts_by_index:
                block = blocks_by_index.setdefault(index, {"type": "thinking", "thinking": "", "signature": ""})
                if str(block.get("type") or "").strip() == "thinking":
                    block["thinking"] = "".join(thinking_parts_by_index[index])
            if index in tool_use_by_index:
                raw_json = "".join(tool_input_buffer_by_index.get(index) or []).strip()
                parsed_input = dict(tool_use_by_index[index].get("input") or {})
                if raw_json:
                    try:
                        parsed = json.loads(raw_json)
                    except json.JSONDecodeError as exc:
                        raise AnthropicStreamError(f"Invalid tool_use JSON for block {index}: {raw_json[:200]}") from exc
                    if not isinstance(parsed, dict):
                        raise AnthropicStreamError(f"tool_use input must decode to object for block {index}")
                    parsed_input.update(parsed)
                tool_use_by_index[index]["input"] = parsed_input
            continue

        if event_type == "message_delta":
            delta = dict(payload.get("delta") or {})
            stop_reason = str(delta.get("stop_reason") or "").strip()
            if stop_reason:
                response_payload["stop_reason"] = stop_reason
            usage = dict(payload.get("usage") or {})
            if usage:
                response_payload["usage"].update(usage)
            continue

        if event_type == "message_stop":
            saw_message_stop = True
            continue

    if not saw_message_stop:
        raise AnthropicStreamError("SSE stream ended before message_stop")

    response_payload["content"] = [blocks_by_index[index] for index in sorted(blocks_by_index)]
    return AnthropicStreamCompletion(
        raw=response_payload,
        usage=dict(response_payload.get("usage") or {}),
        stop_reason=str(response_payload.get("stop_reason") or "").strip(),
        message_id=str(response_payload.get("id") or "").strip(),
        content=list(response_payload.get("content") or []),
    )


def stream_message_events(
    *,
    descriptor: ProviderDescriptor,
    system_prompt: str,
    messages: list[dict[str, Any]],
    tool_schemas: list[dict[str, Any]] | None,
    tool_choice_mode: ToolChoiceMode = "auto",
    max_tokens: int,
    temperature: float,
    timeout_s: int,
    wire_trace_context: WireTraceContext | None = None,
) -> Iterable[AnthropicStreamEvent]:
    request_payload: dict[str, Any] = {
        "model": descriptor.default_model,
        "max_tokens": max(256, int(max_tokens)),
        "system": str(system_prompt or "").strip(),
        "messages": list(messages),
        "stream": True,
    }
    thinking_payload = _thinking_payload(descriptor)
    if thinking_payload is not None:
        request_payload["thinking"] = dict(thinking_payload)
    if _include_temperature(descriptor):
        request_payload["temperature"] = float(temperature)
    if tool_schemas is not None:
        request_payload["tools"] = list(tool_schemas)
    if tool_choice_mode == "none":
        request_payload["tool_choice"] = {"type": "none"}
    elif tool_schemas:
        request_payload["tool_choice"] = {"type": "auto"}

    endpoint = _message_endpoint(descriptor.base_url)
    request_headers = _headers(descriptor)
    wire_trace_writer = WireTraceWriter(context=wire_trace_context) if wire_trace_context is not None else None
    if wire_trace_writer is not None:
        wire_trace_writer.write_request_start(
            endpoint=endpoint,
            model=descriptor.default_model,
            timeout_s=int(timeout_s),
            request_headers=request_headers,
            request_payload=request_payload,
        )

    ok = False
    error_text = ""
    try:
        with llm_requests_session.post(
            endpoint,
            headers=request_headers,
            json=request_payload,
            timeout=float(timeout_s),
            stream=True,
        ) as response:
            if wire_trace_writer is not None:
                wire_trace_writer.write_response_start(
                    status_code=int(getattr(response, "status_code", 0) or 0),
                    response_headers=dict(getattr(response, "headers", None) or {}),
                )
            response.raise_for_status()
            yield from iter_anthropic_sse_events(
                response.iter_lines(decode_unicode=True),
                wire_trace_writer=wire_trace_writer,
            )
            ok = True
    except Exception as error:
        error_text = str(error or "").strip() or type(error).__name__
        raise
    finally:
        if wire_trace_writer is not None:
            wire_trace_writer.write_request_end(ok=ok, error=error_text)
            wire_trace_writer.close()


def complete_streaming_message(
    *,
    descriptor: ProviderDescriptor,
    system_prompt: str,
    messages: list[dict[str, Any]],
    tool_schemas: list[dict[str, Any]] | None,
    tool_choice_mode: ToolChoiceMode = "auto",
    max_tokens: int,
    temperature: float,
    timeout_s: int,
    wire_trace_context: WireTraceContext | None = None,
) -> AnthropicStreamCompletion:
    request_payload: dict[str, Any] = {
        "model": descriptor.default_model,
        "max_tokens": max(256, int(max_tokens)),
        "system": str(system_prompt or "").strip(),
        "messages": list(messages),
        "stream": True,
    }
    thinking_payload = _thinking_payload(descriptor)
    if thinking_payload is not None:
        request_payload["thinking"] = dict(thinking_payload)
    if _include_temperature(descriptor):
        request_payload["temperature"] = float(temperature)
    if tool_schemas is not None:
        request_payload["tools"] = list(tool_schemas)
    if tool_choice_mode == "none":
        request_payload["tool_choice"] = {"type": "none"}
    elif tool_schemas:
        request_payload["tool_choice"] = {"type": "auto"}

    endpoint = _message_endpoint(descriptor.base_url)
    request_headers = _headers(descriptor)
    wire_trace_writer = WireTraceWriter(context=wire_trace_context) if wire_trace_context is not None else None
    if wire_trace_writer is not None:
        wire_trace_writer.write_request_start(
            endpoint=endpoint,
            model=descriptor.default_model,
            timeout_s=int(timeout_s),
            request_headers=request_headers,
            request_payload=request_payload,
        )

    ok = False
    error_text = ""
    try:
        with llm_requests_session.post(
            endpoint,
            headers=request_headers,
            json=request_payload,
            timeout=float(timeout_s),
            stream=True,
        ) as response:
            if wire_trace_writer is not None:
                wire_trace_writer.write_response_start(
                    status_code=int(getattr(response, "status_code", 0) or 0),
                    response_headers=dict(getattr(response, "headers", None) or {}),
                )
            response.raise_for_status()
            completion = parse_anthropic_sse_lines(
                response.iter_lines(decode_unicode=True),
                wire_trace_writer=wire_trace_writer,
            )
            ok = True
            return completion
    except Exception as error:
        error_text = str(error or "").strip() or type(error).__name__
        raise
    finally:
        if wire_trace_writer is not None:
            wire_trace_writer.write_request_end(ok=ok, error=error_text)
            wire_trace_writer.close()


__all__ = [
    "AnthropicStreamCompletion",
    "AnthropicStreamError",
    "AnthropicStreamEvent",
    "complete_streaming_message",
    "iter_anthropic_sse_events",
    "parse_anthropic_sse_lines",
    "stream_message_events",
]
