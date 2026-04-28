from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass, field
from typing import Any

from shared.infra.net import llm_requests_session
from shared.llm.model_capabilities import resolve_model_capabilities
from shared.llm.provider_catalog import ProviderDescriptor


@dataclass(frozen=True, slots=True)
class ToolUseDecision:
    tool_name: str
    arguments: dict[str, Any]
    text: str
    raw: dict[str, Any]
    metrics: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class MessageCompletion:
    text: str
    raw: dict[str, Any]
    usage: dict[str, Any]


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


def _user_content(turn_packet: dict[str, Any]) -> list[dict[str, str]]:
    payload = json.dumps(dict(turn_packet or {}), ensure_ascii=False, indent=2)
    return [{"type": "text", "text": payload}]


def _text_content(text: str) -> list[dict[str, str]]:
    return [{"type": "text", "text": str(text or "")}]


def _collect_text_blocks(content_blocks: list[dict[str, Any]] | None) -> str:
    lines: list[str] = []
    for block in list(content_blocks or []):
        if str(dict(block or {}).get("type") or "").strip() != "text":
            continue
        text = str(dict(block or {}).get("text") or "").strip()
        if text:
            lines.append(text)
    return "\n".join(lines).strip()


def _include_temperature(descriptor: ProviderDescriptor) -> bool:
    capabilities = resolve_model_capabilities(descriptor.name, descriptor.default_model)
    return bool(capabilities.supports_temperature)


def _strip_code_fence(text: str) -> str:
    stripped = str(text or "").strip()
    if not stripped.startswith("```"):
        return stripped
    lines = stripped.splitlines()
    if len(lines) >= 2 and lines[0].startswith("```") and lines[-1].strip() == "```":
        return "\n".join(lines[1:-1]).strip()
    return stripped


def _parse_json_object(content: str) -> dict[str, Any] | None:
    cleaned = _strip_code_fence(content)
    candidates = [cleaned]
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start >= 0 and end > start:
        candidates.append(cleaned[start : end + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _sync_complete_message(
    *,
    descriptor: ProviderDescriptor,
    system_prompt: str,
    user_text: str,
    max_tokens: int,
    temperature: float,
    timeout_s: int,
) -> MessageCompletion:
    request_payload = {
        "model": descriptor.default_model,
        "max_tokens": max(128, int(max_tokens)),
        "system": str(system_prompt or "").strip(),
        "messages": [
            {
                "role": "user",
                "content": _text_content(user_text),
            }
        ],
    }
    if _include_temperature(descriptor):
        request_payload["temperature"] = float(temperature)

    response = llm_requests_session.post(
        _message_endpoint(descriptor.base_url),
        headers=_headers(descriptor),
        json=request_payload,
        timeout=float(timeout_s),
    )
    response.raise_for_status()
    payload = dict(response.json() or {})
    return MessageCompletion(
        text=_collect_text_blocks(payload.get("content")),
        raw=payload,
        usage=dict(payload.get("usage") or {}),
    )


def _sync_plan_tool_call(
    *,
    descriptor: ProviderDescriptor,
    system_prompt: str,
    turn_packet: dict[str, Any],
    tool_schemas: list[dict[str, Any]],
    max_tokens: int,
    temperature: float,
    timeout_s: int,
) -> ToolUseDecision:
    started_at = time.perf_counter()
    request_payload = {
        "model": descriptor.default_model,
        "max_tokens": max(256, int(max_tokens)),
        "system": str(system_prompt or "").strip(),
        "messages": [
            {
                "role": "user",
                "content": _user_content(turn_packet),
            }
        ],
        "tools": list(tool_schemas or []),
        "tool_choice": {"type": "any"},
    }
    if _include_temperature(descriptor):
        request_payload["temperature"] = float(temperature)

    response = llm_requests_session.post(
        _message_endpoint(descriptor.base_url),
        headers=_headers(descriptor),
        json=request_payload,
        timeout=float(timeout_s),
    )
    response.raise_for_status()
    payload = dict(response.json() or {})
    usage = dict(payload.get("usage") or {})
    metrics = {
        "provider": descriptor.name,
        "model": descriptor.default_model,
        "prompt_tokens": int(usage.get("input_tokens") or 0),
        "completion_tokens": int(usage.get("output_tokens") or 0),
        "latency_ms": int((time.perf_counter() - started_at) * 1000),
    }
    text = _collect_text_blocks(payload.get("content"))
    for block in list(payload.get("content") or []):
        item = dict(block or {})
        if str(item.get("type") or "").strip() != "tool_use":
            continue
        return ToolUseDecision(
            tool_name=str(item.get("name") or "").strip(),
            arguments=dict(item.get("input") or {}),
            text=text,
            raw=payload,
            metrics=metrics,
        )
    raise RuntimeError(f"Planner returned no tool_use block: {text or payload}")


async def plan_tool_call(
    *,
    descriptor: ProviderDescriptor,
    system_prompt: str,
    turn_packet: dict[str, Any],
    tool_schemas: list[dict[str, Any]],
    max_tokens: int,
    temperature: float,
    timeout_s: int,
) -> ToolUseDecision:
    return await asyncio.to_thread(
        _sync_plan_tool_call,
        descriptor=descriptor,
        system_prompt=system_prompt,
        turn_packet=turn_packet,
        tool_schemas=tool_schemas,
        max_tokens=max_tokens,
        temperature=temperature,
        timeout_s=timeout_s,
    )


async def complete_text_message(
    *,
    descriptor: ProviderDescriptor,
    system_prompt: str,
    user_text: str,
    max_tokens: int,
    temperature: float,
    timeout_s: int,
) -> MessageCompletion:
    return await asyncio.to_thread(
        _sync_complete_message,
        descriptor=descriptor,
        system_prompt=system_prompt,
        user_text=user_text,
        max_tokens=max_tokens,
        temperature=temperature,
        timeout_s=timeout_s,
    )


async def complete_json_message(
    *,
    descriptor: ProviderDescriptor,
    system_prompt: str,
    user_text: str,
    max_tokens: int,
    temperature: float,
    timeout_s: int,
) -> tuple[dict[str, Any] | None, MessageCompletion]:
    completion = await complete_text_message(
        descriptor=descriptor,
        system_prompt=system_prompt,
        user_text=user_text,
        max_tokens=max_tokens,
        temperature=temperature,
        timeout_s=timeout_s,
    )
    return _parse_json_object(completion.text), completion


__all__ = [
    "MessageCompletion",
    "ToolUseDecision",
    "complete_json_message",
    "complete_text_message",
    "plan_tool_call",
]
