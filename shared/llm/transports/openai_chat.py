from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal

from openai import AsyncOpenAI

from shared.llm.provider_catalog import ProviderDescriptor

ToolChoiceMode = Literal["auto", "none"]


_CLIENT_CACHE: dict[tuple[str, str, int], AsyncOpenAI] = {}


@dataclass(frozen=True, slots=True)
class OpenAIToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True, slots=True)
class OpenAIChatCompletion:
    text: str
    raw: dict[str, Any]
    usage: dict[str, Any]
    tool_calls: list[OpenAIToolCall] = field(default_factory=list)


def _cached_client(descriptor: ProviderDescriptor, timeout_s: int) -> AsyncOpenAI:
    cache_key = (descriptor.base_url, descriptor.api_key, int(timeout_s))
    client = _CLIENT_CACHE.get(cache_key)
    if client is not None:
        return client
    client = AsyncOpenAI(
        api_key=descriptor.api_key,
        base_url=descriptor.base_url,
        timeout=float(timeout_s),
        default_headers=dict(descriptor.default_headers or {}),
    )
    _CLIENT_CACHE[cache_key] = client
    return client


def _prepend_system_message(system_prompt: str, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    payload = list(messages or [])
    system_text = str(system_prompt or "").strip()
    if system_text:
        return [{"role": "system", "content": system_text}, *payload]
    return payload


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


def _response_to_dict(response: Any) -> dict[str, Any]:
    if hasattr(response, "model_dump"):
        return dict(response.model_dump(mode="python"))
    if isinstance(response, dict):
        return dict(response)
    return {}


def _usage_to_dict(usage: Any) -> dict[str, Any]:
    if hasattr(usage, "model_dump"):
        return dict(usage.model_dump(mode="python"))
    if isinstance(usage, dict):
        return dict(usage)
    return {}


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            block = dict(item or {})
            if str(block.get("type") or "").strip() in {"text", "output_text"}:
                text = str(block.get("text") or block.get("content") or "").strip()
                if text:
                    parts.append(text)
        return "\n".join(parts).strip()
    return str(content or "").strip()


def _parse_tool_call_arguments(raw_arguments: Any) -> dict[str, Any]:
    if isinstance(raw_arguments, dict):
        return dict(raw_arguments)
    if raw_arguments is None:
        return {}
    try:
        parsed = json.loads(str(raw_arguments or "").strip())
    except Exception:
        return {}
    return dict(parsed) if isinstance(parsed, dict) else {}


async def chat_text(
    *,
    descriptor: ProviderDescriptor,
    system_prompt: str,
    user_text: str,
    temperature: float,
    timeout_s: int,
) -> str:
    response = await _cached_client(descriptor, timeout_s).chat.completions.create(
        model=descriptor.default_model,
        messages=_prepend_system_message(system_prompt, [{"role": "user", "content": str(user_text or "")}]),
        temperature=temperature,
        stream=False,
    )
    return _content_to_text(response.choices[0].message.content)


async def chat_json_object(
    *,
    descriptor: ProviderDescriptor,
    system_prompt: str,
    user_text: str,
    temperature: float,
    timeout_s: int,
) -> dict[str, Any] | None:
    response = await _cached_client(descriptor, timeout_s).chat.completions.create(
        model=descriptor.default_model,
        messages=_prepend_system_message(system_prompt, [{"role": "user", "content": str(user_text or "")}]),
        response_format={"type": "json_object"},
        temperature=temperature,
        stream=False,
    )
    return _parse_json_object(_content_to_text(response.choices[0].message.content))


async def chat_with_tools(
    *,
    descriptor: ProviderDescriptor,
    system_prompt: str,
    messages: list[dict[str, Any]],
    tool_schemas: list[dict[str, Any]] | None,
    tool_choice_mode: ToolChoiceMode = "auto",
    max_tokens: int,
    temperature: float,
    timeout_s: int,
) -> OpenAIChatCompletion:
    request_payload: dict[str, Any] = {
        "model": descriptor.default_model,
        "messages": _prepend_system_message(system_prompt, messages),
        "temperature": float(temperature),
        "max_tokens": max(256, int(max_tokens)),
        "stream": False,
    }
    if tool_schemas is not None:
        request_payload["tools"] = list(tool_schemas)
    if tool_choice_mode == "none":
        request_payload["tool_choice"] = "none"
    elif tool_schemas:
        request_payload["tool_choice"] = "auto"

    response = await _cached_client(descriptor, timeout_s).chat.completions.create(**request_payload)
    choice = response.choices[0].message

    tool_calls: list[OpenAIToolCall] = []
    for raw_tool_call in list(getattr(choice, "tool_calls", None) or []):
        function = getattr(raw_tool_call, "function", None)
        tool_calls.append(
            OpenAIToolCall(
                id=str(getattr(raw_tool_call, "id", "") or "").strip(),
                name=str(getattr(function, "name", "") or "").strip(),
                arguments=_parse_tool_call_arguments(getattr(function, "arguments", None)),
            )
        )

    return OpenAIChatCompletion(
        text=_content_to_text(getattr(choice, "content", "")),
        raw=_response_to_dict(response),
        usage=_usage_to_dict(getattr(response, "usage", None)),
        tool_calls=tool_calls,
    )


__all__ = [
    "OpenAIChatCompletion",
    "OpenAIToolCall",
    "chat_json_object",
    "chat_text",
    "chat_with_tools",
]
