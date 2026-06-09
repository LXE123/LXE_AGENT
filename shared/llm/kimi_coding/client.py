from __future__ import annotations

from shared.llm.auth_profiles import api_key_for_provider
from shared.llm.provider_catalog import normalize_model_name, provider_spec_for_name

PROVIDER_NAME = "kimi_coding"


def _spec():
    return provider_spec_for_name(PROVIDER_NAME)


def provider_label() -> str:
    return _spec().label


def api_key() -> str:
    return api_key_for_provider(PROVIDER_NAME)


def base_url() -> str:
    return _spec().base_url


def default_model() -> str:
    return _spec().default_model


def normalize_model(model_name: str) -> str:
    return normalize_model_name(PROVIDER_NAME, model_name)


def user_agent() -> str:
    return str(_spec().default_headers.get("User-Agent") or "").strip()


def anthropic_version() -> str:
    return str(_spec().default_headers.get("anthropic-version") or "").strip()
