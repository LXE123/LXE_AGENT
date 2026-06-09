from __future__ import annotations

import importlib


def _reload_config(monkeypatch):
    monkeypatch.delenv("LOGISTICS_USE_REMOTE_API", raising=False)
    monkeypatch.delenv("LOGISTICS_REMOTE_API_BASE_URL", raising=False)
    monkeypatch.delenv("LOGISTICS_LOCAL_API_BASE_URL", raising=False)
    import shared.env as env_module

    monkeypatch.setattr(env_module, "_ENV_LOADED", True)

    from services.amazon.amazon_logistic import config as settings_module

    return importlib.reload(settings_module)


def test_logistics_api_defaults_to_remote_mode_without_hardcoded_url(monkeypatch):
    settings_module = _reload_config(monkeypatch)

    assert settings_module.LOGISTICS_USE_REMOTE_API is True
    assert settings_module.LOGISTICS_REMOTE_API_BASE_URL == ""
    assert settings_module.LOGISTICS_API_BASE_URL == ""


def test_logistics_api_remote_url_comes_from_env(monkeypatch):
    monkeypatch.delenv("LOGISTICS_LOCAL_API_BASE_URL", raising=False)
    monkeypatch.setenv("LOGISTICS_USE_REMOTE_API", "1")
    monkeypatch.setenv("LOGISTICS_REMOTE_API_BASE_URL", "http://192.168.1.142:8000")

    from services.amazon.amazon_logistic import config as settings_module

    reloaded_settings = importlib.reload(settings_module)

    assert reloaded_settings.LOGISTICS_USE_REMOTE_API is True
    assert reloaded_settings.LOGISTICS_API_BASE_URL == "http://192.168.1.142:8000"


def test_logistics_api_switch_can_use_local_url(monkeypatch):
    monkeypatch.delenv("LOGISTICS_REMOTE_API_BASE_URL", raising=False)
    monkeypatch.delenv("LOGISTICS_LOCAL_API_BASE_URL", raising=False)
    monkeypatch.setenv("LOGISTICS_USE_REMOTE_API", "0")

    from services.amazon.amazon_logistic import config as settings_module

    reloaded_settings = importlib.reload(settings_module)

    assert reloaded_settings.LOGISTICS_USE_REMOTE_API is False
    assert reloaded_settings.LOGISTICS_API_BASE_URL == "http://127.0.0.1:8000"
