from __future__ import annotations

import logging

from agent_runtime.tool_registry import UnifiedToolRegistry, ensure_all_tools_registered
from services.browser.store import ziniao_config


def _force_ziniao_unconfigured(monkeypatch, reason: str = "not configured") -> None:
    monkeypatch.setattr(ziniao_config, "ziniao_tool_config_status", lambda: (False, reason))


def test_builtin_tool_registration_is_quiet_at_info(caplog, monkeypatch) -> None:
    _force_ziniao_unconfigured(monkeypatch)
    caplog.set_level(logging.INFO)

    ensure_all_tools_registered(UnifiedToolRegistry())

    messages = [record.getMessage() for record in caplog.records]
    assert not any("[CodingTools] registered" in message for message in messages)
    assert not any("[FeishuIMTools] registered" in message for message in messages)
    assert not any("skip Ziniao browser tools" in message for message in messages)


def test_builtin_tool_registration_debug_logs_actual_additions(caplog, monkeypatch) -> None:
    _force_ziniao_unconfigured(monkeypatch)
    caplog.set_level(logging.DEBUG)

    ensure_all_tools_registered(UnifiedToolRegistry())

    messages = [record.getMessage() for record in caplog.records]
    assert any("[CodingTools] registered 9 tools" in message for message in messages)
    assert any("[FeishuIMTools] registered 4 tools" in message for message in messages)


def test_repeated_registration_keeps_registry_stable_and_does_not_log_new_additions(caplog, monkeypatch) -> None:
    _force_ziniao_unconfigured(monkeypatch)
    registry = UnifiedToolRegistry()
    caplog.set_level(logging.DEBUG)

    ensure_all_tools_registered(registry)
    first_names = registry.all_names()
    caplog.clear()

    ensure_all_tools_registered(registry)

    assert registry.all_names() == first_names
    messages = [record.getMessage() for record in caplog.records]
    assert not any("[CodingTools] registered" in message for message in messages)
    assert not any("[FeishuIMTools] registered" in message for message in messages)


def test_ziniao_skip_is_debug_only(caplog, monkeypatch) -> None:
    _force_ziniao_unconfigured(monkeypatch, reason="unsupported platform for test")

    caplog.set_level(logging.INFO)
    ensure_all_tools_registered(UnifiedToolRegistry())
    assert "skip Ziniao browser tools" not in caplog.text

    caplog.clear()
    caplog.set_level(logging.DEBUG)
    ensure_all_tools_registered(UnifiedToolRegistry())
    assert "skip Ziniao browser tools: unsupported platform for test" in caplog.text
