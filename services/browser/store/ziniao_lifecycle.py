from __future__ import annotations

import os
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, TypeVar

from shared.logging import logger


_T = TypeVar("_T")
_R = TypeVar("_R")


def _safe_int(value: object) -> int:
    try:
        return int(value or 0)
    except Exception:
        return 0


def _is_process_alive(pid: int) -> bool:
    safe_pid = _safe_int(pid)
    if safe_pid <= 0:
        return False
    try:
        if os.name == "nt":
            result = subprocess.run(
                ["tasklist", "/FI", f"PID eq {safe_pid}"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return str(safe_pid) in str(result.stdout or "")
        os.kill(safe_pid, 0)
        return True
    except Exception:
        return False


def _kill_process(pid: int) -> bool:
    safe_pid = _safe_int(pid)
    if safe_pid <= 0:
        return False
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(safe_pid), "/T", "/F"],
                capture_output=True,
                text=True,
                timeout=10,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return True
        os.kill(safe_pid, 15)
        return True
    except Exception:
        return False


def _pid_from_control_port(control_port: int) -> int:
    safe_port = _safe_int(control_port)
    if safe_port <= 0:
        return 0

    if os.name == "nt":
        try:
            result = subprocess.run(
                ["netstat", "-ano", "-p", "tcp"],
                capture_output=True,
                text=True,
                timeout=8,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception:
            return 0
        for line in str(result.stdout or "").splitlines():
            parts = line.split()
            if len(parts) < 5:
                continue
            local_address = parts[1]
            state = parts[3].upper()
            pid_text = parts[4]
            if state != "LISTENING":
                continue
            if local_address.endswith(f":{safe_port}"):
                return _safe_int(pid_text)
        return 0

    try:
        result = subprocess.run(
            ["lsof", "-nP", f"-iTCP:{safe_port}", "-sTCP:LISTEN", "-t"],
            capture_output=True,
            text=True,
            timeout=8,
            check=False,
        )
    except Exception:
        return 0
    for line in str(result.stdout or "").splitlines():
        pid = _safe_int(line.strip())
        if pid > 0:
            return pid
    return 0


def _wait_for_process_exit(pid: int, *, timeout_seconds: float = 5.0) -> bool:
    safe_pid = _safe_int(pid)
    if safe_pid <= 0:
        return True
    deadline = time.time() + max(0.1, float(timeout_seconds or 0))
    while time.time() < deadline:
        if not _is_process_alive(safe_pid):
            return True
        time.sleep(0.2)
    return not _is_process_alive(safe_pid)


@dataclass
class _ClientTracker:
    control_port: int
    client_path: str = ""
    client_pid: int = 0
    browser_refs: set[str] = field(default_factory=set)
    lock: threading.RLock = field(default_factory=threading.RLock, repr=False)


class ZiniaoLifecycleManager:
    _lock = threading.RLock()
    _clients: dict[int, _ClientTracker] = {}

    @classmethod
    def resolve_client_pid(cls, control_port: int, preferred_pid: int = 0) -> int:
        safe_pid = _safe_int(preferred_pid)
        if safe_pid > 0 and _is_process_alive(safe_pid):
            return safe_pid
        return _pid_from_control_port(control_port)

    @classmethod
    def register_client(cls, *, control_port: int, client_path: str = "", client_pid: int = 0) -> int:
        safe_port = _safe_int(control_port)
        if safe_port <= 0:
            return 0
        resolved_pid = cls.resolve_client_pid(safe_port, preferred_pid=client_pid)
        with cls._lock:
            tracker = cls._clients.get(safe_port)
            if tracker is None:
                tracker = _ClientTracker(control_port=safe_port)
                cls._clients[safe_port] = tracker
            with tracker.lock:
                if client_path:
                    tracker.client_path = str(client_path or "").strip()
                if resolved_pid > 0:
                    tracker.client_pid = resolved_pid
        return resolved_pid

    @classmethod
    def register_store(
        cls,
        *,
        control_port: int,
        browser_ref: str,
        client_path: str = "",
        client_pid: int = 0,
    ) -> int:
        safe_port = _safe_int(control_port)
        safe_ref = str(browser_ref or "").strip()
        resolved_pid = cls.register_client(control_port=safe_port, client_path=client_path, client_pid=client_pid)
        if safe_port <= 0 or not safe_ref:
            return resolved_pid
        with cls._lock:
            tracker = cls._clients.get(safe_port)
            if tracker is None:
                tracker = _ClientTracker(control_port=safe_port)
                cls._clients[safe_port] = tracker
            with tracker.lock:
                tracker.browser_refs.add(safe_ref)
        return resolved_pid

    @classmethod
    def release_store(
        cls,
        *,
        control_port: int,
        browser_ref: str,
        client,
        client_path: str = "",
        client_pid: int = 0,
    ) -> dict[str, object]:
        safe_port = _safe_int(control_port)
        safe_ref = str(browser_ref or "").strip()
        resolved_pid = cls.register_client(control_port=safe_port, client_path=client_path, client_pid=client_pid)
        should_shutdown = False

        with cls._lock:
            tracker = cls._clients.get(safe_port)
            if tracker is not None:
                with tracker.lock:
                    if safe_ref:
                        tracker.browser_refs.discard(safe_ref)
                    if not tracker.browser_refs:
                        should_shutdown = True

        errors: list[str] = []
        stopped_store = False
        if safe_ref:
            try:
                client.stop_browser(safe_ref)
                stopped_store = True
            except Exception as exc:
                errors.append(f"stopBrowser failed: {exc}")

        shutdown_result = cls.shutdown_client_if_idle(
            control_port=safe_port,
            client=client,
            client_path=client_path,
            client_pid=resolved_pid,
            force=should_shutdown,
        )
        errors.extend(str(item) for item in list(shutdown_result.get("errors") or []))
        return {
            "stopped_store": stopped_store,
            "shutdown_client": bool(shutdown_result.get("shutdown_client")),
            "killed_client": bool(shutdown_result.get("killed_client")),
            "client_pid": int(shutdown_result.get("client_pid") or resolved_pid or 0),
            "errors": errors,
        }

    @classmethod
    def shutdown_client_if_idle(
        cls,
        *,
        control_port: int,
        client,
        client_path: str = "",
        client_pid: int = 0,
        force: bool = False,
    ) -> dict[str, object]:
        safe_port = _safe_int(control_port)
        resolved_pid = cls.register_client(control_port=safe_port, client_path=client_path, client_pid=client_pid)
        should_shutdown = bool(force)

        with cls._lock:
            tracker = cls._clients.get(safe_port)
            if tracker is not None:
                with tracker.lock:
                    if not tracker.browser_refs:
                        should_shutdown = True
                        if tracker.client_pid > 0:
                            resolved_pid = tracker.client_pid

        errors: list[str] = []
        killed_client = False
        if should_shutdown and client is not None:
            try:
                client.exit_client()
            except Exception as exc:
                errors.append(f"exit failed: {exc}")

            final_pid = cls.resolve_client_pid(safe_port, preferred_pid=resolved_pid)
            if final_pid > 0 and not _wait_for_process_exit(final_pid):
                if _kill_process(final_pid):
                    killed_client = True
            resolved_pid = final_pid or resolved_pid

            with cls._lock:
                tracker = cls._clients.get(safe_port)
                if tracker is not None:
                    with tracker.lock:
                        if not tracker.browser_refs:
                            cls._clients.pop(safe_port, None)

            if killed_client:
                logger.info(
                    "[ZiniaoLifecycle] client process killed after idle shutdown: port=%s pid=%s",
                    safe_port,
                    resolved_pid,
                )

        return {
            "shutdown_client": should_shutdown,
            "killed_client": killed_client,
            "client_pid": resolved_pid,
            "errors": errors,
        }


def run_store_tasks_in_threads(
    store_items: Iterable[_T],
    task_fn: Callable[[_T], _R],
    *,
    max_threads: int = 3,
) -> list[_R]:
    items = list(store_items or [])
    if not items:
        return []

    worker_count = max(1, min(int(max_threads or 1), len(items)))
    results: list[_R] = []
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = [executor.submit(task_fn, item) for item in items]
        for future in futures:
            results.append(future.result())
    return results


__all__ = [
    "ZiniaoLifecycleManager",
    "run_store_tasks_in_threads",
]
