from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass, field
from enum import Enum
from functools import lru_cache
import os
from pathlib import Path
import shutil
import subprocess
import time
from threading import Lock
from typing import Any
from uuid import uuid4

from agent_runtime.emit_bus import request_heartbeat_wake
from shared.logging import logger
from shared.db.client import append_agent_session_pending_event, discard_agent_session_pending_event


DEFAULT_YIELD_MS = 10_000.0
DEFAULT_TIMEOUT_SEC = 120.0
DEFAULT_OUTPUT_LIMIT = 200_000
DEFAULT_PENDING_LIMIT = 30_000
DEFAULT_TAIL_LIMIT = 2_000
DEFAULT_POLL_WAIT_SEC = 5.0
DEFAULT_LOG_LIMIT = 2_000
_COMMAND_LOG_PREVIEW = 160
_TAIL_LOG_PREVIEW = 200
_WORKSPACE_ROOT = Path(__file__).resolve().parents[2]


def _is_pwsh_7_or_newer(executable: str) -> bool:
    try:
        completed = subprocess.run(
            [
                executable,
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$PSVersionTable.PSVersion.Major",
            ],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=5.0,
            check=False,
        )
    except Exception:
        return False
    if completed.returncode != 0:
        return False
    first_line = str(completed.stdout or "").strip().splitlines()[0:1]
    if not first_line:
        return False
    try:
        return int(first_line[0].strip()) >= 7
    except ValueError:
        return False


def _candidate_path(*parts: str | None) -> Path | None:
    safe_parts = [str(part or "").strip() for part in parts]
    if any(not part for part in safe_parts):
        return None
    return Path(*safe_parts)


def _existing_file(path: Path | None) -> str:
    if path is None:
        return ""
    try:
        return str(path) if path.exists() and path.is_file() else ""
    except OSError:
        return ""


@lru_cache(maxsize=1)
def _resolve_windows_powershell() -> str:
    program_files = os.environ.get("ProgramFiles") or os.environ.get("PROGRAMFILES") or r"C:\Program Files"
    program_w6432 = os.environ.get("ProgramW6432") or ""

    for candidate in (
        _existing_file(_candidate_path(program_files, "PowerShell", "7", "pwsh.exe")),
        _existing_file(_candidate_path(program_w6432, "PowerShell", "7", "pwsh.exe"))
        if program_w6432 and program_w6432 != program_files
        else "",
        shutil.which("pwsh") or shutil.which("pwsh.exe") or "",
    ):
        if candidate and _is_pwsh_7_or_newer(candidate):
            return candidate

    system_root = os.environ.get("SystemRoot") or os.environ.get("WINDIR") or ""
    windows_powershell = _existing_file(
        _candidate_path(system_root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    )
    if windows_powershell:
        return windows_powershell

    return shutil.which("powershell") or shutil.which("powershell.exe") or ""


def _windows_powershell_exec_args(command: str) -> list[str]:
    powershell = _resolve_windows_powershell()
    if not powershell:
        raise FileNotFoundError("No PowerShell executable found on this Windows host.")
    body = str(command or "").strip()
    body = f"{body}; if ($null -ne $LASTEXITCODE) {{ exit $LASTEXITCODE }}"
    if Path(powershell).name.lower() in {"pwsh", "pwsh.exe"}:
        body = "$PSStyle.OutputRendering = 'PlainText'; " + body
    return [
        powershell,
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        body,
    ]


def _project_venv_scripts_dir() -> Path:
    if os.name == "nt":
        return _WORKSPACE_ROOT / ".venv" / "Scripts"
    return _WORKSPACE_ROOT / ".venv" / "bin"


def _prepare_child_env(*, owner_session_id: str, origin_turn_id: str, exec_session_id: str) -> dict[str, str]:
    child_env = os.environ.copy()
    child_env["PYTHONIOENCODING"] = "utf-8"
    venv_scripts = _project_venv_scripts_dir()
    if venv_scripts.exists():
        child_env["VIRTUAL_ENV"] = str(venv_scripts.parent)
        child_env["PATH"] = str(venv_scripts) + os.pathsep + str(child_env.get("PATH") or "")
    child_env["LXE_AGENT_SESSION_ID"] = str(owner_session_id or "").strip()
    child_env["LXE_AGENT_TURN_ID"] = str(origin_turn_id or "").strip()
    child_env["LXE_EXEC_SESSION_ID"] = str(exec_session_id or "").strip()
    return child_env


class SessionStatus(str, Enum):
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    TIMEOUT = "timeout"
    KILLED = "killed"


@dataclass(slots=True)
class ExecSession:
    id: str
    command: str
    cwd: str
    owner_session_id: str = ""
    origin_turn_id: str = ""
    card_id: str = ""
    explicit_background: bool = False
    pid: int | None = None
    process: asyncio.subprocess.Process | None = None
    status: SessionStatus = SessionStatus.RUNNING
    exit_code: int | None = None
    stdout: str = ""
    stderr: str = ""
    pending_stdout: str = ""
    pending_stderr: str = ""
    stdout_tail: str = ""
    stderr_tail: str = ""
    max_output: int = DEFAULT_OUTPUT_LIMIT
    max_pending: int = DEFAULT_PENDING_LIMIT
    truncated: bool = False
    started_at: float = field(default_factory=time.time)
    ended_at: float | None = None
    timeout_sec: float | None = None
    done_event: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    pending_event: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    stdout_task: asyncio.Task[None] | None = field(default=None, repr=False)
    stderr_task: asyncio.Task[None] | None = field(default=None, repr=False)
    waiter_task: asyncio.Task[None] | None = field(default=None, repr=False)
    timeout_task: asyncio.Task[None] | None = field(default=None, repr=False)
    notification_task: asyncio.Task[None] | None = field(default=None, repr=False)
    notify_on_exit: bool = False
    notified: bool = False
    completion_consumed: bool = False
    completion_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)


