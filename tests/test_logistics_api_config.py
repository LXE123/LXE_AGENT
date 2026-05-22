from __future__ import annotations

import importlib


def _reload_config(monkeypatch):
    monkeypatch.delenv("LOGISTICS_API_BASE_URL", raising=False)
    monkeypatch.delenv("LOGISTICS_USE_REMOTE_API", raising=False)
    monkeypatch.delenv("LOGISTICS_REMOTE_API_BASE_URL", raising=False)
    monkeypatch.delenv("LOGISTICS_LOCAL_API_BASE_URL", raising=False)

    import shared.config as config_module

    return importlib.reload(config_module)


def test_logistics_api_defaults_to_remote_url(monkeypatch):
    config_module = _reload_config(monkeypatch)

    assert config_module.LOGISTICS_USE_REMOTE_API is True
    assert config_module.LOGISTICS_API_BASE_URL == "http://192.168.1.142:8000"


def test_logistics_api_switch_can_use_local_url(monkeypatch):
    monkeypatch.delenv("LOGISTICS_API_BASE_URL", raising=False)
    monkeypatch.delenv("LOGISTICS_REMOTE_API_BASE_URL", raising=False)
    monkeypatch.delenv("LOGISTICS_LOCAL_API_BASE_URL", raising=False)
    monkeypatch.setenv("LOGISTICS_USE_REMOTE_API", "0")

    import shared.config as config_module

    reloaded_config = importlib.reload(config_module)

    assert reloaded_config.LOGISTICS_USE_REMOTE_API is False
    assert reloaded_config.LOGISTICS_API_BASE_URL == "http://127.0.0.1:8000"


def test_logistics_api_explicit_base_url_takes_priority(monkeypatch):
    monkeypatch.delenv("LOGISTICS_REMOTE_API_BASE_URL", raising=False)
    monkeypatch.delenv("LOGISTICS_LOCAL_API_BASE_URL", raising=False)
    monkeypatch.setenv("LOGISTICS_API_BASE_URL", "http://10.0.0.8:9000")
    monkeypatch.setenv("LOGISTICS_USE_REMOTE_API", "0")

    import shared.config as config_module

    reloaded_config = importlib.reload(config_module)

    assert reloaded_config.LOGISTICS_API_BASE_URL == "http://10.0.0.8:9000"
