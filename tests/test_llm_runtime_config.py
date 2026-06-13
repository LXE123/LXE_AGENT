from __future__ import annotations

import importlib

import pytest

import shared.env as project_env
import shared.env_config as env_config
from shared.llm import runtime_config as runtime_settings


@pytest.fixture(autouse=True)
def _restore_runtime_config_after_test():
    original_env_loaded = project_env._ENV_LOADED
    yield
    project_env._ENV_LOADED = original_env_loaded
    importlib.reload(env_config)
    importlib.reload(runtime_settings)


def _reload_runtime_config_without_project_env(monkeypatch):
    monkeypatch.setattr(project_env, "_ENV_LOADED", True)
    importlib.reload(env_config)
    return importlib.reload(runtime_settings)


def test_thinking_defaults_enabled_when_env_missing(monkeypatch) -> None:
    monkeypatch.delenv("AGENT_LLM_THINKING_ENABLED", raising=False)
    monkeypatch.delenv("AGENT_LLM_THINKING_EFFORT", raising=False)

    settings = _reload_runtime_config_without_project_env(monkeypatch)

    assert settings.AGENT_LLM_THINKING_ENABLED is True
    assert settings.AGENT_LLM_THINKING_EFFORT == "low"


def test_thinking_env_can_disable_default(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_LLM_THINKING_ENABLED", "0")

    settings = _reload_runtime_config_without_project_env(monkeypatch)

    assert settings.AGENT_LLM_THINKING_ENABLED is False
