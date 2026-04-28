from __future__ import annotations

import os
import sys
from dataclasses import dataclass

from shared.config import config
from shared.llm.provider_catalog import (
    active_chat_provider_descriptor,
    default_chat_provider_name,
    normalize_provider_name,
    selection_options,
)
from shared.llm.transports.openai_chat import chat_json_object as transport_chat_json_object
from shared.llm.transports.openai_chat import chat_text as transport_chat_text

_ACTIVE_PROVIDER_ENV = "LLM_ACTIVE_PROVIDER"
_ACTIVE_MODEL_ENV = "LLM_ACTIVE_MODEL"


@dataclass(frozen=True, slots=True)
class LLMSettings:
    provider: str
    model: str
    api_key: str
    base_url: str
    timeout_s: int


def _config_text(name: str, default: str = "") -> str:
    return str(getattr(config, name, default) or default).strip()


def _config_int(name: str, default: int) -> int:
    try:
        return int(getattr(config, name, default) or default)
    except Exception:
        return int(default)


def resolve_active_settings() -> LLMSettings:
    descriptor = active_chat_provider_descriptor()
    return LLMSettings(
        provider=descriptor.name,
        model=descriptor.default_model,
        api_key=descriptor.api_key,
        base_url=descriptor.base_url,
        timeout_s=max(10, _config_int("LLM_REQUEST_TIMEOUT_S", 120)),
    )


def current_llm_summary() -> str:
    settings = resolve_active_settings()
    descriptor = active_chat_provider_descriptor()
    return f"{descriptor.label} / {settings.model}"


def _set_active_llm(provider_name: str, model_name: str) -> None:
    os.environ[_ACTIVE_PROVIDER_ENV] = normalize_provider_name(provider_name)
    os.environ[_ACTIVE_MODEL_ENV] = str(model_name or "").strip()


def _first_available_option():
    for option in selection_options():
        if option.api_key:
            return option
    return None


def bootstrap_global_llm_selection() -> None:
    if os.getenv(_ACTIVE_PROVIDER_ENV):
        if not os.getenv(_ACTIVE_MODEL_ENV):
            descriptor = active_chat_provider_descriptor()
            os.environ[_ACTIVE_MODEL_ENV] = descriptor.default_model
        return

    default_provider_name = default_chat_provider_name()
    options = selection_options()
    default_option = next((item for item in options if item.name == default_provider_name), None)
    fallback_option = _first_available_option()

    if default_option is None and fallback_option is not None:
        default_option = fallback_option
    if default_option is not None and not default_option.api_key and fallback_option is not None:
        default_option = fallback_option
    if default_option is None:
        raise RuntimeError("No configured chat LLM provider is available.")

    if not sys.stdin or not sys.stdin.isatty():
        _set_active_llm(default_option.name, default_option.default_model)
        return

    print("\n=== Global LLM Selection ===")
    for index, option in enumerate(options, start=1):
        status = "ready" if option.api_key else "missing api key"
        print(f"{index}. {option.label} ({option.default_model}) [{status}]")

    selected_index = next((index for index, option in enumerate(options, start=1) if option.name == default_option.name), 1)
    raw_choice = input(f"Select model [default {selected_index}]: ").strip()
    if raw_choice:
        try:
            selected_index = int(raw_choice)
        except Exception:
            selected_index = 1
    if selected_index < 1 or selected_index > len(options):
        selected_index = 1

    selected_option = options[selected_index - 1]
    if not selected_option.api_key:
        print(f"{selected_option.label} API key is not configured. Falling back to {default_option.label} ({default_option.default_model}).")
        selected_option = default_option

    custom_model = input(f"Model name [{selected_option.default_model}]: ").strip()
    chosen_model = custom_model or selected_option.default_model
    _set_active_llm(selected_option.name, chosen_model)
    print(f"Using global LLM: {selected_option.label} / {chosen_model}\n")


async def chat_text(
    system_prompt: str,
    user_text: str,
    *,
    temperature: float = 0.1,
) -> str:
    descriptor = active_chat_provider_descriptor()
    return await transport_chat_text(
        descriptor=descriptor,
        system_prompt=system_prompt,
        user_text=user_text,
        temperature=temperature,
        timeout_s=max(10, _config_int("LLM_REQUEST_TIMEOUT_S", 120)),
    )


async def chat_json_object(
    system_prompt: str,
    user_text: str,
    *,
    temperature: float = 0.1,
) -> dict | None:
    descriptor = active_chat_provider_descriptor()
    return await transport_chat_json_object(
        descriptor=descriptor,
        system_prompt=system_prompt,
        user_text=user_text,
        temperature=temperature,
        timeout_s=max(10, _config_int("LLM_REQUEST_TIMEOUT_S", 120)),
    )


__all__ = [
    "LLMSettings",
    "bootstrap_global_llm_selection",
    "chat_json_object",
    "chat_text",
    "current_llm_summary",
    "normalize_provider_name",
    "resolve_active_settings",
]
