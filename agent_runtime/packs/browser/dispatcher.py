from __future__ import annotations

from typing import Any

from agent_runtime.packs.browser.driver_session import (
    attached_driver,
    check_ip,
    open_launcher_page,
    select_first_normal_tab,
)
from services.browser.store.store_session_service import StoreSessionService
from services.browser.store.ziniao_browser_client import ZiniaoBrowserClient
from services.browser.store.ziniao_lifecycle import ZiniaoLifecycleManager


def _store_session_service() -> StoreSessionService:
    return StoreSessionService()


def _client_running() -> bool:
    client = ZiniaoBrowserClient()
    return ZiniaoLifecycleManager.resolve_client_pid(client.control_port) > 0


def _snapshot_ref_entries(snapshot: dict[str, Any]) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    seen_refs: set[str] = set()
    for raw_item in list(snapshot.get("sendtoamazon_controls") or []) + list(snapshot.get("interactive_elements") or []):
        item = dict(raw_item or {})
        ref = str(item.get("aid") or "").strip()
        if not ref or ref in seen_refs:
            continue
        seen_refs.add(ref)
        label = (
            str(item.get("text") or "")
            or str(item.get("aria_label") or "")
            or str(item.get("placeholder") or "")
            or str(item.get("data_testid") or "")
            or str(item.get("name") or "")
            or str(item.get("id") or "")
            or str(item.get("tag") or "")
        ).strip()
        entries.append(
            {
                "ref": ref,
                "tag": str(item.get("tag") or "").strip().lower(),
                "label": " ".join(label.split())[:160],
            }
        )
    return entries


def _format_snapshot_summary(snapshot: dict[str, Any], *, full: bool) -> str:
    safe_snapshot = dict(snapshot or {})
    refs = _snapshot_ref_entries(safe_snapshot)
    lines = [
        "## Browser Snapshot",
        "",
        f"Title: {str(safe_snapshot.get('title') or '').strip() or '-'}",
        f"URL: {str(safe_snapshot.get('url') or '').strip() or '-'}",
        "",
        "Interactive refs:",
    ]
    if not refs:
        lines.append("- (no interactive refs found)")
    else:
        limit = 80 if full else 30
        for item in refs[:limit]:
            tag = str(item.get("tag") or "").strip() or "element"
            label = str(item.get("label") or "").strip() or "unnamed"
            lines.append(f"- ref={item['ref']} | {tag} | {label}")
        if len(refs) > limit:
            lines.append(f"- ... truncated, total refs={len(refs)}")

    if full:
        headings = [str(item).strip() for item in list(safe_snapshot.get("headings") or []) if str(item).strip()]
        text_lines = [str(item).strip() for item in list(safe_snapshot.get("text_lines") or []) if str(item).strip()]
        if headings:
            lines.extend(["", "Headings:"])
            lines.extend(f"- {item}" for item in headings[:12])
        if text_lines:
            lines.extend(["", "Visible text:"])
            lines.extend(f"- {item}" for item in text_lines[:20])

    return "\n".join(lines).strip()


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


def _validate_ref(snapshot: dict[str, Any], ref: str) -> str:
    safe_ref = str(ref or "").strip()
    if not safe_ref:
        raise RuntimeError("missing ref")
    valid_refs = {str(item.get("ref") or "").strip() for item in _snapshot_ref_entries(snapshot)}
    if safe_ref not in valid_refs:
        raise RuntimeError(f"invalid ref: {safe_ref}")
    return safe_ref


def dispatch_ziniao_browser(runtime: Any, arguments: dict[str, Any], *, output_dir) -> dict[str, Any]:
    _ = output_dir
    _ = runtime
    action = str(arguments.get("action") or "").strip().lower()
    service = _store_session_service()

    if action == "open_store":
        store_id = str(arguments.get("store_id") or "").strip()
        store_session, start_result = service.start_store_session(store_id)
        ip_detection_page = str(start_result.get("ipDetectionPage") or "").strip()
        launcher_page = str(start_result.get("launcherPage") or "").strip()
        try:
            with attached_driver(
                browser_path=str(store_session.browser_path or "").strip(),
                debugging_port=int(store_session.debugging_port or 0),
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
            "after_snapshot": {},
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
            "after_snapshot": {},
            "payload": {
                "action": action,
                "data": status,
            },
        }

    if action == "exit_store":
        store_id = str(arguments.get("store_id") or "").strip()
        service.stop_store_session(store_id)
        if not service.list_running_stores():
            service.close_client()
        status = _status_data(service=service)
        return {
            "summary": f"已退出店铺: {store_id}",
            "verification": {"action": action, "meaningful_change": True},
            "after_snapshot": {},
            "payload": {
                "action": action,
                "store_id": store_id,
                "data": status,
            },
        }

    raise RuntimeError(f"unsupported ziniao_browser action: {action or 'unknown'}")


def dispatch_ziniao_page(
    session: Any,
    arguments: dict[str, Any],
    *,
    output_dir,
    before_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    _ = output_dir
    action = str(arguments.get("action") or "").strip().lower()
    store_id = str(arguments.get("store_id") or "").strip()
    snapshot_before = dict(before_snapshot or {})
    if not snapshot_before:
        snapshot_before = session.snapshot()

    if action == "browser_snapshot":
        full = bool(arguments.get("full"))
        snapshot = session.snapshot(
            text_limit=8000 if full else 4000,
            element_limit=200 if full else 80,
        )
        refs = _snapshot_ref_entries(snapshot)
        return {
            "summary": _format_snapshot_summary(snapshot, full=full),
            "verification": {"action": action, "meaningful_change": False},
            "after_snapshot": snapshot,
            "payload": {
                "action": action,
                "store_id": store_id,
                "full": full,
                "refs": refs,
            },
        }

    if action == "browser_vision":
        payload = session.execute_action({"action": "screenshot"})
        payload["summary"] = "已获取当前页面截图。"
        payload["payload"] = {
            "action": action,
            "store_id": store_id,
        }
        return payload

    if action == "browser_navigate":
        url = str(arguments.get("url") or "").strip()
        payload = session.open_url(url)
        payload["payload"] = {
            "action": action,
            "store_id": store_id,
            "url": url,
        }
        return payload

    if action == "browser_click":
        ref = _validate_ref(snapshot_before, str(arguments.get("ref") or "").strip())
        payload = session.execute_action({"action": "click", "aid": ref})
        payload["payload"] = {
            "action": action,
            "store_id": store_id,
            "ref": ref,
        }
        return payload

    if action == "browser_type":
        ref = _validate_ref(snapshot_before, str(arguments.get("ref") or "").strip())
        payload = session.execute_action(
            {
                "action": "type",
                "aid": ref,
                "text": str(arguments.get("text") or ""),
            }
        )
        payload["payload"] = {
            "action": action,
            "store_id": store_id,
            "ref": ref,
        }
        return payload

    if action == "browser_scroll":
        payload = session.execute_action(
            {
                "action": "scroll",
                "direction": str(arguments.get("direction") or "down").strip().lower(),
                "pixels": int(arguments.get("pixels") or 800),
            }
        )
        payload["payload"] = {
            "action": action,
            "store_id": store_id,
        }
        return payload

    raise RuntimeError(f"unsupported ziniao_page action: {action or 'unknown'}")


__all__ = [
    "dispatch_ziniao_browser",
    "dispatch_ziniao_page",
]
