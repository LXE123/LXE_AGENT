"""会话级 steering 开关。

默认关闭：turn 执行期间用户发来的消息会排队成下一个 turn（严格串行）。
开启后（用户输入 /steer 切换）：turn 执行期间的消息不再新开 turn，而是注入
当前正在运行的 turn，在下一个工具调用间隙（step 边界）被模型看到，从而实时
修正方向。开关是进程内状态，重启后回到默认关闭。
"""
from __future__ import annotations

_steering_enabled_session_ids: set[str] = set()


def toggle_session_steering(session_id: str) -> bool:
    """Flip steering mode for a session. Returns the new state (True=enabled)."""
    safe_id = str(session_id or "").strip()
    if not safe_id:
        return False
    if safe_id in _steering_enabled_session_ids:
        _steering_enabled_session_ids.discard(safe_id)
        return False
    _steering_enabled_session_ids.add(safe_id)
    return True


def set_session_steering(session_id: str, enabled: bool) -> None:
    safe_id = str(session_id or "").strip()
    if not safe_id:
        return
    if enabled:
        _steering_enabled_session_ids.add(safe_id)
    else:
        _steering_enabled_session_ids.discard(safe_id)


def is_session_steering_enabled(session_id: str) -> bool:
    return str(session_id or "").strip() in _steering_enabled_session_ids


def reset_steering_mode_for_tests() -> None:
    _steering_enabled_session_ids.clear()


__all__ = [
    "is_session_steering_enabled",
    "reset_steering_mode_for_tests",
    "set_session_steering",
    "toggle_session_steering",
]
