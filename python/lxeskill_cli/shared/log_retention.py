from __future__ import annotations

import re
import shutil
import threading
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

from shared.env_config import env_int, env_text
from shared.logging import get_logger
from shared.repository import repository_root

logger = get_logger(__name__)


_DATE_NAME = re.compile(r"^\d{8}$")
_DATE_JSONL_NAME = re.compile(r"^\d{8}\.jsonl$")
_RETENTION_LOCK = threading.Lock()
_RETENTION_RAN = False


@dataclass(frozen=True, slots=True)
class LocalLogRetentionResult:
    retention_days: int
    cutoff_date: date
    deleted_paths: tuple[Path, ...]
    failed_paths: tuple[Path, ...]


def _repo_root() -> Path:
    return repository_root()


def local_log_retention_days() -> int:
    return env_int("LOCAL_LOG_RETENTION_DAYS", 7, minimum=1)


def _resolve_log_path(name: str, default: str, *, repo_root: Path) -> Path:
    raw = env_text(name, default)
    path = Path(raw or default)
    if not path.is_absolute():
        path = repo_root / path
    return path.resolve()


def _today(value: date | datetime | None) -> date:
    if value is None:
        return datetime.now().date()
    if isinstance(value, datetime):
        return value.date()
    return value


def _parse_date_name(value: str) -> date | None:
    if not _DATE_NAME.fullmatch(value):
        return None
    try:
        return datetime.strptime(value, "%Y%m%d").date()
    except ValueError:
        return None


def _parse_date_jsonl_name(value: str) -> date | None:
    if not _DATE_JSONL_NAME.fullmatch(value):
        return None
    return _parse_date_name(value[:8])


def _date_dir_roots(*, repo_root: Path) -> tuple[Path, ...]:
    return (
        _resolve_log_path("AGENT_STREAM_TRACE_DIR", "var/logs/agent_traces", repo_root=repo_root),
        _resolve_log_path("AGENT_SSE_WIRE_TRACE_DIR", "var/logs/sse_wire_traces", repo_root=repo_root),
        (repo_root / "var" / "logs" / "feishu_msg").resolve(),
        (repo_root / "var" / "logs" / "runtime").resolve(),
    )


def _date_jsonl_roots(*, repo_root: Path) -> tuple[Path, ...]:
    return (
        _resolve_log_path("FEISHU_RAW_EVENT_DUMP_DIR", "var/logs/feishu_raw_events", repo_root=repo_root),
    )


def _remove_path(path: Path, *, deleted: list[Path], failed: list[Path]) -> None:
    try:
        if path.is_dir() and not path.is_symlink():
            shutil.rmtree(path)
        elif path.is_file() and not path.is_symlink():
            path.unlink()
        else:
            return
        deleted.append(path)
    except OSError as exc:
        failed.append(path)
        logger.warning("[LogRetention] failed to delete expired log path: path=%s error=%s", path, exc)


def _iter_children(root: Path, *, failed: list[Path]) -> list[Path]:
    if not root.exists():
        return []
    try:
        return list(root.iterdir())
    except OSError as exc:
        failed.append(root)
        logger.warning("[LogRetention] failed to scan log root: path=%s error=%s", root, exc)
        return []


def cleanup_local_logs(
    *,
    retention_days: int | None = None,
    today: date | datetime | None = None,
    repo_root: Path | None = None,
) -> LocalLogRetentionResult:
    safe_days = max(1, int(retention_days if retention_days is not None else local_log_retention_days()))
    safe_today = _today(today)
    cutoff_date = safe_today - timedelta(days=safe_days - 1)
    root = Path(repo_root).resolve() if repo_root is not None else _repo_root()
    deleted: list[Path] = []
    failed: list[Path] = []

    for log_root in _date_dir_roots(repo_root=root):
        for child in _iter_children(log_root, failed=failed):
            entry_date = _parse_date_name(child.name)
            if entry_date is None or entry_date >= cutoff_date or not child.is_dir() or child.is_symlink():
                continue
            _remove_path(child, deleted=deleted, failed=failed)

    for log_root in _date_jsonl_roots(repo_root=root):
        for child in _iter_children(log_root, failed=failed):
            entry_date = _parse_date_jsonl_name(child.name)
            if entry_date is None or entry_date >= cutoff_date:
                continue
            _remove_path(child, deleted=deleted, failed=failed)

    if deleted:
        logger.info(
            "[LogRetention] expired local logs deleted: count=%d retention_days=%d cutoff=%s",
            len(deleted),
            safe_days,
            cutoff_date.isoformat(),
        )

    return LocalLogRetentionResult(
        retention_days=safe_days,
        cutoff_date=cutoff_date,
        deleted_paths=tuple(deleted),
        failed_paths=tuple(failed),
    )


def ensure_local_log_retention_once() -> LocalLogRetentionResult | None:
    global _RETENTION_RAN
    if _RETENTION_RAN:
        return None
    with _RETENTION_LOCK:
        if _RETENTION_RAN:
            return None
        result = cleanup_local_logs()
        _RETENTION_RAN = True
        return result


def reset_local_log_retention_once_for_tests() -> None:
    global _RETENTION_RAN
    with _RETENTION_LOCK:
        _RETENTION_RAN = False


__all__ = [
    "LocalLogRetentionResult",
    "cleanup_local_logs",
    "ensure_local_log_retention_once",
    "local_log_retention_days",
    "reset_local_log_retention_once_for_tests",
]
