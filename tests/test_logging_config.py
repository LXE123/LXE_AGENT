from __future__ import annotations

import asyncio
import io
import logging
from pathlib import Path

import pytest

import shared.logging as logging_config
from shared.logging import reset_log_context, set_log_context, setup_logging


_MANAGED_HANDLER_ATTR = "_lxe_agent_logging_handler"
_TRACKED_LOGGERS = (
    "bot_logger",
    "browser_auth_service.service",
    "clients.auth.browser_auth_client",
    "platforms.feishu",
    "services.mabang.auth_audit",
    "services.mabang.amazon.fba.wms",
    "services.mabang.auth",
    "agent_runtime.stream_logging",
    "shared.other",
    "httpx",
    "httpcore",
    "lark_oapi",
    "aiohttp",
)
_PROJECT_ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _restore_logging_state(monkeypatch):
    root = logging.getLogger()
    original_root_level = root.level
    original_states = {
        name: (
            logging.getLogger(name).level,
            logging.getLogger(name).propagate,
            logging.getLogger(name).disabled,
        )
        for name in _TRACKED_LOGGERS
    }
    monkeypatch.delenv("LOG_LEVEL", raising=False)
    monkeypatch.delenv("LOG_LEVELS", raising=False)
    monkeypatch.delenv("LOG_FORMAT", raising=False)
    yield
    for handler in list(root.handlers):
        if getattr(handler, _MANAGED_HANDLER_ATTR, False):
            root.removeHandler(handler)
            handler.close()
    root.setLevel(original_root_level)
    for name, (level, propagate, disabled) in original_states.items():
        tracked_logger = logging.getLogger(name)
        tracked_logger.setLevel(level)
        tracked_logger.propagate = propagate
        tracked_logger.disabled = disabled


def _managed_handlers() -> list[logging.Handler]:
    return [
        handler
        for handler in logging.getLogger().handlers
        if getattr(handler, _MANAGED_HANDLER_ATTR, False)
    ]


def test_setup_logging_is_idempotent_and_preserves_external_handlers(monkeypatch) -> None:
    external_handler = logging.StreamHandler(io.StringIO())
    root = logging.getLogger()
    root.addHandler(external_handler)
    try:
        monkeypatch.setenv("LOG_LEVEL", "INFO")
        monkeypatch.setenv("LOCAL_LOGS_ENABLED", "0")

        setup_logging()
        setup_logging()

        assert external_handler in root.handlers
        assert len(_managed_handlers()) == 1
    finally:
        root.removeHandler(external_handler)
        external_handler.close()


def test_setup_logging_uses_root_log_level_from_env(monkeypatch) -> None:
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")

    setup_logging()

    assert logging.getLogger().level == logging.DEBUG
    assert logging.getLogger("shared.other").isEnabledFor(logging.DEBUG)


def test_setup_logging_applies_scoped_log_levels(monkeypatch) -> None:
    monkeypatch.setenv("LOG_LEVEL", "INFO")
    monkeypatch.setenv("LOG_LEVELS", "platforms.feishu=DEBUG,agent_runtime.stream_logging=WARNING")

    setup_logging()

    assert logging.getLogger("platforms.feishu.gateway").isEnabledFor(logging.DEBUG)
    assert not logging.getLogger("shared.other").isEnabledFor(logging.DEBUG)
    assert not logging.getLogger("agent_runtime.stream_logging").isEnabledFor(logging.INFO)
    assert logging.getLogger("agent_runtime.stream_logging").isEnabledFor(logging.WARNING)


def test_legacy_bot_logger_is_caplog_compatible(caplog) -> None:
    setup_logging()
    caplog.set_level(logging.INFO, logger="bot_logger")

    logger = logging.getLogger("bot_logger")
    logger.info("legacy compatibility message")

    assert "legacy compatibility message" in caplog.text
    assert logger.handlers == []
    assert logger.propagate is True


def test_third_party_loggers_default_to_warning(monkeypatch) -> None:
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")

    setup_logging()

    for name in ("httpx", "httpcore", "lark_oapi", "aiohttp"):
        assert logging.getLogger(name).level == logging.WARNING