class SessionRegistry:
    def __init__(self, ttl_sec: float = 1800.0) -> None:
        self._sessions: dict[str, ExecSession] = {}
        self._ttl_sec = float(ttl_sec)
        self._lock = Lock()

    def create(
        self,
        command: str,
        cwd: str,
        *,
        owner_session_id: str = "",
        origin_turn_id: str = "",
        card_id: str = "",
    ) -> ExecSession:
        session = ExecSession(
            id=f"exec_{uuid4().hex[:8]}",
            command=str(command or "").strip(),
            cwd=str(cwd or "").strip(),
            owner_session_id=str(owner_session_id or "").strip(),
            origin_turn_id=str(origin_turn_id or "").strip(),
            card_id=str(card_id or "").strip(),
        )
        with self._lock:
            self._sweep_locked()
            self._sessions[session.id] = session
        return session

    def get(self, session_id: str) -> ExecSession | None:
        safe_id = str(session_id or "").strip()
        with self._lock:
            self._sweep_locked()
            return self._sessions.get(safe_id)

    def list_all(self) -> list[ExecSession]:
        with self._lock:
            self._sweep_locked()
            return sorted(self._sessions.values(), key=lambda item: item.started_at, reverse=True)

    def remove(self, session_id: str) -> None:
        safe_id = str(session_id or "").strip()
        with self._lock:
            self._sweep_locked()
            self._sessions.pop(safe_id, None)

    def set_ttl_for_tests(self, ttl_sec: float) -> None:
        with self._lock:
            self._ttl_sec = float(ttl_sec)

    def _sweep_locked(self) -> None:
        now = time.time()
        expired = [
            sid for sid, session in self._sessions.items()
            if session.status != SessionStatus.RUNNING
            and session.ended_at
            and now - session.ended_at > self._ttl_sec
        ]
        for sid in expired:
            del self._sessions[sid]


_REGISTRY = SessionRegistry()


def get_exec_session_registry() -> SessionRegistry:
    return _REGISTRY


def _append_limited(existing: str, addition: str, limit: int) -> tuple[str, bool]:
    if not addition:
        return existing, False
    if len(existing) >= limit:
        return existing, True
    allowed = limit - len(existing)
    if len(addition) <= allowed:
        return existing + addition, False
    return existing + addition[:allowed], True


