from __future__ import annotations

import ctypes
import json
import os
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import Any, Callable

from shared.logging import logger


PROJECT_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_DIR = PROJECT_ROOT / "tmp" / "gateway"
STATUS_PATH = RUNTIME_DIR / "gateway-status.json"
MARKER_PATH = RUNTIME_DIR / "gateway-planned-stop.json"
DEFAULT_MARKER_TTL_SECONDS = 300.0


@dataclass(frozen=True)
class GatewayStopResult:
    success: bool
    message: str


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    temp_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    temp_path.replace(path)


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _safe_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _pid_exists_windows(pid: int) -> bool:
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    synchronize = 0x00100000
    wait_object_0 = 0x00000000
    wait_timeout = 0x00000102
    wait_failed = 0xFFFFFFFF

    handle = kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        return False
    try:
        result = kernel32.WaitForSingleObject(handle, 0)
        if result == wait_timeout:
            return True
        if result in {wait_object_0, wait_failed}:
            return False
        return False
    finally:
        kernel32.CloseHandle(handle)


def _pid_exists_posix(pid: int) -> bool:
    if pid <= 0:
        return False
    if pid == os.getpid():
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _pid_exists(pid: int) -> bool:
    if os.name == "nt":
        return _pid_exists_windows(pid)
    return _pid_exists_posix(pid)


def write_gateway_status(boot_id: str) -> dict[str, Any]:
    safe_boot_id = str(boot_id or "").strip()
    if not safe_boot_id:
        raise ValueError("boot_id required")
    status = {
        "pid": os.getpid(),
        "boot_id": safe_boot_id,
        "started_at": _utc_now_iso(),
        "marker_path": str(MARKER_PATH),
    }
    _atomic_write_json(STATUS_PATH, status)
    return status


def read_gateway_status() -> dict[str, Any] | None:
    return _read_json(STATUS_PATH)


def clear_gateway_status(boot_id: str) -> None:
    status = read_gateway_status()
    if not status or str(status.get("boot_id") or "") != str(boot_id or ""):
        return
    try:
        STATUS_PATH.unlink()
    except FileNotFoundError:
        pass


def write_planned_stop_marker(status: dict[str, Any]) -> dict[str, Any]:
    target_pid = _safe_int(status.get("pid"))
    target_boot_id = str(status.get("boot_id") or "").strip()
    if target_pid <= 0:
        raise ValueError("gateway status is missing a valid pid")
    if not target_boot_id:
        raise ValueError("gateway status is missing a boot_id")

    marker = {
        "target_pid": target_pid,
        "target_boot_id": target_boot_id,
        "requester_pid": os.getpid(),
        "requested_at": _utc_now_iso(),
    }
    _atomic_write_json(MARKER_PATH, marker)
    return marker


def _marker_age_seconds(marker: dict[str, Any]) -> float | None:
    requested_at = str(marker.get("requested_at") or "").strip()
    if not requested_at:
        return None
    try:
        requested_dt = datetime.fromisoformat(requested_at)
    except ValueError:
        return None
    if requested_dt.tzinfo is None:
        requested_dt = requested_dt.replace(tzinfo=timezone.utc)
    return max(0.0, (datetime.now(timezone.utc) - requested_dt).total_seconds())


def _remove_marker() -> None:
    try:
        MARKER_PATH.unlink()
    except FileNotFoundError:
        pass


def planned_stop_marker_targets_self(
    boot_id: str,
    *,
    marker_ttl_seconds: float = DEFAULT_MARKER_TTL_SECONDS,
) -> bool:
    marker = _read_json(MARKER_PATH)
    if not marker:
        return False

    age = _marker_age_seconds(marker)
    if age is None or age > max(1.0, float(marker_ttl_seconds)):
        return False

    return (
        _safe_int(marker.get("target_pid")) == os.getpid()
        and str(marker.get("target_boot_id") or "") == str(boot_id or "")
    )


def consume_planned_stop_marker_for_self(
    boot_id: str,
    *,
    marker_ttl_seconds: float = DEFAULT_MARKER_TTL_SECONDS,
) -> bool:
    marker = _read_json(MARKER_PATH)
    if not marker:
        return False

    age = _marker_age_seconds(marker)
    if age is None or age > max(1.0, float(marker_ttl_seconds)):
        logger.info("[Gateway] removing stale planned-stop marker")
        _remove_marker()
        return False

    target_pid = _safe_int(marker.get("target_pid"))
    target_boot_id = str(marker.get("target_boot_id") or "")
    if target_pid != os.getpid() or target_boot_id != str(boot_id or ""):
        logger.info(
            "[Gateway] ignoring planned-stop marker for another gateway: "
            "target_pid=%s target_boot_id=%s current_pid=%s current_boot_id=%s",
            target_pid,
            target_boot_id,
            os.getpid(),
            boot_id,
        )
        _remove_marker()
        return False

    _remove_marker()
    return True


def request_gateway_stop(*, timeout_s: float = 30.0) -> GatewayStopResult:
    status = read_gateway_status()
    if not status:
        return GatewayStopResult(False, "Gateway is not running: status file not found.")

    target_pid = _safe_int(status.get("pid"))
    if target_pid <= 0:
        clear_gateway_status(str(status.get("boot_id") or ""))
        return GatewayStopResult(False, "Gateway status is invalid: missing pid.")

    if not _pid_exists(target_pid):
        clear_gateway_status(str(status.get("boot_id") or ""))
        return GatewayStopResult(False, f"Gateway is not running: stale pid {target_pid}.")

    try:
        write_planned_stop_marker(status)
    except Exception as exc:
        return GatewayStopResult(False, f"Failed to write planned-stop marker: {exc}")

    deadline = time.monotonic() + max(1.0, float(timeout_s))
    while time.monotonic() < deadline:
        if not _pid_exists(target_pid):
            return GatewayStopResult(True, f"Gateway stopped gracefully: pid={target_pid}.")
        time.sleep(0.5)

    return GatewayStopResult(
        False,
        f"Gateway stop requested, but pid {target_pid} did not exit within {timeout_s:.1f}s.",
    )


def run_planned_stop_watcher(
    stop_event: Event,
    *,
    boot_id: str,
    loop: Any,
    request_shutdown: Callable[[], None],
    poll_interval: float = 0.5,
) -> None:
    while not stop_event.is_set():
        try:
            if consume_planned_stop_marker_for_self(boot_id):
                if getattr(loop, "is_closed", lambda: False)():
                    logger.warning("[Gateway] planned stop marker received after loop closed")
                    return
                loop.call_soon_threadsafe(request_shutdown)
                return
        except Exception as exc:
            logger.debug("[Gateway] planned-stop watcher tick failed: %s", exc)
        stop_event.wait(max(0.05, float(poll_interval)))