def test_scoped_log_levels_can_override_third_party_defaults(monkeypatch) -> None:
    monkeypatch.setenv("LOG_LEVELS", "httpx=INFO")

    setup_logging()

    assert logging.getLogger("httpx").level == logging.INFO


def test_managed_text_formatter_includes_logger_name() -> None:
    setup_logging()
    stream = io.StringIO()
    handler = _managed_handlers()[0]
    old_stream = handler.setStream(stream)
    try:
        logging.getLogger("gateway.emitter").info("plain message")
    finally:
        handler.setStream(old_stream)

    output = stream.getvalue()
    assert "[gateway.emitter]" in output
    assert "plain message" in output
    assert "session=" not in output
    assert "turn=" not in output
    assert "[ctx " not in output


def test_log_format_falls_back_to_text(monkeypatch) -> None:
    monkeypatch.setenv("LOG_FORMAT", "json")

    setup_logging()
    stream = io.StringIO()
    handler = _managed_handlers()[0]
    old_stream = handler.setStream(stream)
    try:
        logging.getLogger("gateway.emitter").info("fallback message")
    finally:
        handler.setStream(old_stream)

    assert "[gateway.emitter]" in stream.getvalue()


def test_log_context_is_added_to_managed_output_only_when_present() -> None:
    setup_logging()
    stream = io.StringIO()
    handler = _managed_handlers()[0]
    old_stream = handler.setStream(stream)
    try:
        token = set_log_context(session_id="session-a-long", turn_id="turn-a-long")
        try:
            logging.getLogger("agent_runtime.loop").info("context message")
        finally:
            reset_log_context(token)

        logging.getLogger("agent_runtime.loop").info("after reset")
    finally:
        handler.setStream(old_stream)

    output = stream.getvalue()
    assert "[agent.loop]" in output
    assert "[ctx s=session- t=turn-a-l]" in output
    assert "context message" in output
    assert "session=-" not in output
    assert "turn=-" not in output
    after_reset_line = next(line for line in output.splitlines() if "after reset" in line)
    assert "[ctx " not in after_reset_line
    assert "after reset" in output


def test_log_context_is_isolated_between_async_tasks() -> None:
    setup_logging()
    stream = io.StringIO()
    handler = _managed_handlers()[0]
    old_stream = handler.setStream(stream)

    async def emit_with_context(session_id: str, turn_id: str, message: str) -> None:
        token = set_log_context(session_id=session_id, turn_id=turn_id)
        try:
            await asyncio.sleep(0)
            logging.getLogger("agent_runtime.loop").info(message)
        finally:
            reset_log_context(token)

    async def run_both() -> None:
        await asyncio.gather(
            emit_with_context("session-a", "turn-a", "message-a"),
            emit_with_context("session-b", "turn-b", "message-b"),
        )

    try:
        asyncio.run(run_both())
    finally:
        handler.setStream(old_stream)

    lines = stream.getvalue().splitlines()
    assert any("[ctx s=session- t=turn-a]" in line and "message-a" in line for line in lines)
    assert any("[ctx s=session- t=turn-b]" in line and "message-b" in line for line in lines)
    assert not any("[ctx s=session- t=turn-a]" in line and "message-b" in line for line in lines)
    assert not any("[ctx s=session- t=turn-b]" in line and "message-a" in line for line in lines)


def test_managed_formatter_uses_short_display_names() -> None:
    setup_logging()
    stream = io.StringIO()
    handler = _managed_handlers()[0]
    old_stream = handler.setStream(stream)
    try:
        logging.getLogger("agent_runtime.stream_logging").info("agent stream")
        logging.getLogger("platforms.feishu.cardkit_sender").info("feishu cardkit")
        logging.getLogger("shared.other").info("shared module")
    finally:
        handler.setStream(old_stream)

    output = stream.getvalue()
    assert "[agent.stream]" in output
    assert "[feishu.cardkit]" in output
    assert "[shared.other]" in output


