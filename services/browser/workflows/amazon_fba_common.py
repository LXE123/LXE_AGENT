from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable

from services.browser.browser.actions import execute_browser_action
from services.browser.browser.snapshot import build_page_snapshot


def workflow_output_dir(session_id: str) -> Path:
    return (
        Path(__file__).resolve().parents[3]
        / "services"
        / "browser"
        / "artifacts"
        / "workflows"
        / str(session_id or "unknown")
    )


class WorkflowBrowserSession:
    def __init__(
        self,
        *,
        driver: Any,
        state_data: dict[str, Any],
        output_dir: Path,
        session_id: str = "",
        store_id: str = "",
        store_name: str = "",
        download_path: str = "",
        browser_path: str = "",
    ):
        self.driver = driver
        self.state_data = dict(state_data or {})
        self.output_dir = Path(output_dir)
        self.session_id = str(session_id or "").strip()
        self.store_id = str(store_id or "").strip()
        self.store_name = str(store_name or "").strip()
        self.download_path = str(download_path or "").strip()
        self.browser_path = str(browser_path or "").strip()

    def snapshot(self, *, text_limit: int = 4000, element_limit: int = 80) -> dict[str, Any]:
        return build_page_snapshot(self.driver, text_limit=int(text_limit), element_limit=int(element_limit))

    def execute_action(self, action: dict[str, Any]) -> dict[str, Any]:
        before_snapshot = self.snapshot(text_limit=4000, element_limit=80)
        payload = execute_browser_action(
            self.driver,
            dict(action or {}),
            download_path=self.download_path,
            output_dir=self.output_dir,
            before_snapshot=before_snapshot,
        )
        if not payload.get("after_snapshot"):
            payload["after_snapshot"] = before_snapshot
        return payload

    def open_url(self, url: str) -> dict[str, Any]:
        return self.execute_action({"action": "open_url", "url": str(url or "").strip()})

    def wait_for_snapshot(
        self,
        predicate: Callable[[dict[str, Any]], bool],
        *,
        timeout_seconds: int,
        description: str,
        interval_seconds: float = 1.0,
        text_limit: int = 4000,
    ) -> dict[str, Any]:
        deadline = time.time() + max(1, int(timeout_seconds or 0))
        while time.time() < deadline:
            snapshot = self.snapshot(text_limit=text_limit)
            if bool(predicate(snapshot)):
                return snapshot
            time.sleep(max(0.2, float(interval_seconds or 1.0)))
        raise RuntimeError(f"{description} 超时")


def resolve_workflow_session(
    *,
    session: WorkflowBrowserSession | None = None,
    runtime: Any = None,
) -> WorkflowBrowserSession:
    if session is not None:
        return session
    _ = runtime
    raise RuntimeError("missing workflow session")


def selected_store(source: WorkflowBrowserSession | dict[str, Any] | None) -> dict[str, str]:
    if isinstance(source, WorkflowBrowserSession):
        return {
            "store_id": str(source.store_id or "").strip(),
            "store_name": str(source.store_name or "").strip(),
        }
    data = dict(source or {})
    return {
        "store_id": str(data.get("store_id") or "").strip(),
        "store_name": str(data.get("store_name") or "").strip(),
    }


def workflow_context(
    *,
    session: WorkflowBrowserSession | None = None,
    store_id: str = "",
    store_name: str = "",
    site: str = "",
    consignment_no: str = "",
    transport_mode: str = "",
) -> dict[str, str]:
    selected = selected_store(session) if session is not None else {
        "store_id": str(store_id or "").strip(),
        "store_name": str(store_name or "").strip(),
    }
    return {
        "store_id": str(selected.get("store_id") or "").strip(),
        "store_name": str(selected.get("store_name") or "").strip(),
        "site": str(site or "").strip(),
        "consignment_no": str(consignment_no or "").strip(),
        "transport_mode": str(transport_mode or "").strip(),
    }


def merge_workflow_contexts(*contexts: object) -> dict[str, str]:
    merged = workflow_context()
    for item in contexts:
        data = dict(item or {})
        for key in merged:
            value = str(data.get(key) or "").strip()
            if value:
                merged[key] = value
    return merged


def workflow_result(
    *,
    params_ready: bool,
    finished: bool,
    exception: str = "",
    notice: str = "",
    file_path: list[dict[str, str]] | None = None,
    context: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        "params_ready": bool(params_ready),
        "finished": bool(finished),
        "exception": str(exception or "").strip(),
        "notice": str(notice or "").strip(),
        "file_path": list(file_path or []),
        "context": merge_workflow_contexts(context),
    }


def not_ready_result(
    *,
    context: dict[str, str] | None = None,
    exception: str = "",
) -> dict[str, Any]:
    return workflow_result(
        params_ready=False,
        finished=False,
        exception=exception,
        context=context,
    )


def exception_text(exc: Exception) -> str:
    message = str(exc).strip()
    return message or exc.__class__.__name__


def file_path_entries(*items: tuple[str, object]) -> list[dict[str, str]]:
    entries: list[dict[str, str]] = []
    for key, value in items:
        path = str(value or "").strip()
        if path:
            entries.append({"key": str(key or "").strip(), "value": path})
    return entries


__all__ = [
    "WorkflowBrowserSession",
    "exception_text",
    "file_path_entries",
    "merge_workflow_contexts",
    "not_ready_result",
    "resolve_workflow_session",
    "selected_store",
    "workflow_context",
    "workflow_output_dir",
    "workflow_result",
]
