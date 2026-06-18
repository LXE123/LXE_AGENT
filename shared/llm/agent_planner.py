from __future__ import annotations

import os
import sys

from shared.logging import logger
from shared.llm.glm import client as glm_client
from shared.llm.kimi_coding import client as kimi_coding_client
from shared.llm.model_capabilities import ModelCapabilities, _resolve_model_capabilities_match
from shared.llm.provider_catalog import ProviderDescriptor, descriptor_for_provider, normalize_provider_name
from shared.llm import runtime_config as runtime_settings

_ACTIVE_PROVIDER_ENV = "AGENT_LLM_PROVIDER"
_ACTIVE_MODEL_ENV = "AGENT_LLM_MODEL"
_MAX_TOKENS_CONFIG = "AGENT_LLM_MAX_TOKENS"
_THINKING_ENABLED_ENV = "AGENT_LLM_THINKING_ENABLED"
_THINKING_EFFORT_ENV = "AGENT_LLM_THINKING_EFFORT"
_DEEPSEEK_PROVIDER_NAME = "deepseek"


def _config_text(name: str, default: str = "") -> str:
    return str(getattr(runtime_settings, name, default) or default).strip()


def _config_int(name: str, default: int) -> int:
    try:
        return int(getattr(runtime_settings, name, default) or default)
    except Exception:
        return int(default)


def _set_active_agent_planner(provider_name: str, model_name: str) -> None:
    normalized_name = normalize_provider_name(provider_name)
    chosen_model = str(model_name or "").strip()
    os.environ[_ACTIVE_PROVIDER_ENV] = normalized_name
    os.environ[_ACTIVE_MODEL_ENV] = chosen_model
    setattr(runtime_settings, _ACTIVE_PROVIDER_ENV, normalized_name)
    setattr(runtime_settings, _ACTIVE_MODEL_ENV, chosen_model)


def _current_agent_thinking_enabled() -> bool:
    return bool(getattr(runtime_settings, _THINKING_ENABLED_ENV, True))


def _set_agent_thinking_enabled(enabled: bool) -> None:
    normalized = bool(enabled)
    os.environ[_THINKING_ENABLED_ENV] = "1" if normalized else "0"
    setattr(runtime_settings, _THINKING_ENABLED_ENV, normalized)


def _prompt_bool(prompt: str, *, default: bool) -> bool:
    raw_value = input(prompt).strip().lower()
    if not raw_value:
        return bool(default)
    if raw_value in {"1", "y", "yes", "on", "true"}:
        return True
    if raw_value in {"0", "n", "no", "off", "false"}:
        return False
    return bool(default)


def _current_provider_name() -> str:
    return normalize_provider_name(
        os.getenv(_ACTIVE_PROVIDER_ENV, "")
        or _config_text(_ACTIVE_PROVIDER_ENV, kimi_coding_client.PROVIDER_NAME)
    )


def _current_model_name() -> str:
    return str(os.getenv(_ACTIVE_MODEL_ENV, "") or _config_text(_ACTIVE_MODEL_ENV, "")).strip()


def agent_planner_selection_options() -> list[ProviderDescriptor]:
    return [
        descriptor_for_provider(kimi_coding_client.PROVIDER_NAME),
        descriptor_for_provider(_DEEPSEEK_PROVIDER_NAME),
        descriptor_for_provider(glm_client.PROVIDER_NAME),
    ]


def active_agent_planner_descriptor() -> ProviderDescriptor:
    descriptor = descriptor_for_provider(
        _current_provider_name(),
        model_override=_current_model_name(),
    )
    if not descriptor.api_key:
        raise RuntimeError(f"Missing API key for agent LLM provider: {descriptor.name}")
    return descriptor


def _active_capabilities_with_match() -> tuple[ModelCapabilities, str]:
    return _resolve_model_capabilities_match(_current_provider_name(), _current_model_name())


def active_agent_planner_capabilities() -> ModelCapabilities:
    capabilities, _ = _active_capabilities_with_match()
    return capabilities


def effective_agent_planner_max_tokens(requested: int | None = None) -> int:
    capabilities = active_agent_planner_capabilities()
    configured_limit = _config_int(_MAX_TOKENS_CONFIG, 0)
    effective_upper_bound = int(capabilities.max_tokens)
    if configured_limit > 0:
        effective_upper_bound = min(effective_upper_bound, int(configured_limit))
    if requested is None:
        return max(1, int(effective_upper_bound))
    return max(1, min(int(requested), int(effective_upper_bound)))


