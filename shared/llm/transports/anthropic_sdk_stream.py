from __future__ import annotations

import json
from typing import Any, Callable, Iterable, Literal

from anthropic import Anthropic

from shared.llm.errors import AnthropicStreamError
from shared.llm.events import LLMStreamEvent, LLMToolCall
from shared.llm.provider_catalog import ProviderDescriptor
from shared.llm.transports.wire_trace import WireTraceContext, WireTraceWriter

ToolChoiceMode = Literal["auto", "none"]
_ANTHROPIC_DEFAULT_OUTPUT_LIMIT = 128_000
_KIMI_CODING_PROVIDER_NAME = "kimi_coding"
_KIMI_CODE_USER_AGENT = "claude-code/0.1.0"
_REDACTED_THINKING_PLACEHOLDER = "[部分思考已加密]"


def _message_endpoint(base_url: str) -> str:
    return f"{str(base_url or '').rstrip('/')}/v1/messages"


def _client_default_headers(descriptor: ProviderDescriptor) -> dict[str, str] | None:
    if str(descriptor.name or "").strip() != _KIMI_CODING_PROVIDER_NAME:
        return None
    user_agent = str(dict(descriptor.default_headers or {}).get("User-Agent") or "").strip()
    return {"User-Agent": user_agent or _KIMI_CODE_USER_AGENT}


def _sdk_event_payload(event: Any) -> dict[str, Any]:
    if isinstance(event, dict):
        return dict(event)
    if hasattr(event, "model_dump"):
        payload = event.model_dump(mode="json")
        return dict(payload or {})
    return dict(getattr(event, "__dict__", {}) or {})


def _field(obj: Any, payload: dict[str, Any], name: str, default: Any = None) -> Any:
    if obj is not None and not isinstance(obj, dict) and hasattr(obj, name):
        value = getattr(obj, name)
        if value is not None:
            return value
    return payload.get(name, default)


