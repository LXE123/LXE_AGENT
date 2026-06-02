from __future__ import annotations

import os
from dataclasses import dataclass, field

from shared.config import config
from shared.llm.deepseek import client as deepseek_client
from shared.llm.glm import client as glm_client
from shared.llm.kimi import client as kimi_client
from shared.llm.kimi_coding import client as kimi_coding_client


@dataclass(frozen=True, slots=True)
class ProviderDescriptor:
    name: str
    label: str
    api_style: str
    api_key: str
    base_url: str
    default_model: str
    default_headers: dict[str, str] = field(default_factory=dict)


_PROVIDER_ALIASES = {
    "deepseek": deepseek_client.PROVIDER_NAME,
    "deep_seek": deepseek_client.PROVIDER_NAME,
    "deep-seek": deepseek_client.PROVIDER_NAME,
    "kimi": kimi_client.PROVIDER_NAME,
    "moonshot": kimi_client.PROVIDER_NAME,
    "moon_shot": kimi_client.PROVIDER_NAME,
    "moon-shot": kimi_client.PROVIDER_NAME,
    "kimi_coding": kimi_coding_client.PROVIDER_NAME,
    "kimi-coding": kimi_coding_client.PROVIDER_NAME,
    "kimi_code": kimi_coding_client.PROVIDER_NAME,
    "kimi-code": kimi_coding_client.PROVIDER_NAME,
    "glm": glm_client.PROVIDER_NAME,
    "zhipu": glm_client.PROVIDER_NAME,
    "zhipuai": glm_client.PROVIDER_NAME,
    "bigmodel": glm_client.PROVIDER_NAME,
    "big_model": glm_client.PROVIDER_NAME,
    "big-model": glm_client.PROVIDER_NAME,
}


def _config_text(name: str, default: str = "") -> str:
    return str(getattr(config, name, default) or default).strip()


def normalize_provider_name(raw_name: str) -> str:
    safe_name = str(raw_name or "").strip().lower().replace("-", "_")
    safe_name = " ".join(safe_name.split()).replace(" ", "_")
    provider_name = _PROVIDER_ALIASES.get(safe_name, safe_name)
    if provider_name not in {
        deepseek_client.PROVIDER_NAME,
        kimi_client.PROVIDER_NAME,
        kimi_coding_client.PROVIDER_NAME,
        glm_client.PROVIDER_NAME,
    }:
        raise ValueError(f"Unsupported LLM provider: {raw_name}")
    return provider_name


def descriptor_for_provider(provider_name: str, *, model_override: str = "") -> ProviderDescriptor:
    normalized_name = normalize_provider_name(provider_name)
    if normalized_name == deepseek_client.PROVIDER_NAME:
        default_model = str(model_override or deepseek_client.default_model()).strip()
        return ProviderDescriptor(
            name=normalized_name,
            label=deepseek_client.provider_label(),
            api_style="openai-chat",
            api_key=deepseek_client.api_key(),
            base_url=deepseek_client.base_url(),
            default_model=default_model,
        )
    if normalized_name == kimi_client.PROVIDER_NAME:
        default_model = str(model_override or kimi_client.default_model()).strip()
        return ProviderDescriptor(
            name=normalized_name,
            label=kimi_client.provider_label(),
            api_style="openai-chat",
            api_key=kimi_client.api_key(),
            base_url=kimi_client.base_url(),
            default_model=default_model,
        )
    if normalized_name == glm_client.PROVIDER_NAME:
        default_model = str(model_override or glm_client.default_model()).strip()
        return ProviderDescriptor(
            name=normalized_name,
            label=glm_client.provider_label(),
            api_style="anthropic-messages",
            api_key=glm_client.api_key(),
            base_url=glm_client.base_url(),
            default_model=default_model,
            default_headers={
                "anthropic-version": glm_client.anthropic_version(),
            },
        )

    default_model = kimi_coding_client.normalize_model(
        model_override or _config_text("AMAZON_STORE_AGENT_PLANNER_MODEL") or kimi_coding_client.default_model()
    )
    return ProviderDescriptor(
        name=normalized_name,
        label=kimi_coding_client.provider_label(),
        api_style="anthropic-messages",
        api_key=kimi_coding_client.api_key(),
        base_url=kimi_coding_client.base_url(),
        default_model=default_model,
        default_headers={
            "User-Agent": kimi_coding_client.user_agent(),
            "anthropic-version": kimi_coding_client.anthropic_version(),
        },
    )


def default_chat_provider_name() -> str:
    return normalize_provider_name(_config_text("LLM_DEFAULT_PROVIDER", deepseek_client.PROVIDER_NAME))


def active_chat_provider_descriptor() -> ProviderDescriptor:
    provider_name = normalize_provider_name(os.getenv("LLM_ACTIVE_PROVIDER", "") or default_chat_provider_name())
    if provider_name == kimi_coding_client.PROVIDER_NAME:
        raise RuntimeError("Global chat runtime does not use kimi_coding; it is reserved for browser planning.")
    model_override = str(os.getenv("LLM_ACTIVE_MODEL", "") or _config_text("LLM_DEFAULT_MODEL") or "").strip()
    descriptor = descriptor_for_provider(provider_name, model_override=model_override)
    if not descriptor.api_key:
        raise RuntimeError(f"Missing API key for LLM provider: {provider_name}")
    return descriptor


def selection_options() -> list[ProviderDescriptor]:
    options = [
        descriptor_for_provider(deepseek_client.PROVIDER_NAME),
        descriptor_for_provider(kimi_client.PROVIDER_NAME),
    ]
    return options


__all__ = [
    "ProviderDescriptor",
    "active_chat_provider_descriptor",
    "default_chat_provider_name",
    "descriptor_for_provider",
    "normalize_provider_name",
    "selection_options",
]
