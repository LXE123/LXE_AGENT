from __future__ import annotations

from typing import Any

from services.browser.tools.driver_session import (
    attached_driver,
    check_ip,
    open_launcher_page,
    select_first_normal_tab,
)
from services.browser.store.store_driver_session import store_lock
from services.browser.store.store_session_service import StoreSessionService
from services.browser.store.ziniao_browser_client import ZiniaoBrowserClient
from services.browser.store.ziniao_lifecycle import ZiniaoLifecycleManager
from services.browser.store.ziniao_trace import trace_context


def _store_session_service() -> StoreSessionService:
    return StoreSessionService()


def _client_running() -> bool:
    client = ZiniaoBrowserClient()
    return ZiniaoLifecycleManager.resolve_client_pid(client.control_port) > 0


def _status_data(*, service: StoreSessionService | None = None) -> dict[str, Any]:
    safe_service = service or _store_session_service()
    status_data = safe_service.list_store_status()
    running_stores = list(status_data.get("running_stores") or [])
    inactive_stores = list(status_data.get("inactive_stores") or [])
    return {
        "running_stores": [
            {
                "store_id": str(item.get("browserOauth") or "").strip(),
                "browser_id": int(item.get("browserId") or 0),
                "store_name": str(item.get("browserName") or "").strip(),
            }
            for item in running_stores
        ],
        "inactive_stores": [
            {
                "store_id": str(item.get("browserOauth") or "").strip(),
                "browser_id": int(item.get("browserId") or 0),
                "store_name": str(item.get("browserName") or "").strip(),
            }
            for item in inactive_stores
        ],
        "client_running": bool(_client_running()),
    }


def _format_status_summary(status: dict[str, Any]) -> str:
    running_stores = list(status.get("running_stores") or [])
    inactive_stores = list(status.get("inactive_stores") or [])
    lines = [
        "## 紫鸟状态",
        "",
        f"client_running: {bool(status.get('client_running'))}",
        f"running_store_count: {len(running_stores)}",
        f"inactive_store_count: {len(inactive_stores)}",
    ]
    if running_stores:
        lines.append("")
        lines.append("Running stores:")
        for item in running_stores:
            lines.append(
                "- "
                + " | ".join(
                    [
                        str(item.get("store_name") or "").strip() or "未命名店铺",
                        f"store_id={str(item.get('store_id') or '').strip()}",
                        f"browser_id={int(item.get('browser_id') or 0)}",
                    ]
                )
            )
    if inactive_stores:
        lines.append("")
        lines.append("Inactive stores:")
        for item in inactive_stores:
            lines.append(
                "- "
                + " | ".join(
                    [
                        str(item.get("store_name") or "").strip() or "未命名店铺",
                        f"store_id={str(item.get('store_id') or '').strip()}",
                        f"browser_id={int(item.get('browser_id') or 0)}",
                    ]
                )
            )
    return "\n".join(lines).strip()


def dispatch_ziniao_browser(arguments: dict[str, Any]) -> dict[str, Any]:
    action = str(arguments.get("action") or "").strip().lower()
    store_id = str(arguments.get("store_id") or "").strip()
    with trace_context(f"ziniao_browser.{action or 'unknown'}", store_id=store_id):
        return _dispatch_ziniao_browser(arguments)


def _dispatch_ziniao_browser(arguments: dict[str, Any]) -> dict[str, Any]:
    action = str(arguments.get("action") or "").strip().lower()
    service = _store_session_service()

    if action == "open_store":
        store_id = str(arguments.get("store_id") or "").strip()
        with store_lock(store_id):
            store_session, start_result = service.start_store_session(store_id)
            ip_detection_page = str(start_result.get("ipDetectionPage") or "").strip()
            launcher_page = str(start_result.get("launcherPage") or "").strip()
            try:
                with attached_driver(
                    browser_path=str(store_session.browser_path or "").strip(),
                    debugging_port=int(store_session.debugging_port or 0),
                    core_type=getattr(store_session, "core_type", None),
                    core_version=str(getattr(store_session, "core_version", "") or "").strip(),
                ) as driver:
                    select_first_normal_tab(driver, allow_blank=True)
                    if not check_ip(driver, ip_detection_page):
                        raise RuntimeError("紫鸟 IP 检测失败")
                    open_launcher_page(driver, launcher_page)
            except Exception as exc:
                service.stop_store_session(store_id)
                raise exc

        status = _status_data(service=service)
        return {
            "summary": f"已打开并初始化店铺: {str(store_session.browser_name or store_id).strip()}",
            "verification": {"action": action, "meaningful_change": True},
            "payload": {
                "action": action,
                "store_id": store_id,
                "data": status,
            },
        }

    if action == "get_status":
        status = _status_data(service=service)
        return {
            "summary": _format_status_summary(status),
            "verification": {"action": action, "meaningful_change": False},
            "payload": {
                "action": action,
                "data": status,
            },
        }

    if action == "exit_store":
        store_id = str(arguments.get("store_id") or "").strip()
        with store_lock(store_id):
            service.stop_store_session(store_id)
        if not service.list_running_stores():
            service.close_client()
        status = _status_data(service=service)
        return {
            "summary": f"已退出店铺: {store_id}",
            "verification": {"action": action, "meaningful_change": True},
            "payload": {
                "action": action,
                "store_id": store_id,
                "data": status,
            },
        }

    raise RuntimeError(f"unsupported ziniao_browser action: {action or 'unknown'}")


__all__ = ["dispatch_ziniao_browser"]
