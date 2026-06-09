from __future__ import annotations

from dataclasses import dataclass

from shared.llm.provider_catalog import normalize_provider_name, resolve_provider_model


@dataclass(frozen=True, slots=True)
class ModelCapabilities:
    provider: str
    model: str
    context_window_tokens: int
    max_tokens: int
    supports_vision: bool
    supports_thinking: bool
    supports_temperature: bool


_DEFAULT_CAPABILITIES = {
    "context_window_tokens": 256000,
    "max_tokens": 32768,
    "supports_vision": False,
    "supports_thinking": False,
    "supports_temperature": True,
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


def _resolve_model_capabilities_match(provider_name: str, model_name: str) -> tuple[ModelCapabilities, str]:
    safe_provider = _safe_provider_name(provider_name)
    requested_model = str(model_name or "").strip()
    try:
        model_spec, match_kind, resolved_model = resolve_provider_model(safe_provider, requested_model)
    except Exception:
        template = dict(_DEFAULT_CAPABILITIES)
        return (
            ModelCapabilities(
                provider=safe_provider or "default",
                model=requested_model,
                context_window_tokens=int(template["context_window_tokens"]),
                max_tokens=int(template["max_tokens"]),
                supports_vision=bool(template["supports_vision"]),
                supports_thinking=bool(template["supports_thinking"]),
                supports_temperature=bool(template["supports_temperature"]),
            ),
            "default",
        )

    return (
        ModelCapabilities(
            provider=model_spec.provider,
            model=resolved_model,
            context_window_tokens=int(model_spec.context_window_tokens),
            max_tokens=int(model_spec.max_tokens),
            supports_vision=bool(model_spec.supports_vision),
            supports_thinking=bool(model_spec.supports_thinking),
            supports_temperature=bool(model_spec.supports_temperature),
        ),
        match_kind,
    )


def resolve_model_capabilities(provider_name: str, model_name: str) -> ModelCapabilities:
    capabilities, _ = _resolve_model_capabilities_match(provider_name, model_name)
    return capabilities


__all__ = [
    "ModelCapabilities",
    "resolve_model_capabilities",
]
