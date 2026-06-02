from __future__ import annotations

from dataclasses import dataclass

from shared.llm.provider_catalog import normalize_provider_name


@dataclass(frozen=True, slots=True)
class ModelCapabilities:
    provider: str
    model: str
    context_window_tokens: int
    max_output_tokens: int
    supports_vision: bool
    supports_thinking: bool
    supports_temperature: bool


_DEFAULT_TEMPLATE = {
    "context_window_tokens": 256000,
    "max_output_tokens": 32768,
    "supports_vision": False,
    "supports_thinking": False,
    "supports_temperature": True,
}

_PROVIDER_DEFAULTS = {
    "glm": {
        "context_window_tokens": 200000,
        "max_output_tokens": 40000,
        "supports_vision": True,
        "supports_thinking": True,
        "supports_temperature": True,
    },
    "kimi_coding": {
        "context_window_tokens": 256000,
        "max_output_tokens": 32768,
        "supports_vision": True,
        "supports_thinking": True,
        "supports_temperature": False,
    },
    "deepseek": {
        "context_window_tokens": 128000,
        "max_output_tokens": 32768,
        "supports_vision": False,
        "supports_thinking": False,
        "supports_temperature": True,
    },
    "kimi": {
        "context_window_tokens": 128000,
        "max_output_tokens": 32768,
        "supports_vision": False,
        "supports_thinking": False,
        "supports_temperature": True,
    },
}

_MODEL_OVERRIDES = {
    ("glm", "glm-5v-turbo"): {
        "context_window_tokens": 200000,
        "max_output_tokens": 42000,
        "supports_vision": True,
        "supports_thinking": True,
        "supports_temperature": True,
    },
    ("kimi_coding", "kimi-for-coding"): {
        "context_window_tokens": 256000,
        "max_output_tokens": 32768,
        "supports_vision": True,
        "supports_thinking": True,
        "supports_temperature": False,
    },
    ("deepseek", "deepseek-chat"): {
        "context_window_tokens": 128000,
        "max_output_tokens": 32768,
        "supports_vision": False,
        "supports_thinking": False,
        "supports_temperature": True,
    },
    ("kimi", "kimi-k2-turbo-preview"): {
        "context_window_tokens": 128000,
        "max_output_tokens": 32768,
        "supports_vision": False,
        "supports_thinking": False,
        "supports_temperature": True,
    },
}


def _safe_provider_name(provider_name: str) -> str:
    raw = str(provider_name or "").strip()
    if not raw:
        return ""
    try:
        return normalize_provider_name(raw)
    except Exception:
        safe = raw.lower().replace("-", "_")
        return " ".join(safe.split()).replace(" ", "_")


def _safe_model_name(model_name: str) -> str:
    return str(model_name or "").strip().lower()


def _resolve_model_capabilities_match(provider_name: str, model_name: str) -> tuple[ModelCapabilities, str]:
    safe_provider = _safe_provider_name(provider_name)
    requested_model = str(model_name or "").strip()
    safe_model = _safe_model_name(model_name)

    template = _MODEL_OVERRIDES.get((safe_provider, safe_model))
    if template is not None:
        return (
            ModelCapabilities(
                provider=safe_provider,
                model=requested_model or safe_model,
                context_window_tokens=int(template["context_window_tokens"]),
                max_output_tokens=int(template["max_output_tokens"]),
                supports_vision=bool(template["supports_vision"]),
                supports_thinking=bool(template["supports_thinking"]),
                supports_temperature=bool(template["supports_temperature"]),
            ),
            "exact",
        )

    template = _PROVIDER_DEFAULTS.get(safe_provider)
    if template is not None:
        return (
            ModelCapabilities(
                provider=safe_provider,
                model=requested_model or "",
                context_window_tokens=int(template["context_window_tokens"]),
                max_output_tokens=int(template["max_output_tokens"]),
                supports_vision=bool(template["supports_vision"]),
                supports_thinking=bool(template["supports_thinking"]),
                supports_temperature=bool(template["supports_temperature"]),
            ),
            "provider",
        )

    template = dict(_DEFAULT_TEMPLATE)
    return (
        ModelCapabilities(
            provider=safe_provider or "default",
            model=requested_model or "",
            context_window_tokens=int(template["context_window_tokens"]),
            max_output_tokens=int(template["max_output_tokens"]),
            supports_vision=bool(template["supports_vision"]),
            supports_thinking=bool(template["supports_thinking"]),
            supports_temperature=bool(template["supports_temperature"]),
        ),
        "default",
    )


def resolve_model_capabilities(provider_name: str, model_name: str) -> ModelCapabilities:
    capabilities, _ = _resolve_model_capabilities_match(provider_name, model_name)
    return capabilities


__all__ = [
    "ModelCapabilities",
    "resolve_model_capabilities",
]
