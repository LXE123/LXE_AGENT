from __future__ import annotations

from shared.db import store_sessions_client as shared_state_client


class StoreSessionMap:
    def __init__(self, *, host_id: str | None = None):
        self._host_id = str(host_id or "").strip() or None

    def get(self, browser_oauth: str):
        return shared_state_client.load_ziniao_store_session_state(
            str(browser_oauth or "").strip(),
            host_id=self._host_id,
        )

    def upsert(
        self,
        *,
        browser_oauth: str,
        browser_id: int,
        browser_name: str,
        debugging_port: int,
        download_path: str,
        browser_path: str,
    ):
        return shared_state_client.upsert_ziniao_store_session_state(
            browser_oauth=str(browser_oauth or "").strip(),
            browser_id=int(browser_id or 0),
            browser_name=str(browser_name or "").strip(),
            debugging_port=int(debugging_port or 0),
            download_path=str(download_path or "").strip(),
            browser_path=str(browser_path or "").strip(),
            host_id=self._host_id,
        )

    def delete(self, browser_oauth: str) -> bool:
        return bool(
            shared_state_client.delete_ziniao_store_session_state(
                str(browser_oauth or "").strip(),
                host_id=self._host_id,
            )
        )

    def list_all(self):
        return list(shared_state_client.list_ziniao_store_session_states(host_id=self._host_id) or [])

    def clear(self) -> int:
        return int(shared_state_client.clear_ziniao_store_session_states(host_id=self._host_id) or 0)


__all__ = ["StoreSessionMap"]