def _combine_stream_text(stdout: str, stderr: str) -> str:
    safe_stdout = str(stdout or "")
    safe_stderr = str(stderr or "")
    if safe_stdout and safe_stderr:
        return safe_stdout.rstrip() + "\n[stderr]\n" + safe_stderr.lstrip()
    return safe_stdout or safe_stderr


def _session_output(session: ExecSession) -> str:
    return _combine_stream_text(session.stdout, session.stderr)


def _session_pending_output(session: ExecSession) -> str:
    return _combine_stream_text(session.pending_stdout, session.pending_stderr)


def _session_tail(session: ExecSession) -> str:
    return _combine_stream_text(session.stdout_tail, session.stderr_tail)


def _append_stream_output(session: ExecSession, *, stream: str, text: str) -> None:
    safe_text = str(text or "")
    if not safe_text:
        return
    if stream == "stderr":
        session.stderr, output_truncated = _append_limited(session.stderr, safe_text, session.max_output)
        session.pending_stderr, pending_truncated = _append_limited(
            session.pending_stderr,
            safe_text,
            session.max_pending,
        )
        session.stderr_tail = (session.stderr_tail + safe_text)[-DEFAULT_TAIL_LIMIT:]
    else:
        session.stdout, output_truncated = _append_limited(session.stdout, safe_text, session.max_output)
        session.pending_stdout, pending_truncated = _append_limited(
            session.pending_stdout,
            safe_text,
            session.max_pending,
        )
        session.stdout_tail = (session.stdout_tail + safe_text)[-DEFAULT_TAIL_LIMIT:]
    if output_truncated or pending_truncated:
        session.truncated = True
    session.pending_event.set()


async def _pump_stream_output(session: ExecSession, *, stream: str) -> None:
    proc = session.process
    reader = None if proc is None else (proc.stderr if stream == "stderr" else proc.stdout)
    if reader is None:
        return
    while True:
        chunk = await reader.read(4096)
        if not chunk:
            return
        _append_stream_output(session, stream=stream, text=chunk.decode("utf-8", errors="replace"))


