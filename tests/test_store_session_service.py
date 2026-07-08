from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from shared.db.shared_state_dto import ZiniaoStoreSessionState
from services.browser.store.store_session_service import StoreSessionService


OPAQUE_STORE_ID = "imjUiB8rg/2uP9OIOP2uFw=="
NUMERIC_BROWSER_ID = 16521508083313


def _state(
    *,
    browser_oauth: str = OPAQUE_STORE_ID,
    browser_id: int = NUMERIC_BROWSER_ID,
    debugging_port: int = 8210,
) -> ZiniaoStoreSessionState:
    now = datetime.now(timezone.utc)
    return ZiniaoStoreSessionState(
        host_id="test-host",
        browser_oauth=browser_oauth,
        browser_id=browser_id,
        browser_name="Amazon-HSP-US",
        debugging_port=debugging_port,
        download_path="/tmp/ziniao/downloads",
        browser_path="/tmp/ziniao/browser",
        core_type=0,
        core_version="138.1.2.80",
        created_at=now,
        updated_at=now,
    )


class FakeStoreSessionMap:
    def __init__(self, records: list[ZiniaoStoreSessionState] | None = None) -> None:
        self.records = {record.browser_oauth: record for record in list(records or [])}
        self.deleted: list[str] = []

    def get(self, browser_oauth: str):
        return self.records.get(str(browser_oauth or "").strip())

    def upsert(
        self,
        *,
        browser_oauth: str,
        browser_id: int,
        browser_name: str,
        debugging_port: int,
        download_path: str,
        browser_path: str,
        core_type: Any = None,
        core_version: str = "",
    ):
        record = ZiniaoStoreSessionState(
            host_id="test-host",
            browser_oauth=browser_oauth,
            browser_id=browser_id,
            browser_name=browser_name,
            debugging_port=debugging_port,
            download_path=download_path,
            browser_path=browser_path,
            core_type=core_type,
            core_version=core_version,
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        self.records[browser_oauth] = record
        return record

    def delete(self, browser_oauth: str) -> bool:
        safe_browser_oauth = str(browser_oauth or "").strip()
        self.deleted.append(safe_browser_oauth)
        return self.records.pop(safe_browser_oauth, None) is not None

    def list_all(self):
        return list(self.records.values())


class FakeBrowserClient:
    def __init__(
        self,
        *,
        browser_list: list[dict[str, Any]],
        running_info: list[dict[str, Any]],
    ) -> None:
        self.browser_list = list(browser_list)
        self.running_info = list(running_info)
        self.calls: list[tuple[str, str | None]] = []

    def get_browser_list(self):
        self.calls.append(("get_browser_list", None))
        return [dict(item) for item in self.browser_list]

    def get_running_info(self):
        self.calls.append(("get_running_info", None))
        return [dict(item) for item in self.running_info]

    def start_browser(self, browser_oauth: str):
        self.calls.append(("start_browser", browser_oauth))
        return {
            "browserOauth": browser_oauth,
            "browserId": NUMERIC_BROWSER_ID,
            "browserName": "Amazon-HSP-US",
            "debuggingPort": 9300,
            "downloadPath": "/tmp/ziniao/downloads",
            "browserPath": "/tmp/ziniao/browser",
            "core_type": 0,
            "core_version": "138.1.2.80",
        }


def _catalog_entry() -> dict[str, Any]:
    return {
        "browserOauth": OPAQUE_STORE_ID,
        "browserId": str(NUMERIC_BROWSER_ID),
        "browserName": "Amazon-HSP-US",
    }


def test_list_store_status_matches_running_store_by_opaque_browser_oauth() -> None:
    browser = FakeBrowserClient(
        browser_list=[_catalog_entry()],
        running_info=[
            {
                "browserOauth": OPAQUE_STORE_ID,
                "debuggingPort": 8210,
                "downloadPath": "/tmp/ziniao/downloads",
                "browserPath": "/tmp/ziniao/browser",
            }
        ],
    )
    service = StoreSessionService(session_map=FakeStoreSessionMap(), browser_client=browser)

    status = service.list_store_status()

    assert status["running_stores"] == [
        {
            "browserOauth": OPAQUE_STORE_ID,
            "browserId": NUMERIC_BROWSER_ID,
            "browserName": "Amazon-HSP-US",
        }
    ]
    assert status["inactive_stores"] == []


def test_ensure_store_session_reuses_existing_record_for_opaque_running_oauth() -> None:
    existing = _state()
    session_map = FakeStoreSessionMap([existing])
    browser = FakeBrowserClient(
        browser_list=[_catalog_entry()],
        running_info=[{"browserOauth": OPAQUE_STORE_ID}],
    )
    service = StoreSessionService(session_map=session_map, browser_client=browser)

    record = service.ensure_store_session(OPAQUE_STORE_ID)

    assert record is existing
    assert ("start_browser", OPAQUE_STORE_ID) not in browser.calls
    assert session_map.deleted == []


def test_list_store_status_still_matches_running_store_by_numeric_browser_id() -> None:
    browser = FakeBrowserClient(
        browser_list=[_catalog_entry()],
        running_info=[{"browserId": str(NUMERIC_BROWSER_ID)}],
    )
    service = StoreSessionService(session_map=FakeStoreSessionMap(), browser_client=browser)

    status = service.list_store_status()

    assert status["running_stores"] == [
        {
            "browserOauth": OPAQUE_STORE_ID,
            "browserId": NUMERIC_BROWSER_ID,
            "browserName": "Amazon-HSP-US",
        }
    ]
    assert status["inactive_stores"] == []


def test_list_store_status_skips_running_info_that_is_not_in_catalog() -> None:
    browser = FakeBrowserClient(
        browser_list=[_catalog_entry()],
        running_info=[{"browserOauth": "unknown-running-oauth"}],
    )
    service = StoreSessionService(session_map=FakeStoreSessionMap(), browser_client=browser)

    status = service.list_store_status()

    assert status["running_stores"] == []
    assert status["inactive_stores"] == [
        {
            "browserOauth": OPAQUE_STORE_ID,
            "browserId": NUMERIC_BROWSER_ID,
            "browserName": "Amazon-HSP-US",
        }
    ]
