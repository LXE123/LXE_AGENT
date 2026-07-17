from __future__ import annotations

from contextlib import contextmanager
from hashlib import sha256
from pathlib import Path
from typing import Any, Iterator

from shared.process_lock import interprocess_lock
from shared.workspace import internal_root

from services.browser.store.store_session_service import StoreSessionService
from services.browser.store.ziniao_trace import trace_event
from services.browser.tools.driver_session import attached_driver, select_first_normal_tab


def _store_lock_path(store_id: str) -> Path:
    digest = sha256(str(store_id or "").encode("utf-8")).hexdigest()[:24]
    return internal_root() / "var" / "tmp" / "lxeskill" / f"store-{digest}.lock"


@contextmanager
def store_lock(store_id: str, *, timeout_seconds: float = 180.0) -> Iterator[None]:
    """Serialize store browser mutations across processes and agent sessions."""
    with interprocess_lock(_store_lock_path(store_id), timeout_seconds=timeout_seconds):
        yield


def _attach(store_session: Any):
    return attached_driver(
        browser_path=str(store_session.browser_path or "").strip(),
        debugging_port=int(store_session.debugging_port or 0),
        core_type=getattr(store_session, "core_type", None),
        core_version=str(getattr(store_session, "core_version", "") or "").strip(),
    )


@contextmanager
def store_driver_session(
    store_id: str,
    *,
    lock_timeout_seconds: float = 180.0,
) -> Iterator[tuple[Any, Any]]:
    """Attach a Selenium driver to the store browser, holding the store lock.

    Yields ``(store_session, driver)``. When attaching to a supposedly running
    browser fails, the store browser is restarted once before giving up.
    """
    safe_store_id = str(store_id or "").strip()
    if not safe_store_id:
        raise RuntimeError("store_driver_session requires store_id")
    with store_lock(safe_store_id, timeout_seconds=lock_timeout_seconds):
        service = StoreSessionService()
        store_session = service.ensure_store_session(safe_store_id)
        try:
            driver_context = _attach(store_session)
            driver = driver_context.__enter__()
        except RuntimeError:
            trace_event("store_driver.restart", store_id=safe_store_id)
            store_session = service.ensure_store_session(safe_store_id, force_restart=True)
            driver_context = _attach(store_session)
            driver = driver_context.__enter__()
        try:
            select_first_normal_tab(driver)
            yield store_session, driver
        finally:
            driver_context.__exit__(None, None, None)


__all__ = ["store_driver_session", "store_lock"]