async def _run_taskkill(pid: int) -> bool:
    if os.name != "nt":
        return False
    try:
        killer = await asyncio.create_subprocess_exec(
            "taskkill",
            "/T",
            "/F",
            "/PID",
            str(pid),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except Exception:
        return False
    return (await killer.wait()) == 0


async def _terminate_process(session: ExecSession) -> None:
    proc = session.process
    if proc is None or proc.returncode is not None:
        return
    if session.pid:
        await _run_taskkill(int(session.pid))
    if proc.returncode is None:
        with contextlib.suppress(ProcessLookupError, PermissionError):
            proc.kill()
    with contextlib.suppress(Exception):
        await asyncio.wait_for(proc.wait(), timeout=5.0)


def _cancel_task(task: asyncio.Task[Any] | None) -> None:
    if task is not None and not task.done():
        task.cancel()


def _completion_tail(session: ExecSession) -> str:
    tail = str(_session_tail(session) or _session_output(session) or "").strip()
    if not tail:
        return "(no output)"
    return tail[-400:]


def _log_preview(text: str, *, limit: int) -> str:
    safe_text = str(text or "").strip()
    if len(safe_text) <= limit:
        return safe_text
    return safe_text[:limit] + "..."


def _completion_event(session: ExecSession) -> dict[str, Any]:
    status = str(session.status.value if isinstance(session.status, SessionStatus) else session.status or "").strip()
    exit_code = session.exit_code
    text = (
        f"Background process finished (process {session.id}, status {status}, exit code {exit_code}).\n"
        f"Last output:\n{_completion_tail(session)}"
    )
    return {
        "event_id": uuid4().hex,
        "job_id": session.id,
        "created_at": int(time.time()),
        "text": text,
        "card_id": str(session.card_id or "").strip(),
    }


async def _notify_completion(session: ExecSession) -> None:
    owner_session_id = ""
    event: dict[str, Any] = {}
    async with session.completion_lock:
        if session.completion_consumed:
            logger.info(
                "[ExecNotify] notify skipped: exec_session_id=%s reason=completion_consumed",
                session.id,
            )
            return
        if session.notified or not session.notify_on_exit:
            return
        owner_session_id = str(session.owner_session_id or "").strip()
        logger.info(
            "[ExecNotify] notify start: exec_session_id=%s owner_session_id=%s origin_turn_id=%s status=%s exit_code=%s",
            session.id,
            owner_session_id,
            str(session.origin_turn_id or "").strip(),
            session.status.value,
            session.exit_code,
        )
        if not owner_session_id:
            logger.warning(
                "[ExecNotify] notify skipped: exec_session_id=%s reason=missing_owner_session",
                session.id,
            )
            return
        event = _completion_event(session)
        enqueued_session = await append_agent_session_pending_event(owner_session_id, event)
        if enqueued_session is None:
            logger.warning(
                "[ExecNotify] event enqueue failed: exec_session_id=%s owner_session_id=%s event_id=%s reason=session_missing",
                session.id,
                owner_session_id,
                str(event.get("event_id") or "").strip(),
            )
            return
        logger.info(
            "[ExecNotify] event enqueued: exec_session_id=%s owner_session_id=%s event_id=%s job_id=%s",
            session.id,
            owner_session_id,
            str(event.get("event_id") or "").strip(),
            str(event.get("job_id") or "").strip(),
        )

    await request_heartbeat_wake(
        session_id=owner_session_id,
        reason="exec-event",
        card_id=str(session.card_id or "").strip(),
    )
    logger.info(
        "[ExecNotify] wake requested: exec_session_id=%s owner_session_id=%s event_id=%s heartbeat_reason=%s",
        session.id,
        owner_session_id,
        str(event.get("event_id") or "").strip(),
        "exec-event",
    )
    async with session.completion_lock:
        if not session.completion_consumed:
            session.notified = True
    logger.info(
        "[ExecNotify] notify done: exec_session_id=%s owner_session_id=%s event_id=%s",
        session.id,
        owner_session_id,
        str(event.get("event_id") or "").strip(),
    )


def _schedule_completion_notification(session: ExecSession) -> None:
    if session.completion_consumed:
        logger.info(
            "[ExecNotify] notify skipped: exec_session_id=%s reason=completion_consumed",
            session.id,
        )
        return
    if session.notified:
        logger.info(
            "[ExecNotify] notify skipped: exec_session_id=%s reason=already_notified",
            session.id,
        )
        return
    if not session.notify_on_exit:
        logger.info(
            "[ExecNotify] notify skipped: exec_session_id=%s reason=notify_disabled",
            session.id,
        )
        return
    if session.notification_task is not None and not session.notification_task.done():
        logger.info("[ExecNotify] notify already scheduled: exec_session_id=%s", session.id)
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        logger.warning(
            "[ExecNotify] notify schedule failed: exec_session_id=%s error=no_running_loop",
            session.id,
        )
        return

    async def _runner() -> None:
        try:
            await _notify_completion(session)
        except Exception as exc:
            logger.error(
                "[ExecNotify] notify failed: exec_session_id=%s owner_session_id=%s error=%s",
                session.id,
                str(session.owner_session_id or "").strip(),
                exc,
                exc_info=True,
            )
            if not session.completion_consumed:
                session.notified = False

    session.notification_task = loop.create_task(_runner(), name=f"exec-notify:{session.id}")


def _finish_session(session: ExecSession, *, status_override: SessionStatus | None = None) -> None:
    if session.ended_at is not None:
        if not session.done_event.is_set():
            session.done_event.set()
        return
    proc = session.process
    if proc is not None:
        session.exit_code = proc.returncode
    session.ended_at = time.time()
    if status_override is not None:
        session.status = status_override
    elif session.status == SessionStatus.RUNNING:
        session.status = SessionStatus.COMPLETED if int(session.exit_code or 0) == 0 else SessionStatus.FAILED
    _cancel_task(session.timeout_task)
    if not session.done_event.is_set():
        session.done_event.set()
    logger.info(
        "[ExecNotify] exec finished: exec_session_id=%s owner_session_id=%s status=%s exit_code=%s duration_sec=%.2f notify_on_exit=%s tail=%s",
        session.id,
        str(session.owner_session_id or "").strip(),
        session.status.value,
        session.exit_code,
        _duration_seconds(session),
        bool(session.notify_on_exit),
        _log_preview(_completion_tail(session), limit=_TAIL_LOG_PREVIEW),
    )
    _schedule_completion_notification(session)


async def _watch_session(session: ExecSession) -> None:
    proc = session.process
    if proc is None:
        return
    try:
        await proc.wait()
        if session.stdout_task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await session.stdout_task
        if session.stderr_task is not None:
            with contextlib.suppress(asyncio.CancelledError):
                await session.stderr_task
    finally:
        _finish_session(session)


async def _enforce_timeout(session: ExecSession, timeout_sec: float) -> None:
    try:
        await asyncio.sleep(float(timeout_sec))
    except asyncio.CancelledError:
        return
    if session.status != SessionStatus.RUNNING:
        return
    session.status = SessionStatus.TIMEOUT
    await _terminate_process(session)
    _finish_session(session, status_override=SessionStatus.TIMEOUT)


def _duration_seconds(session: ExecSession) -> float:
    return round(((session.ended_at or time.time()) - session.started_at), 2)


def _is_terminal_status(status: SessionStatus | str) -> bool:
    value = status.value if isinstance(status, SessionStatus) else status
    return str(value or "").strip() != SessionStatus.RUNNING.value


async def _consume_completion(session: ExecSession, *, reason: str) -> bool:
    if not _is_terminal_status(session.status):
        return False
    async with session.completion_lock:
        if not _is_terminal_status(session.status) or session.completion_consumed:
            return False
        previous_notify_on_exit = bool(session.notify_on_exit)
        session.completion_consumed = True
        session.notify_on_exit = False
        owner_session_id = str(session.owner_session_id or "").strip()
        deleted = 0
        try:
            if owner_session_id:
                deleted = await discard_agent_session_pending_event(owner_session_id, session.id)
        except Exception:
            session.completion_consumed = False
            session.notify_on_exit = previous_notify_on_exit
            raise
        logger.info(
            "[ExecNotify] completion consumed: exec_session_id=%s owner_session_id=%s reason=%s deleted_events=%s",
            session.id,
            owner_session_id,
            str(reason or "").strip() or "process",
            deleted,
        )
        return True


def _completed_payload(session: ExecSession) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "status": session.status.value,
        "session": session.id,
        "exit_code": session.exit_code,
        "output": _session_output(session).strip() or "(no output)",
        "duration_sec": _duration_seconds(session),
    }
    if session.truncated:
        payload["truncated"] = True
    return payload


