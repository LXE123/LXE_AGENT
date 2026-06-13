from __future__ import annotations

import json
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from shared.llm.auth_profiles import api_key_for_provider


_PROVIDER_DIR = Path(__file__).resolve().parent / "providers"
_THINKING_REQUEST_STYLES = {
    "none",
    "provider-managed",
    "anthropic-adaptive",
    "anthropic-budget",
}


@dataclass(frozen=True, slots=True)
class ProviderModelSpec:
    provider: str
    model: str
    context_window_tokens: int
    max_tokens: int
    supports_vision: bool
    supports_thinking: bool
    supports_temperature: bool
    thinking_request_style: str = "none"
    thinking_levels: tuple[str, ...] = ()
    thinking_level_labels: dict[str, str] = field(default_factory=dict)
    thinking_default: str = ""


@dataclass(frozen=True, slots=True)
class ProviderSpec:
    name: str
    label: str
    api_style: str
    base_url: str
    default_model: str
    models: dict[str, ProviderModelSpec]
    default_headers: dict[str, str] = field(default_factory=dict)
    aliases: tuple[str, ...] = ()
    model_aliases: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ProviderDescriptor:
    name: str
    label: str
    api_style: str
    api_key: str
    base_url: str
    default_model: str
    max_tokens: int = 0
    thinking_request_style: str = "none"
    thinking_levels: tuple[str, ...] = ()
    thinking_level_labels: dict[str, str] = field(default_factory=dict)
    thinking_default: str = ""
    default_headers: dict[str, str] = field(default_factory=dict)


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _provider_key(value: str) -> str:
    safe = _clean_text(value).lower().replace("-", "_")
    return " ".join(safe.split()).replace(" ", "_")


def _model_key(value: str) -> str:
    return _clean_text(value).lower()


def _load_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"Invalid LLM provider JSON: {path}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"LLM provider JSON must be an object: {path}")
    return payload


def _positive_int(payload: dict[str, Any], field_name: str, *, path: Path, model_name: str) -> int:
    try:
        value = int(payload.get(field_name))
    except Exception as exc:
        raise RuntimeError(f"LLM model field must be an integer: {path} {model_name}.{field_name}") from exc
    if value <= 0:
        raise RuntimeError(f"LLM model field must be positive: {path} {model_name}.{field_name}")
    return value


def _parse_model_spec(
    *,
    provider_name: str,
    model_name: str,
    payload: Any,
    path: Path,
) -> ProviderModelSpec:
    if not isinstance(payload, dict):
        raise RuntimeError(f"LLM model spec must be an object: {path} {model_name}")
    safe_model = _clean_text(model_name)
    if not safe_model:
        raise RuntimeError(f"LLM model name cannot be empty: {path}")
    thinking_request_style = _clean_text(payload.get("thinking_request_style")) or "none"
    if thinking_request_style not in _THINKING_REQUEST_STYLES:
        raise RuntimeError(
            f"Unsupported LLM model thinking_request_style: {path} {safe_model}.{thinking_request_style}"
        )
    thinking_levels = tuple(
        level.lower()
        for level in _string_list(
            payload.get("thinking_levels"),
            field_name=f"{safe_model}.thinking_levels",
            path=path,
        )
    )
    if len(set(thinking_levels)) != len(thinking_levels):
        raise RuntimeError(f"LLM model thinking_levels contains duplicates: {path} {safe_model}")
    thinking_level_labels = {
        key.lower(): label
        for key, label in _string_dict(
            payload.get("thinking_level_labels"),
            field_name=f"{safe_model}.thinking_level_labels",
            path=path,
        ).items()
    }
    thinking_default = _clean_text(payload.get("thinking_default")).lower()
    if thinking_levels:
        if not thinking_default:
            thinking_default = thinking_levels[0]
        if thinking_default not in thinking_levels:
            raise RuntimeError(
                f"LLM model thinking_default must be listed in thinking_levels: {path} {safe_model}"
            )
        unknown_labels = sorted(set(thinking_level_labels) - set(thinking_levels))
        if unknown_labels:
            raise RuntimeError(
                f"LLM model thinking_level_labels keys must be listed in thinking_levels: "
                f"{path} {safe_model} {unknown_labels}"
            )
    else:
        thinking_level_labels = {}
        thinking_default = ""
    return ProviderModelSpec(
        provider=provider_name,
        model=safe_model,
        context_window_tokens=_positive_int(
            payload,
            "context_window_tokens",
            path=path,
            model_name=safe_model,
        ),
        max_tokens=_positive_int(payload, "max_tokens", path=path, model_name=safe_model),
        supports_vision=bool(payload.get("supports_vision", False)),
        supports_thinking=bool(payload.get("supports_thinking", False)),
        supports_temperature=bool(payload.get("supports_temperature", True)),
        thinking_request_style=thinking_request_style,
        thinking_levels=thinking_levels,
        thinking_level_labels=thinking_level_labels,
        thinking_default=thinking_default,
    )


def _string_dict(value: Any, *, field_name: str, path: Path) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise RuntimeError(f"LLM provider field must be an object: {path} {field_name}")
    result: dict[str, str] = {}
    for key, item in value.items():
        safe_key = _clean_text(key)
        safe_value = _clean_text(item)
        if safe_key and safe_value:
            result[safe_key] = safe_value
    return result


def _string_list(value: Any, *, field_name: str, path: Path) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, list):
        raise RuntimeError(f"LLM provider field must be a list: {path} {field_name}")
    return tuple(_clean_text(item) for item in value if _clean_text(item))


