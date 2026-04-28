"""Public synchronous interface for local Ziniao browser session state."""

from __future__ import annotations

from shared.db.sqlite import bootstrap as _sqlite_bootstrap
from shared.db.sqlite import store_sessions as _store_sessions


def init_schema() -> None:
    _sqlite_bootstrap.init_schema()


def load_ziniao_store_session_state(browser_oauth: str, *, host_id: str | None = None):
    return _store_sessions.load_store_session(browser_oauth, host_id=host_id)


def list_ziniao_store_session_states(*, host_id: str | None = None):
    return _store_sessions.list_store_sessions(host_id=host_id)


def upsert_ziniao_store_session_state(
    *,
    browser_oauth: str,
    browser_id: int,
    browser_name: str,
    debugging_port: int,
    download_path: str,
    browser_path: str,
    host_id: str | None = None,
):
    return _store_sessions.upsert_store_session(
        browser_oauth=browser_oauth,
        browser_id=browser_id,
        browser_name=browser_name,
        debugging_port=debugging_port,
        download_path=download_path,
        browser_path=browser_path,
        host_id=host_id,
    )


def delete_ziniao_store_session_state(browser_oauth: str, *, host_id: str | None = None):
    return _store_sessions.delete_store_session(browser_oauth, host_id=host_id)


def clear_ziniao_store_session_states(*, host_id: str | None = None):
    return _store_sessions.clear_store_sessions(host_id=host_id)


__all__ = [
    "clear_ziniao_store_session_states",
    "delete_ziniao_store_session_state",
    "init_schema",
    "list_ziniao_store_session_states",
    "load_ziniao_store_session_state",
    "upsert_ziniao_store_session_state",
]
