from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterator

from shared.agent_state import ensure_agent_state
from services.browser.store.agent_tool_state import load_tool_state
from services.browser.tools.driver_session import attached_driver, select_first_normal_tab
from services.browser.store.store_session_service import StoreSessionService
from services.browser.store.ziniao_trace import trace_context, trace_event
from services.browser.workflows.amazon_fba_common import WorkflowBrowserSession


def _load_session_state(session_id: str) -> SimpleNamespace | None:
    """Load the session state needed by a one-shot browser CLI."""
    state_data = load_tool_state(session_id)
    if state_data is None:
        return None
    return SimpleNamespace(session_id=session_id, state_data=state_data)


@contextmanager
def browser_session(
    *,
    session_id: str,
    context: dict[str, Any] | None,
    output_dir: str | Path,
) -> Iterator[WorkflowBrowserSession]:
    safe_session_id = str(session_id or "").strip()
    if not safe_session_id:
        raise RuntimeError("缺少 LXE_AGENT_SESSION_ID")

    safe_context = dict(context or {})
    target_store_id = str(safe_context.get("store_id") or "").strip()
    if not target_store_id:
        raise RuntimeError("context 缺少 store_id")

    with trace_context("agent_cli.browser_session", store_id=target_store_id):
        session_state = _load_session_state(safe_session_id)
        if session_state is None:
            raise RuntimeError(f"agent session not found: {safe_session_id}")

        service = StoreSessionService()

        state_data = ensure_agent_state(getattr(session_state, "state_data", {}) or {})
        store_session = service.ensure_store_session(target_store_id)
        try:
            driver_context = attached_driver(
                browser_path=str(store_session.browser_path or "").strip(),
                debugging_port=int(store_session.debugging_port or 0),
                core_type=getattr(store_session, "core_type", None),
                core_version=str(getattr(store_session, "core_version", "") or "").strip(),
            )
            driver = driver_context.__enter__()
        except RuntimeError:
            trace_event("agent_cli.browser_session.restart", store_id=target_store_id)
            store_session = service.ensure_store_session(target_store_id, force_restart=True)
            driver_context = attached_driver(
                browser_path=str(store_session.browser_path or "").strip(),
                debugging_port=int(store_session.debugging_port or 0),
                core_type=getattr(store_session, "core_type", None),
                core_version=str(getattr(store_session, "core_version", "") or "").strip(),
            )
            driver = driver_context.__enter__()
        try:
            select_first_normal_tab(driver)
            yield WorkflowBrowserSession(
                driver=driver,
                state_data=state_data,
                output_dir=Path(output_dir),
                session_id=safe_session_id,
                store_id=str(store_session.browser_oauth or "").strip(),
                store_name=str(store_session.browser_name or "").strip(),
                download_path=str(store_session.download_path or "").strip(),
                browser_path=str(store_session.browser_path or "").strip(),
            )
        finally:
            driver_context.__exit__(None, None, None)


__all__ = ["browser_session"]
