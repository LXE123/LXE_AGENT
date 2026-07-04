from __future__ import annotations

import logging
from collections.abc import Iterable
from contextvars import ContextVar, Token
from datetime import datetime
from pathlib import Path

from shared.env_config import env_text
from shared.log_config import local_logs_enabled


_MANAGED_HANDLER_ATTR = "_lxe_agent_logging_handler"
_DEFAULT_FORMAT = "➤ %(asctime)s %(levelname)-8s [%(display_name)s]%(log_context)s %(message)s"
_THIRD_PARTY_LOGGERS = ("httpx", "httpcore", "lark_oapi", "aiohttp")
_LOG_CONTEXT: ContextVar[tuple[str, str]] = ContextVar("lxe_agent_log_context", default=("", ""))

logger = logging.getLogger("bot_logger")


def get_logger(name: str | None = None) -> logging.Logger:
    safe_name = str(name or "").strip()
    return logging.getLogger(safe_name) if safe_name else logging.getLogger()


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _short_context_value(value: str, *, limit: int = 8) -> str:
    text = str(value or "").strip()
    return text[:limit] if len(text) > limit else text


def _display_logger_name(name: str) -> str:
    safe_name = str(name or "root").strip() or "root"
    if safe_name.startswith("agent_runtime."):
        first_segment = safe_name.removeprefix("agent_runtime.").split(".", 1)[0]
        if first_segment.endswith("_logging"):
            first_segment = first_segment[: -len("_logging")]
        return f"agent.{first_segment or 'runtime'}"
    if safe_name.startswith("platforms.feishu."):
        first_segment = safe_name.removeprefix("platforms.feishu.").split(".", 1)[0]
        if first_segment.endswith("_sender"):
            first_segment = first_segment[: -len("_sender")]
        return f"feishu.{first_segment or 'gateway'}"
    return safe_name


def _log_context_text(session_id: str, turn_id: str) -> str:
    parts: list[str] = []
    safe_session_id = str(session_id or "").strip()
    safe_turn_id = str(turn_id or "").strip()
    if safe_session_id:
        parts.append(f"s={_short_context_value(safe_session_id)}")
    if safe_turn_id:
        parts.append(f"t={_short_context_value(safe_turn_id)}")
    return f" [ctx {' '.join(parts)}]" if parts else ""


def set_log_context(*, session_id: str = "", turn_id: str = "") -> Token[tuple[str, str]]:
    return _LOG_CONTEXT.set((str(session_id or "").strip(), str(turn_id or "").strip()))


def reset_log_context(token: Token[tuple[str, str]]) -> None:
    _LOG_CONTEXT.reset(token)


class _LogContextFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        session_id, turn_id = _LOG_CONTEXT.get()
        record.session_id = str(session_id or "").strip()
        record.turn_id = str(turn_id or "").strip()
        record.display_name = _display_logger_name(record.name)
        record.log_context = _log_context_text(record.session_id, record.turn_id)
        return True


class _HumanReadableFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        if not hasattr(record, "display_name"):
            record.display_name = _display_logger_name(record.name)
        if not hasattr(record, "log_context"):
            record.log_context = _log_context_text(
                str(getattr(record, "session_id", "") or ""),
                str(getattr(record, "turn_id", "") or ""),
            )
        return super().format(record)


def _coerce_level(value: str, default: int) -> int:
    raw = str(value or "").strip().upper()
    if not raw:
        return int(default)
    level = logging.getLevelName(raw)
    if isinstance(level, int):
        return level
    try:
        return int(raw)
    except ValueError:
        return int(default)


def _configured_levels(raw_value: str) -> Iterable[tuple[str, int]]:
    for item in str(raw_value or "").split(","):
        if "=" not in item:
            continue
        raw_name, raw_level = item.split("=", 1)
        name = raw_name.strip()
        if not name:
            continue
        yield name, _coerce_level(raw_level, logging.NOTSET)


def _remove_managed_handlers(target_logger: logging.Logger) -> None:
    for handler in list(target_logger.handlers):
        if not getattr(handler, _MANAGED_HANDLER_ATTR, False):
            continue
        target_logger.removeHandler(handler)
        handler.close()


def _log_formatter() -> logging.Formatter:
    log_format = env_text("LOG_FORMAT", "text").strip().lower()
    if log_format not in {"", "text"}:
        # LOG_FORMAT values beyond text are reserved for a later PR.
        pass
    return _HumanReadableFormatter(_DEFAULT_FORMAT)


def _build_stderr_handler() -> logging.Handler:
    handler = logging.StreamHandler()
    setattr(handler, _MANAGED_HANDLER_ATTR, True)
    handler.addFilter(_LogContextFilter())
    handler.setFormatter(_log_formatter())
    return handler


def _runtime_log_path() -> Path | None:
    raw = env_text("LOG_FILE", "")
    if not raw:
        return None
    file_name = Path(raw).name.strip()
    if not file_name or file_name in {".", ".."}:
        return None
    day = datetime.now().strftime("%Y%m%d")
    return (_repo_root() / "logs" / "runtime" / day / file_name).resolve()


def _build_runtime_file_handler(path: Path) -> logging.Handler:
    path.parent.mkdir(parents=True, exist_ok=True)
    handler = logging.FileHandler(path, encoding="utf-8")
    setattr(handler, _MANAGED_HANDLER_ATTR, True)
    handler.addFilter(_LogContextFilter())
    handler.setFormatter(_log_formatter())
    return handler


def setup_logging() -> None:
    root = logging.getLogger()
    root_level = _coerce_level(env_text("LOG_LEVEL", "INFO"), logging.INFO)

    _remove_managed_handlers(root)
    root.addHandler(_build_stderr_handler())
    runtime_log_path = _runtime_log_path()
    if runtime_log_path is not None:
        from shared.log_retention import cleanup_local_logs

        cleanup_local_logs(repo_root=_repo_root())
    if runtime_log_path is not None and local_logs_enabled():
        root.addHandler(_build_runtime_file_handler(runtime_log_path))
    root.setLevel(root_level)

    logger.propagate = True
    logger.setLevel(logging.NOTSET)
    _remove_managed_handlers(logger)

    for name in _THIRD_PARTY_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)

    for name, level in _configured_levels(env_text("LOG_LEVELS", "")):
        logging.getLogger(name).setLevel(level)


__all__ = ["get_logger", "logger", "reset_log_context", "set_log_context", "setup_logging"]
