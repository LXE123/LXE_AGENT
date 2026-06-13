from __future__ import annotations

from shared.llm.auth_profiles import api_key_for_provider, load_auth_profiles
from shared.llm.provider_catalog import (
    descriptor_for_provider,
    load_provider_specs,
    normalize_provider_name,
    resolve_provider_model,
)


def test_provider_catalog_loads_all_provider_json() -> None:
    specs = load_provider_specs()

    assert {"deepseek", "kimi_coding", "glm"}.issubset(specs)
    assert "kimi" not in specs
    for spec in specs.values():
        assert spec.default_model in spec.models
        for model_spec in spec.models.values():
            assert model_spec.context_window_tokens > 0
            assert model_spec.max_tokens > 0
            assert model_spec.thinking_request_style in {
                "none",
                "provider-managed",
                "anthropic-adaptive",
                "anthropic-budget",
            }
            if model_spec.thinking_levels:
                assert model_spec.thinking_default in model_spec.thinking_levels
                assert set(model_spec.thinking_level_labels).issubset(model_spec.thinking_levels)


def test_provider_aliases_are_normalized_from_catalog() -> None:
    assert normalize_provider_name("deep-seek") == "deepseek"
    assert normalize_provider_name("kimi-code") == "kimi_coding"
    assert normalize_provider_name("big-model") == "glm"


def test_model_alias_and_unknown_model_capability_fallback() -> None:
    exact_spec, exact_match, exact_model = resolve_provider_model("kimi_coding", "kimi-code")
    fallback_spec, fallback_match, fallback_model = resolve_provider_model("kimi_coding", "custom-model")

    assert exact_match == "exact"
    assert exact_model == "kimi-for-coding"
    assert exact_spec.model == "kimi-for-coding"
    assert fallback_match == "provider"
    assert fallback_model == "custom-model"
    assert fallback_spec.model == "kimi-for-coding"


def test_thinking_request_style_is_loaded_from_model_spec() -> None:
    kimi_descriptor = descriptor_for_provider("kimi_coding")
    deepseek_descriptor = descriptor_for_provider("deepseek")

    assert kimi_descriptor.thinking_request_style == "anthropic-budget"
    assert list(kimi_descriptor.thinking_levels) == ["off", "low"]
    assert kimi_descriptor.thinking_level_labels["low"] == "on"
    assert kimi_descriptor.thinking_default == "off"
    assert deepseek_descriptor.thinking_request_style == "none"
    assert deepseek_descriptor.thinking_levels == ()


def test_auth_profile_reads_api_key_from_env_aliases(monkeypatch) -> None:
    monkeypatch.delenv("GLM_API_KEY", raising=False)
    monkeypatch.delenv("ZHIPU_API_KEY", raising=False)
    monkeypatch.delenv("ZHIPUAI_API_KEY", raising=False)
    monkeypatch.setenv("ZHIPU_API_KEY", "zhipu-key")

    profiles = load_auth_profiles()

    assert {"deepseek", "kimi_coding", "glm"}.issubset(profiles)
    assert "kimi" not in profiles
    assert profiles["glm"].env_names == ("GLM_API_KEY", "ZHIPU_API_KEY", "ZHIPUAI_API_KEY")
    assert api_key_for_provider("glm") == "zhipu-key"


def test_auth_profile_does_not_read_python_config_fallback(monkeypatch) -> None:
    monkeypatch.delenv("DEEPSEEK_API", raising=False)

    descriptor = descriptor_for_provider("deepseek")

    assert descriptor.api_key == ""
