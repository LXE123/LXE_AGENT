from __future__ import annotations

import json
from typing import Any, Iterable, Literal

from anthropic import Anthropic

from shared.llm.provider_catalog import ProviderDescriptor
from shared.llm.transports.anthropic_stream import AnthropicStreamEvent, iter_anthropic_sse_events
from shared.llm.transports.wire_trace import WireTraceContext, WireTraceWriter

ToolChoiceMode = Literal["auto", "none"]


def _message_endpoint(base_url: str) -> str:
    return f"{str(base_url or '').rstrip('/')}/v1/messages"


def _sdk_event_payload(event: Any) -> dict[str, Any]:
    if hasattr(event, "model_dump"):
        payload = event.model_dump(mode="json")
        return dict(payload or {})
    if isinstance(event, dict):
        return dict(event)
    return dict(getattr(event, "__dict__", {}) or {})


def _sdk_event_sse_lines(events: Iterable[Any]) -> Iterable[str]:
    for event in events:
        payload = _sdk_event_payload(event)
        event_name = str(payload.get("type") or "message").strip() or "message"
        yield f"event: {event_name}"
        yield "data: " + json.dumps(payload, ensure_ascii=False)
        yield ""


def _request_payload(
    *,
    descriptor: ProviderDescriptor,
    system_prompt: str,
    messages: list[dict[str, Any]],
    tool_schemas: list[dict[str, Any]] | None,
    tool_choice_mode: ToolChoiceMode,
    max_tokens: int,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": descriptor.default_model,
        "max_tokens": max(256, int(max_tokens)),
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
    max_tokens: int,
    temperature: float,
    timeout_s: int,
    wire_trace_context: WireTraceContext | None = None,
) -> Iterable[AnthropicStreamEvent]:
    _ = temperature
    request_payload = _request_payload(
        descriptor=descriptor,
        system_prompt=system_prompt,
        messages=messages,
        tool_schemas=tool_schemas,
        tool_choice_mode=tool_choice_mode,
        max_tokens=max_tokens,
    )
    client = Anthropic(
        api_key=descriptor.api_key,
        base_url=str(descriptor.base_url or "").rstrip("/"),
    )
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
    try:
        stream = client.messages.create(**request_payload, timeout=float(timeout_s))
        if wire_trace_writer is not None:
            wire_trace_writer.write_response_start(
                status_code=0,
                response_headers={"source": "anthropic-sdk"},
            )
        with stream:
            yield from iter_anthropic_sse_events(
                _sdk_event_sse_lines(stream),
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


__all__ = [
    "stream_message_events",
]