def _thinking_mode_label(descriptor: ProviderDescriptor) -> str:
    style = str(getattr(descriptor, "thinking_request_style", "none") or "none").strip()
    if style == "provider-managed":
        return "provider-managed"
    if style in {"anthropic-adaptive", "anthropic-budget", "anthropic-effort"}:
        if _current_agent_thinking_enabled():
            level = _thinking_level_for_descriptor(descriptor)
            if level == "off":
                return f"disabled:{style}:off"
            label = _thinking_level_display(descriptor, level)
            suffix = level if label == level else f"{level}({label})"
            return f"enabled:{style}:{suffix}"
        if descriptor.thinking_levels:
            return f"disabled:{style}:{descriptor.thinking_default or 'off'}"
        return f"disabled:{style}"
    return "none"


def _thinking_level_for_descriptor(descriptor: ProviderDescriptor) -> str:
    default_level = str(descriptor.thinking_default or "low").strip().lower()
    configured_level = _config_text(_THINKING_EFFORT_ENV, default_level) or default_level
    configured_level = configured_level.lower()
    levels = tuple(str(level or "").strip().lower() for level in descriptor.thinking_levels)
    if levels and configured_level not in levels:
        return next((level for level in levels if level != "off"), default_level)
    return configured_level


def _thinking_level_display(descriptor: ProviderDescriptor, level: str) -> str:
    labels = dict(getattr(descriptor, "thinking_level_labels", {}) or {})
    return str(labels.get(level) or level).strip() or level


def log_active_agent_planner_summary() -> None:
    descriptor = active_agent_planner_descriptor()
    capabilities, match_kind = _active_capabilities_with_match()
    thinking_mode = _thinking_mode_label(descriptor)
    logger.info(
        "[AgentLLM] active provider=%s model=%s context_window=%s max_tokens=%s vision=%s thinking=%s thinking_mode=%s",
        descriptor.name,
        descriptor.default_model,
        capabilities.context_window_tokens,
        capabilities.max_tokens,
        capabilities.supports_vision,
        capabilities.supports_thinking,
        thinking_mode,
    )
    if match_kind != "exact":
        logger.warning(
            "[AgentLLM] capability fallback applied: provider=%s model=%s match=%s",
            descriptor.name,
            descriptor.default_model,
            match_kind,
        )


def bootstrap_agent_planner_selection() -> None:
    if not sys.stdin or not sys.stdin.isatty():
        return

    options = agent_planner_selection_options()
    current_provider = _current_provider_name()
    current_model = _current_model_name()
    default_option = next((item for item in options if item.name == current_provider), options[0])
    fallback_option = next((item for item in options if item.api_key), None)

    print("\n=== Agent LLM Selection ===")
    for index, option in enumerate(options, start=1):
        status = "ready" if option.api_key else "missing api key"
        print(f"{index}. {option.label} ({option.default_model}) [{status}]")

    default_index = next(
        (index for index, option in enumerate(options, start=1) if option.name == default_option.name),
        1,
    )
    raw_choice = input(f"Select Agent LLM [default {default_index}]: ").strip()
    selected_index = default_index
    if raw_choice:
        try:
            selected_index = int(raw_choice)
        except Exception:
            selected_index = default_index
    if selected_index < 1 or selected_index > len(options):
        selected_index = default_index

    selected_option = options[selected_index - 1]
    if not selected_option.api_key and fallback_option is not None:
        print(
            f"{selected_option.label} API key is not configured. "
            f"Falling back to {fallback_option.label} ({fallback_option.default_model})."
        )
        selected_option = fallback_option

    default_model = current_model if selected_option.name == current_provider and current_model else selected_option.default_model
    custom_model = input(f"Model name [{default_model}]: ").strip()
    chosen_model = custom_model or default_model
    _set_active_agent_planner(selected_option.name, chosen_model)
    if selected_option.thinking_request_style in {"anthropic-adaptive", "anthropic-budget"}:
        default_thinking = _current_agent_thinking_enabled()
        thinking_hint = "Y/n" if default_thinking else "y/N"
        thinking_enabled = _prompt_bool(f"Enable thinking request? [{thinking_hint}]: ", default=default_thinking)
        _set_agent_thinking_enabled(thinking_enabled)
        level = _thinking_level_for_descriptor(selected_option) if thinking_enabled else "off"
        thinking_label = "enabled" if thinking_enabled and level != "off" else "disabled"
        display_level = _thinking_level_display(selected_option, level)
        effort = level if display_level == level else f"{level}({display_level})"
        print(
            f"Using agent LLM: {selected_option.label} / {chosen_model} / "
            f"thinking={thinking_label} / effort={effort}\n"
        )
        return
    print(f"Using agent LLM: {selected_option.label} / {chosen_model}\n")


__all__ = [
    "active_agent_planner_capabilities",
    "active_agent_planner_descriptor",
    "agent_planner_selection_options",
    "bootstrap_agent_planner_selection",
    "effective_agent_planner_max_tokens",
    "log_active_agent_planner_summary",
]