def _running_payload(session: ExecSession) -> dict[str, Any]:
    if session.explicit_background:
        message = (
            f"命令仍在运行。除非用户明确要求，否则不要用 process(action='poll', "
            f"session='{session.id}') 查看进度。"
        )
    else:
        message = (
            f"命令仍在运行。用 process(action='poll', session='{session.id}') 查看进度。"
        )
    payload: dict[str, Any] = {
        "status": session.status.value,
        "session": session.id,
        "pid": session.pid,
        "message": message,
        "tail": _session_tail(session) or "(暂无输出)",
    }
    if session.truncated:
        payload["truncated"] = True
    return payload


async def run_exec_command(
    *,
    command: str,
    cwd: str,
    timeout: float | None = None,
    background: bool = False,
    yield_ms: float | None = None,
    owner_session_id: str = "",
    origin_turn_id: str = "",
    card_id: str = "",
    cancel_event: asyncio.Event | None = None,
) -> dict[str, Any]:
    session = _REGISTRY.create(
        command=command,
        cwd=cwd,
        owner_session_id=owner_session_id,
        origin_turn_id=origin_turn_id,
        card_id=card_id,
    )
    session.explicit_background = bool(background)
    session.notify_on_exit = bool(background)
    session.timeout_sec = None if background else float(timeout or DEFAULT_TIMEOUT_SEC)
    creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0) if os.name == "nt" else 0

    try:
        child_env = _prepare_child_env(
            owner_session_id=owner_session_id,
            origin_turn_id=origin_turn_id,
            exec_session_id=session.id,
        )
        if os.name == "nt":
            proc = await asyncio.create_subprocess_exec(
                *_windows_powershell_exec_args(str(command or "").strip()),
                cwd=str(cwd or "").strip(),
                env=child_env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.PIPE,
                creationflags=creationflags,
            )
        else:
            proc = await asyncio.create_subprocess_shell(
                str(command or "").strip(),
                cwd=str(cwd or "").strip(),
                env=child_env,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.PIPE,
                creationflags=creationflags,
            )
    except Exception as exc:
        session.status = SessionStatus.FAILED
        session.ended_at = time.time()
        session.done_event.set()
        logger.error(
            "[Exec] subprocess spawn failed: exec_session_id=%s exc_type=%s exc_repr=%s",
            session.id,
            type(exc).__name__,
            repr(exc),
            exc_info=True,
        )
        return {
            "status": SessionStatus.FAILED.value,
            "session": session.id,
            "error": f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__,
        }

    session.process = proc
    session.pid = proc.pid
    logger.info(
        "[ExecNotify] exec started: exec_session_id=%s owner_session_id=%s origin_turn_id=%s pid=%s background=%s cwd=%s command=%s",
        session.id,
        str(session.owner_session_id or "").strip(),
        str(session.origin_turn_id or "").strip(),
        session.pid,
        bool(background),
        str(cwd or "").strip(),
        _log_preview(session.command, limit=_COMMAND_LOG_PREVIEW),
    )
    session.stdout_task = asyncio.create_task(_pump_stream_output(session, stream="stdout"))
    session.stderr_task = asyncio.create_task(_pump_stream_output(session, stream="stderr"))
    session.waiter_task = asyncio.create_task(_watch_session(session))
    if session.timeout_sec is not None:
        session.timeout_task = asyncio.create_task(_enforce_timeout(session, session.timeout_sec))

    if not background:
        wait_sec = max(0.0, float(DEFAULT_YIELD_MS if yield_ms is None else yield_ms) / 1000.0)
        if wait_sec > 0:
            wait_tasks: set[asyncio.Task[Any]] = {asyncio.create_task(session.done_event.wait())}
            if cancel_event is not None:
                wait_tasks.add(asyncio.create_task(cancel_event.wait()))
            try:
                done, pending = await asyncio.wait(
                    wait_tasks,
                    timeout=wait_sec,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                if cancel_event is not None and cancel_event.is_set() and session.status == SessionStatus.RUNNING:
                    await _terminate_process(session)
                    _finish_session(session, status_override=SessionStatus.KILLED)
            finally:
                for task in wait_tasks:
                    if not task.done():
                        task.cancel()
    if not session.done_event.is_set():
        session.notify_on_exit = True
    elif session.notify_on_exit:
        _schedule_completion_notification(session)

    return _completed_payload(session) if session.done_event.is_set() else _running_payload(session)


async def process_exec_session(
    *,
    action: str,
    session_id: str | None = None,
    text: str | None = None,
    offset: int | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    safe_action = str(action or "").strip()
    if safe_action == "list":
        sessions = _REGISTRY.list_all()
        return {
            "sessions": [
                {
                    "session": session.id,
                    "command": session.command[:100],
                    "status": session.status.value,
                    "pid": session.pid,
                    "duration_sec": _duration_seconds(session),
                }
                for session in sessions
            ],
            "message": "没有活跃或最近的会话。" if not sessions else "",
        }

    safe_session_id = str(session_id or "").strip()
    if not safe_session_id:
        return {"error": "需要指定 session 参数。"}
    session = _REGISTRY.get(safe_session_id)
    if session is None:
        return {"error": f"会话 {safe_session_id} 不存在。"}

    if safe_action == "poll":
        if session.status == SessionStatus.RUNNING and not _session_pending_output(session):
            waiter = asyncio.create_task(session.done_event.wait())
            pending_waiter = asyncio.create_task(session.pending_event.wait())
            try:
                done, pending = await asyncio.wait(
                    {waiter, pending_waiter},
                    timeout=DEFAULT_POLL_WAIT_SEC,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                for task in done:
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
            finally:
                for task in (waiter, pending_waiter):
                    if not task.done():
                        task.cancel()
        payload: dict[str, Any] = {
            "session": session.id,
            "status": session.status.value,
            "new_output": _session_pending_output(session) or "(no new output)",
        }
        session.pending_stdout = ""
        session.pending_stderr = ""
        session.pending_event.clear()
        if session.status != SessionStatus.RUNNING:
            payload["exit_code"] = session.exit_code
            payload["duration_sec"] = _duration_seconds(session)
        if session.truncated:
            payload["truncated"] = True
        if session.status != SessionStatus.RUNNING:
            await _consume_completion(session, reason="process.poll")
        return payload

    if safe_action == "log":
        stdout_lines = session.stdout.splitlines()
        stderr_lines = session.stderr.splitlines()
        start = max(0, int(offset or 1) - 1)
        safe_limit = max(1, int(limit or DEFAULT_LOG_LIMIT))
        stdout_end = min(len(stdout_lines), start + safe_limit)
        stderr_end = min(len(stderr_lines), start + safe_limit)
        stdout_page = stdout_lines[start:stdout_end]
        stderr_page = stderr_lines[start:stderr_end]
        total_lines = max(len(stdout_lines), len(stderr_lines))
        showing_end = min(total_lines, start + safe_limit)
        payload = {
            "session": session.id,
            "total_lines": total_lines,
            "showing": f"{start + 1}-{showing_end}" if total_lines else "0-0",
            "output": _combine_stream_text("\n".join(stdout_page), "\n".join(stderr_page)) or "(no output)",
        }
        if showing_end < total_lines:
            payload["message"] = f"还有 {total_lines - showing_end} 行。用 offset={showing_end + 1} 继续。"
        if session.truncated:
            payload["truncated"] = True
        if session.status != SessionStatus.RUNNING:
            await _consume_completion(session, reason="process.log")
        return payload

    if safe_action == "write":
        safe_text = str(text or "")
        if not safe_text:
            return {"error": "write 操作需要 text 参数。"}
        if session.status != SessionStatus.RUNNING:
            return {"error": f"会话 {session.id} 已结束，无法写入。"}
        proc = session.process
        writer = None if proc is None else proc.stdin
        if writer is None:
            return {"error": f"会话 {session.id} 不支持写入。"}
        try:
            writer.write((safe_text + "\n").encode("utf-8"))
            await writer.drain()
        except Exception as exc:
            return {"error": f"写入失败: {exc}"}
        return {"status": "ok", "session": session.id, "message": f"已写入 {len(safe_text) + 1} 字节。"}

    if safe_action == "kill":
        if session.status != SessionStatus.RUNNING:
            return {"message": f"会话 {session.id} 已经结束（{session.status.value}）。"}
        session.status = SessionStatus.KILLED
        await _terminate_process(session)
        _finish_session(session, status_override=SessionStatus.KILLED)
        return {"status": SessionStatus.KILLED.value, "session": session.id}

    if safe_action == "remove":
        if session.status == SessionStatus.RUNNING:
            session.status = SessionStatus.KILLED
            await _terminate_process(session)
            _finish_session(session, status_override=SessionStatus.KILLED)
        _REGISTRY.remove(session.id)
        return {"status": "removed", "session": session.id}

    return {"error": f"未知 action: {safe_action}"}


async def clear_exec_sessions_for_tests() -> None:
    sessions = _REGISTRY.list_all()
    for session in sessions:
        _cancel_task(session.notification_task)
        _cancel_task(session.stdout_task)
        _cancel_task(session.stderr_task)
        if session.process is not None and session.process.returncode is None:
            await _terminate_process(session)
            _finish_session(session, status_override=SessionStatus.KILLED)
        _REGISTRY.remove(session.id)
