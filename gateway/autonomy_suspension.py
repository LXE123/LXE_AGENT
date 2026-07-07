"""会话级自主性闸门。

/stop 之后挂起该会话的自主唤醒（后台任务完成不再自动开启新 turn），
直到用户发来下一条消息才恢复。挂起状态是进程内的——唤醒请求与 exec
会话注册表同样只存在于当前进程，重启后不会产生自主唤醒，因此无需落盘；
积压的完成事件仍持久化在 pending events 中，随下一条用户消息送达。
"""
from __future__ import annotations

_suspended_session_ids: set[str] = set()


def suspend_session_autonomy(session_id: str) -> None:
    safe_id = str(session_id or "").strip()
    if safe_id:
        _suspended_session_ids.add(safe_id)


def resume_session_autonomy(session_id: str) -> bool:
    """Clear the suspension for a session. Returns True if it was suspended."""
    safe_id = str(session_id or "").strip()
    if safe_id in _suspended_session_ids:
        _suspended_session_ids.discard(safe_id)
        return True
    return False


def is_session_autonomy_suspended(session_id: str) -> bool:
    return str(session_id or "").strip() in _suspended_session_ids


def reset_autonomy_suspension_for_tests() -> None:
    _suspended_session_ids.clear()


__all__ = [
    "is_session_autonomy_suspended",
    "reset_autonomy_suspension_for_tests",
    "resume_session_autonomy",
    "suspend_session_autonomy",
]
