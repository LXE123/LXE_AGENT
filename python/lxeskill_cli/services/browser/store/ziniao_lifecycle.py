from __future__ import annotations

import os
import subprocess


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
            if state == "LISTENING" and local_address.endswith(f":{safe_port}"):
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


class ZiniaoLifecycleManager:
    @classmethod
    def resolve_client_pid(cls, control_port: int, preferred_pid: int = 0) -> int:
        safe_pid = _safe_int(preferred_pid)
        if safe_pid > 0 and _is_process_alive(safe_pid):
            return safe_pid
        return _pid_from_control_port(control_port)


__all__ = ["ZiniaoLifecycleManager"]
