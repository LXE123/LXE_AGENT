from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from services.browser.store.store_driver_session import store_driver_session
from services.browser.store.ziniao_trace import trace_context
from services.browser.workflows.amazon_fba_common import WorkflowBrowserSession


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
        with store_driver_session(target_store_id) as (store_session, driver):
            yield WorkflowBrowserSession(
                driver=driver,
                output_dir=Path(output_dir),
                session_id=safe_session_id,
                store_id=str(store_session.browser_oauth or "").strip(),
                store_name=str(store_session.browser_name or "").strip(),
                download_path=str(store_session.download_path or "").strip(),
                browser_path=str(store_session.browser_path or "").strip(),
            )


__all__ = ["browser_session"]
