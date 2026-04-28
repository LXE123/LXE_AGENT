from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from shared.config import config
from shared.llm.agent_planner import active_agent_planner_descriptor, effective_agent_planner_max_tokens
from shared.llm.provider_catalog import ProviderDescriptor
from shared.llm.transports.anthropic_messages import complete_json_message, complete_text_message


@dataclass(frozen=True, slots=True)
class LongConversationLLMMetrics:
    provider: str
    model: str
    prompt_chars: int
    output_chars: int
    input_tokens: int
    output_tokens: int
    total_tokens: int
    elapsed_ms: int


def _config_text(name: str, default: str = "") -> str:
    return str(getattr(config, name, default) or default).strip()


def _config_int(name: str, default: int) -> int:
    try:
        return int(getattr(config, name, default) or default)
    except Exception:
        return int(default)


def long_conversation_provider_descriptor() -> ProviderDescriptor:
    return active_agent_planner_descriptor()


def _metrics(
    *,
    descriptor: ProviderDescriptor,
    system_prompt: str,
    user_text: str,
    output_text: str,
    usage: dict[str, Any],
    started_at: float,
) -> LongConversationLLMMetrics:
    input_tokens = int(dict(usage or {}).get("input_tokens") or 0)
    output_tokens = int(dict(usage or {}).get("output_tokens") or 0)
    return LongConversationLLMMetrics(
        provider=descriptor.name,
        model=descriptor.default_model,
        prompt_chars=len(str(system_prompt or "").strip()) + len(str(user_text or "")),
        output_chars=len(str(output_text or "").strip()),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        elapsed_ms=int((time.perf_counter() - started_at) * 1000),
    )


async def chat_text(
    system_prompt: str,
    user_text: str,
    *,
    temperature: float = 0.1,
    max_tokens: int = 512,
) -> str:
    text, _ = await chat_text_with_metrics(
        system_prompt,
        user_text,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    return text


async def chat_text_with_metrics(
    system_prompt: str,
    user_text: str,
    *,
    temperature: float = 0.1,
    max_tokens: int = 512,
) -> tuple[str, LongConversationLLMMetrics]:
    descriptor = long_conversation_provider_descriptor()
    effective_max_tokens = effective_agent_planner_max_tokens(max_tokens)
    started_at = time.perf_counter()
    completion = await complete_text_message(
        descriptor=descriptor,
        system_prompt=system_prompt,
        user_text=user_text,
        max_tokens=max(128, int(effective_max_tokens)),
        temperature=temperature,
        timeout_s=max(10, _config_int("LLM_REQUEST_TIMEOUT_S", 120)),
    )
    text = str(completion.text or "").strip()
    return text, _metrics(
        descriptor=descriptor,
        system_prompt=system_prompt,
        user_text=user_text,
        output_text=text,
        usage=completion.usage,
        started_at=started_at,
    )


async def chat_json_object(
    system_prompt: str,
    user_text: str,
    *,
    temperature: float = 0.1,
    max_tokens: int = 512,
) -> dict[str, Any] | None:
    parsed, _ = await chat_json_object_with_metrics(
        system_prompt,
        user_text,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    return parsed


async def chat_json_object_with_metrics(
    system_prompt: str,
    user_text: str,
    *,
    temperature: float = 0.1,
    max_tokens: int = 512,
) -> tuple[dict[str, Any] | None, LongConversationLLMMetrics]:
    descriptor = long_conversation_provider_descriptor()
    effective_max_tokens = effective_agent_planner_max_tokens(max_tokens)
    started_at = time.perf_counter()
    parsed, completion = await complete_json_message(
        descriptor=descriptor,
        system_prompt=system_prompt,
        user_text=user_text,
        max_tokens=max(128, int(effective_max_tokens)),
        temperature=temperature,
        timeout_s=max(10, _config_int("LLM_REQUEST_TIMEOUT_S", 120)),
    )
    text = str(completion.text or "").strip()
    return parsed, _metrics(
        descriptor=descriptor,
        system_prompt=system_prompt,
        user_text=user_text,
        output_text=text,
        usage=completion.usage,
        started_at=started_at,
    )


__all__ = [
    "LongConversationLLMMetrics",
    "chat_json_object",
    "chat_json_object_with_metrics",
    "chat_text",
    "chat_text_with_metrics",
    "long_conversation_provider_descriptor",
]