def _parse_provider_spec(path: Path) -> ProviderSpec:
    payload = _load_json(path)
    name = _provider_key(_clean_text(payload.get("name")))
    label = _clean_text(payload.get("label"))
    api_style = _clean_text(payload.get("api_style"))
    base_url = _clean_text(payload.get("base_url"))
    default_model = _clean_text(payload.get("default_model"))
    models_raw = payload.get("models")
    if not name:
        raise RuntimeError(f"LLM provider missing name: {path}")
    if not label:
        raise RuntimeError(f"LLM provider missing label: {path}")
    if api_style not in {"openai-chat", "anthropic-messages"}:
        raise RuntimeError(f"Unsupported LLM provider api_style: {path} {api_style}")
    if not base_url:
        raise RuntimeError(f"LLM provider missing base_url: {path}")
    if not default_model:
        raise RuntimeError(f"LLM provider missing default_model: {path}")
    if not isinstance(models_raw, dict) or not models_raw:
        raise RuntimeError(f"LLM provider must define models: {path}")

    models = {
        _clean_text(model_name): _parse_model_spec(
            provider_name=name,
            model_name=_clean_text(model_name),
            payload=model_payload,
            path=path,
        )
        for model_name, model_payload in models_raw.items()
    }
    if default_model not in models:
        raise RuntimeError(f"LLM provider default_model must exist in models: {path} {default_model}")

    raw_model_aliases = _string_dict(payload.get("model_aliases"), field_name="model_aliases", path=path)
    model_aliases: dict[str, str] = {}
    for alias, target in raw_model_aliases.items():
        if target not in models:
            raise RuntimeError(f"LLM model alias target missing from models: {path} {alias}->{target}")
        model_aliases[_model_key(alias)] = target

    return ProviderSpec(
        name=name,
        label=label,
        api_style=api_style,
        base_url=base_url,
        default_model=default_model,
        default_headers=_string_dict(payload.get("default_headers"), field_name="default_headers", path=path),
        aliases=_string_list(payload.get("aliases"), field_name="aliases", path=path),
        model_aliases=model_aliases,
        models=models,
    )


@lru_cache(maxsize=1)
def load_provider_specs() -> dict[str, ProviderSpec]:
    specs: dict[str, ProviderSpec] = {}
    for path in sorted(_PROVIDER_DIR.glob("*.json")):
        spec = _parse_provider_spec(path)
        if spec.name in specs:
            raise RuntimeError(f"Duplicate LLM provider name: {spec.name}")
        specs[spec.name] = spec
    if not specs:
        raise RuntimeError(f"No LLM provider specs found: {_PROVIDER_DIR}")
    return specs


@lru_cache(maxsize=1)
def _provider_aliases() -> dict[str, str]:
    aliases: dict[str, str] = {}
    for spec in load_provider_specs().values():
        for alias in (spec.name, *spec.aliases):
            key = _provider_key(alias)
            existing = aliases.get(key)
            if existing is not None and existing != spec.name:
                raise RuntimeError(f"Duplicate LLM provider alias: {alias}")
            aliases[key] = spec.name
    return aliases


def normalize_provider_name(raw_name: str) -> str:
    key = _provider_key(raw_name)
    provider_name = _provider_aliases().get(key, key)
    if provider_name not in load_provider_specs():
        raise ValueError(f"Unsupported LLM provider: {raw_name}")
    return provider_name


def provider_spec_for_name(provider_name: str) -> ProviderSpec:
    normalized_name = normalize_provider_name(provider_name)
    return load_provider_specs()[normalized_name]


def normalize_model_name(provider_name: str, model_name: str) -> str:
    spec = provider_spec_for_name(provider_name)
    requested_model = _clean_text(model_name) or spec.default_model
    return spec.model_aliases.get(_model_key(requested_model), requested_model)


def resolve_provider_model(
    provider_name: str,
    model_name: str,
) -> tuple[ProviderModelSpec, str, str]:
    spec = provider_spec_for_name(provider_name)
    requested_model = _clean_text(model_name) or spec.default_model
    normalized_model = normalize_model_name(spec.name, requested_model)
    model_spec = spec.models.get(normalized_model)
    if model_spec is not None:
        return model_spec, "exact", normalized_model
    return spec.models[spec.default_model], "provider", requested_model


def descriptor_for_provider(provider_name: str, *, model_override: str = "") -> ProviderDescriptor:
    spec = provider_spec_for_name(provider_name)
    model_spec, _, descriptor_model = resolve_provider_model(spec.name, model_override or spec.default_model)
    return ProviderDescriptor(
        name=spec.name,
        label=spec.label,
        api_style=spec.api_style,
        api_key=api_key_for_provider(spec.name),
        base_url=spec.base_url,
        default_model=descriptor_model,
        max_tokens=int(model_spec.max_tokens),
        thinking_request_style=model_spec.thinking_request_style,
        thinking_levels=tuple(model_spec.thinking_levels),
        thinking_level_labels=dict(model_spec.thinking_level_labels),
        thinking_default=model_spec.thinking_default,
        default_headers=dict(spec.default_headers),
    )


__all__ = [
    "ProviderDescriptor",
    "ProviderModelSpec",
    "ProviderSpec",
    "descriptor_for_provider",
    "load_provider_specs",
    "normalize_model_name",
    "normalize_provider_name",
    "provider_spec_for_name",
    "resolve_provider_model",
]