def _object_payload(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    return _sdk_event_payload(value)


def _object_dict(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    payload = _object_payload(value)
    return dict(payload or {})


def _int_value(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return int(default)


def _write_sdk_wire_event(
    writer: WireTraceWriter | None,
    *,
    event_name: str,
    payload: dict[str, Any],
) -> None:
    if writer is None:
        return
    writer.write_wire_event(
        event_name=event_name or "message",
        raw_data=json.dumps(payload, ensure_ascii=False, default=str),
    )


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


def _iter_sdk_stream_events(
    events: Iterable[Any],
    *,
    wire_trace_writer: WireTraceWriter | None = None,
    cancel_event: Any = None,
) -> Iterable[LLMStreamEvent]:
    tool_metadata_by_index: dict[int, dict[str, str]] = {}
    tool_initial_input_by_index: dict[int, dict[str, Any]] = {}
    tool_input_buffer_by_index: dict[int, list[str]] = {}

    for event in events:
        if cancel_event is not None and bool(cancel_event.is_set()):
            yield LLMStreamEvent(event_type="cancelled")
            return
        payload = _sdk_event_payload(event)
        event_type = str(_field(event, payload, "type", payload.get("type") or "") or "").strip()
        _write_sdk_wire_event(wire_trace_writer, event_name=event_type, payload=payload)

        if event_type == "ping":
            continue
        if event_type == "error":
            raise AnthropicStreamError(_error_message(payload))

        if event_type == "message_start":
            message = _field(event, payload, "message", payload.get("message") or {})
            message_payload = _object_payload(message)
            usage = _object_dict(_field(message, message_payload, "usage", message_payload.get("usage") or {}))
            yield LLMStreamEvent(
                event_type="message_start",
                usage=usage,
                message_id=str(_field(message, message_payload, "id", message_payload.get("id") or "") or "").strip(),
                model=str(_field(message, message_payload, "model", message_payload.get("model") or "") or "").strip(),
                raw=payload,
            )
            continue

        if event_type == "content_block_start":
            index = _int_value(_field(event, payload, "index", payload.get("index") or 0))
            block = _field(event, payload, "content_block", payload.get("content_block") or {})
            block_payload = _object_payload(block)
            block_type = str(_field(block, block_payload, "type", block_payload.get("type") or "") or "").strip()

            if block_type == "text":
                initial_text = str(_field(block, block_payload, "text", block_payload.get("text") or "") or "")
                if initial_text:
                    yield LLMStreamEvent(
                        event_type="text_delta",
                        index=index,
                        text=initial_text,
                        raw=payload,
                    )
                continue

            if block_type == "thinking":
                initial_thinking = str(
                    _field(block, block_payload, "thinking", block_payload.get("thinking") or "") or ""
                )
                if initial_thinking:
                    yield LLMStreamEvent(
                        event_type="thinking_delta",
                        index=index,
                        text=initial_thinking,
                        thinking_text=initial_thinking,
                        raw=payload,
                    )
                initial_signature = str(
                    _field(block, block_payload, "signature", block_payload.get("signature") or "") or ""
                ).strip()
                if initial_signature:
                    yield LLMStreamEvent(
                        event_type="thinking_signature",
                        index=index,
                        signature=initial_signature,
                        raw=payload,
                    )
                continue

            if block_type == "redacted_thinking":
                yield LLMStreamEvent(
                    event_type="redacted_thinking",
                    index=index,
                    text=_REDACTED_THINKING_PLACEHOLDER,
                    redacted_data=str(_field(block, block_payload, "data", block_payload.get("data") or "") or ""),
                    raw=payload,
                )
                continue

            if block_type == "tool_use":
                initial_input = _field(block, block_payload, "input", block_payload.get("input") or {})
                tool_metadata_by_index[index] = {
                    "id": str(_field(block, block_payload, "id", block_payload.get("id") or "") or "").strip(),
                    "name": str(_field(block, block_payload, "name", block_payload.get("name") or "") or "").strip(),
                }
                tool_initial_input_by_index[index] = _object_dict(initial_input)
                tool_input_buffer_by_index[index] = []
            continue

        if event_type == "content_block_delta":
            index = _int_value(_field(event, payload, "index", payload.get("index") or 0))
            delta = _field(event, payload, "delta", payload.get("delta") or {})
            delta_payload = _object_payload(delta)
            delta_type = str(_field(delta, delta_payload, "type", delta_payload.get("type") or "") or "").strip()

            if delta_type == "text_delta":
                yield LLMStreamEvent(
                    event_type="text_delta",
                    index=index,
                    text=str(_field(delta, delta_payload, "text", delta_payload.get("text") or "") or ""),
                    raw=payload,
                )
                continue

            if delta_type == "thinking_delta":
                thinking_text = str(
                    _field(delta, delta_payload, "thinking", delta_payload.get("thinking") or "") or ""
                )
                yield LLMStreamEvent(
                    event_type="thinking_delta",
                    index=index,
                    text=thinking_text,
                    thinking_text=thinking_text,
                    raw=payload,
                )
                continue

            if delta_type == "signature_delta":
                yield LLMStreamEvent(
                    event_type="thinking_signature",
                    index=index,
                    signature=str(
                        _field(delta, delta_payload, "signature", delta_payload.get("signature") or "") or ""
                    ).strip(),
                    raw=payload,
                )
                continue

            if delta_type == "input_json_delta":
                partial_json = str(
                    _field(delta, delta_payload, "partial_json", delta_payload.get("partial_json") or "") or ""
                )
                tool_input_buffer_by_index.setdefault(index, []).append(partial_json)
                continue

            continue

        if event_type == "content_block_stop":
            index = _int_value(_field(event, payload, "index", payload.get("index") or 0))
            if index not in tool_metadata_by_index:
                continue
            raw_json = "".join(tool_input_buffer_by_index.pop(index, [])).strip()
            parsed_input = dict(tool_initial_input_by_index.pop(index, {}) or {})
            if raw_json:
                try:
                    parsed = json.loads(raw_json)
                except json.JSONDecodeError as exc:
                    raise AnthropicStreamError(f"Invalid tool_use JSON for block {index}: {raw_json[:200]}") from exc
                if not isinstance(parsed, dict):
                    raise AnthropicStreamError(f"tool_use input must decode to object for block {index}")
                parsed_input.update(parsed)
            metadata = tool_metadata_by_index.pop(index)
            yield LLMStreamEvent(
                event_type="tool_use",
                index=index,
                tool_call=LLMToolCall(
                    id=metadata["id"],
                    name=metadata["name"],
                    arguments=parsed_input,
                ),
                raw=payload,
            )
            continue

        if event_type == "message_delta":
            delta = _field(event, payload, "delta", payload.get("delta") or {})
            delta_payload = _object_payload(delta)
            yield LLMStreamEvent(
                event_type="message_delta",
                stop_reason=str(
                    _field(delta, delta_payload, "stop_reason", delta_payload.get("stop_reason") or "") or ""
                ).strip(),
                usage=_object_dict(_field(event, payload, "usage", payload.get("usage") or {})),
                raw=payload,
            )
            continue

        if event_type == "message_stop":
            yield LLMStreamEvent(event_type="message_stop", raw=payload)
            continue


def _request_payload(
    *,
    descriptor: ProviderDescriptor,
    system_prompt: str,
    messages: list[dict[str, Any]],
    tool_schemas: list[dict[str, Any]] | None,
    tool_choice_mode: ToolChoiceMode,
    max_tokens: int | None,
) -> dict[str, Any]:
    model_limit = max(1, int(descriptor.max_tokens or _ANTHROPIC_DEFAULT_OUTPUT_LIMIT))
    requested_limit = model_limit if max_tokens is None else max(1, min(int(max_tokens), model_limit))
    payload: dict[str, Any] = {
        "model": descriptor.default_model,
        "max_tokens": requested_limit,
        "system": str(system_prompt or "").strip(),
        "messages": list(messages),
        "stream": True,
    }
    if tool_schemas is not None:
        payload["tools"] = list(tool_schemas)
    if tool_choice_mode == "none":
        payload["tool_choice"] = {"type": "none"}
    elif tool_schemas:
        payload["tool_choice"] = {"type": "auto"}
    return payload


def stream_message_events(
    *,
    descriptor: ProviderDescriptor,
    system_prompt: str,
    messages: list[dict[str, Any]],
    tool_schemas: list[dict[str, Any]] | None,
    tool_choice_mode: ToolChoiceMode = "auto",
    max_tokens: int | None,
    temperature: float,
    timeout_s: int,
    wire_trace_context: WireTraceContext | None = None,
    cancel_event: Any = None,
    provider_cancel_registrar: Callable[[Callable[[], None] | None], None] | None = None,
) -> Iterable[LLMStreamEvent]:
    _ = temperature
    request_payload = _request_payload(
        descriptor=descriptor,
        system_prompt=system_prompt,
        messages=messages,
        tool_schemas=tool_schemas,
        tool_choice_mode=tool_choice_mode,
        max_tokens=max_tokens,
    )
    client_kwargs: dict[str, Any] = {
        "api_key": descriptor.api_key,
        "base_url": str(descriptor.base_url or "").rstrip("/"),
    }
    client_default_headers = _client_default_headers(descriptor)
    if client_default_headers:
        client_kwargs["default_headers"] = client_default_headers
    client = Anthropic(**client_kwargs)
    request_headers = dict(getattr(client, "default_headers", {}) or {})
    endpoint = _message_endpoint(descriptor.base_url)
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
    stream = None

    def _close_targets() -> None:
        for close_target in (stream, client):
            close_func = getattr(close_target, "close", None)
            if callable(close_func):
                try:
                    close_func()
                except Exception:
                    pass

    def _register_cancel_handle() -> None:
        if provider_cancel_registrar is None:
            return
        provider_cancel_registrar(_close_targets)

    _register_cancel_handle()
    try:
        stream = client.messages.create(**request_payload, timeout=float(timeout_s))
        _register_cancel_handle()
        if wire_trace_writer is not None:
            wire_trace_writer.write_response_start(
                status_code=0,
                response_headers={"source": "anthropic-sdk"},
            )
        with stream:
            yield from _iter_sdk_stream_events(
                stream,
                wire_trace_writer=wire_trace_writer,
                cancel_event=cancel_event,
            )
            ok = True
    except Exception as error:
        error_text = str(error or "").strip() or type(error).__name__
        raise
    finally:
        if cancel_event is not None and bool(cancel_event.is_set()):
            _close_targets()
        if provider_cancel_registrar is not None:
            provider_cancel_registrar(None)
        if wire_trace_writer is not None:
            wire_trace_writer.write_request_end(ok=ok, error=error_text)
            wire_trace_writer.close()


__all__ = [
    "stream_message_events",
]