def test_agent_loop_integrates_log_context_with_finally_reset() -> None:
    text = (_PROJECT_ROOT / "agent_runtime" / "loop.py").read_text(encoding="utf-8")

    assert "set_log_context(" in text
    assert "reset_log_context(" in text
    assert "finally:" in text


def test_runtime_file_logging_requires_global_local_logs_switch(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(logging_config, "_repo_root", lambda: tmp_path)
    monkeypatch.setenv("LOG_FILE", "runtime.log")
    monkeypatch.setenv("LOCAL_LOG_RETENTION_DAYS", "7")
    old_runtime_dir = tmp_path / "logs" / "runtime" / "20000101"
    old_runtime_dir.mkdir(parents=True)
    (old_runtime_dir / "runtime.log").write_text("old", encoding="utf-8")

    monkeypatch.setenv("LOCAL_LOGS_ENABLED", "0")
    setup_logging()

    logging.getLogger("gateway.app").warning("disabled runtime file log")

    assert not old_runtime_dir.exists()
    assert list((tmp_path / "logs" / "runtime").glob("*/runtime.log")) == []

    monkeypatch.setenv("LOCAL_LOGS_ENABLED", "1")
    setup_logging()
    logging.getLogger("gateway.app").warning("enabled runtime file log")
    for handler in logging.getLogger().handlers:
        handler.flush()

    matches = list((tmp_path / "logs" / "runtime").glob("*/runtime.log"))
    assert len(matches) == 1
    assert "enabled runtime file log" in matches[0].read_text(encoding="utf-8")
    assert "disabled runtime file log" not in matches[0].read_text(encoding="utf-8")


def test_browser_auth_file_logging_filters_dedicated_modules(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(logging_config, "_repo_root", lambda: tmp_path)
    monkeypatch.setenv("LOCAL_LOGS_ENABLED", "1")
    monkeypatch.setenv("LOG_FILE", "runtime.log")
    monkeypatch.setenv("BROWSER_AUTH_LOG_FILE", "browser_auth_service.log")

    setup_logging()
    logging.getLogger("browser_auth_service.service").info("browser auth detail")
    logging.getLogger("clients.auth.browser_auth_client").info("client detail")
    logging.getLogger("services.mabang.auth_audit").info("auth audit detail")
    logging.getLogger("services.mabang.amazon.fba.wms").info("wms detail")
    logging.getLogger("gateway.app").info("gateway detail")
    for handler in logging.getLogger().handlers:
        handler.flush()

    matches = list((tmp_path / "logs" / "browser_auth_service").glob("*/browser_auth_service.log"))
    assert len(matches) == 1
    text = matches[0].read_text(encoding="utf-8")
    assert "browser auth detail" in text
    assert "client detail" in text
    assert "auth audit detail" in text
    assert "wms detail" in text
    assert "gateway detail" not in text


def test_browser_auth_file_logging_requires_explicit_file_env(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(logging_config, "_repo_root", lambda: tmp_path)
    monkeypatch.setenv("LOCAL_LOGS_ENABLED", "1")
    monkeypatch.setenv("LOG_FILE", "runtime.log")
    monkeypatch.delenv("BROWSER_AUTH_LOG_FILE", raising=False)

    setup_logging()
    logging.getLogger("browser_auth_service.service").info("browser auth detail")
    for handler in logging.getLogger().handlers:
        handler.flush()

    assert list((tmp_path / "logs" / "browser_auth_service").glob("*/*.log")) == []


def test_production_modules_do_not_import_legacy_global_logger() -> None:
    offenders: list[str] = []
    for path in sorted(_PROJECT_ROOT.rglob("*.py")):
        relative = path.relative_to(_PROJECT_ROOT).as_posix()
        if relative.startswith((".git/", ".venv/", "__pycache__/")):
            continue
        if relative == "shared/logging.py":
            continue
        text = path.read_text(encoding="utf-8")
        legacy_import = "from shared.logging import " + "logger"
        if legacy_import in text:
            offenders.append(relative)

    assert offenders == []
