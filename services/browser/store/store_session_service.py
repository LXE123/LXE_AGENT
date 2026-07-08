from __future__ import annotations

from typing import Any

from shared.db.shared_state_dto import ZiniaoStoreSessionState

from .store_session_map import StoreSessionMap
from .ziniao_browser_client import ZiniaoBrowserClient
from .ziniao_trace import redact_value, trace_event


def _safe_browser_oauth(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        raise RuntimeError("browser_oauth required")
    return text


def _safe_browser_id(value: Any) -> int:
    try:
        safe_value = int(str(value or "").strip())
    except Exception:
        safe_value = 0
    return safe_value if safe_value > 0 else 0


def _catalog_entry(browser: dict[str, Any]) -> dict[str, Any]:
    item = dict(browser or {})
    browser_id = _safe_browser_id(item.get("browserId"))
    browser_oauth = str(item.get("browserOauth") or "").strip()
    browser_name = str(item.get("browserName") or browser_oauth or browser_id or "").strip()
    return {
        "browserOauth": browser_oauth,
        "browserId": browser_id,
        "browserName": browser_name,
    }


def _running_browser_id(entry: dict[str, Any]) -> int:
    item = dict(entry or {})
    for candidate in (item.get("browserId"), item.get("browserOauth")):
        browser_id = _safe_browser_id(candidate)
        if browser_id > 0:
            return browser_id
    return 0


def _running_browser_oauth(entry: dict[str, Any]) -> str:
    return str((entry or {}).get("browserOauth") or "").strip()


class StoreSessionService:
    def __init__(
        self,
        *,
        session_map: StoreSessionMap | None = None,
        browser_client: ZiniaoBrowserClient | None = None,
    ) -> None:
        self._map = session_map or StoreSessionMap()
        self._browser = browser_client or ZiniaoBrowserClient()

    def _browser_catalog(self) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]], dict[str, dict[str, Any]]]:
        entries: list[dict[str, Any]] = []
        by_id: dict[int, dict[str, Any]] = {}
        by_oauth: dict[str, dict[str, Any]] = {}
        for item in self._browser.get_browser_list():
            entry = _catalog_entry(item)
            entries.append(entry)
            browser_id = int(entry["browserId"] or 0)
            browser_oauth = str(entry["browserOauth"] or "").strip()
            if browser_id > 0:
                by_id[browser_id] = entry
            if browser_oauth:
                by_oauth[browser_oauth] = entry
        return entries, by_id, by_oauth

    def _normalized_running_summaries(
        self,
        *,
        catalog_by_id: dict[int, dict[str, Any]],
        catalog_by_oauth: dict[str, dict[str, Any]],
    ) -> list[dict[str, Any]]:
        seen_browser_ids: set[int] = set()
        seen_browser_oauths: set[str] = set()
        summaries: list[dict[str, Any]] = []
        for item in self._browser.get_running_info():
            running_oauth = _running_browser_oauth(item)
            catalog_entry = catalog_by_oauth.get(running_oauth) if running_oauth else None
            browser_id = _safe_browser_id((catalog_entry or {}).get("browserId"))
            if catalog_entry is None:
                browser_id = _running_browser_id(item)
                catalog_entry = catalog_by_id.get(browser_id) if browser_id > 0 else None
            if not catalog_entry:
                trace_event(
                    "session.running.unmatched",
                    level="warning",
                    browser_id=browser_id,
                    has_browser_id=bool(str((item or {}).get("browserId") or "").strip()),
                    has_browser_oauth=bool(running_oauth),
                    running_store=redact_value(running_oauth) if running_oauth else None,
                )
                continue
            browser_oauth = str(catalog_entry.get("browserOauth") or "").strip()
            browser_id = _safe_browser_id(catalog_entry.get("browserId") or browser_id)
            if browser_oauth and browser_oauth in seen_browser_oauths:
                continue
            if browser_id > 0 and browser_id in seen_browser_ids:
                continue
            if browser_oauth:
                seen_browser_oauths.add(browser_oauth)
            if browser_id > 0:
                seen_browser_ids.add(browser_id)
            summaries.append(
                {
                    "browserOauth": browser_oauth,
                    "browserId": browser_id,
                    "browserName": str(catalog_entry.get("browserName") or "").strip(),
                    "running": True,
                }
            )
        return summaries

    def _reconcile_map(self, running_browser_oauths: set[str]) -> None:
        for record in self._map.list_all():
            if str(record.browser_oauth or "").strip() not in running_browser_oauths:
                self._map.delete(record.browser_oauth)

    def _record_from_start(
        self,
        *,
        browser_oauth: str,
        catalog_entry: dict[str, Any] | None,
        start_result: dict[str, Any],
    ) -> ZiniaoStoreSessionState:
        safe_browser_oauth = _safe_browser_oauth(browser_oauth)
        browser_id = _safe_browser_id(
            start_result.get("browserId") or (catalog_entry or {}).get("browserId")
        )
        if browser_id <= 0:
            raise RuntimeError(f"startBrowser 未返回有效 browserId: {safe_browser_oauth}")
        browser_name = str(
            (catalog_entry or {}).get("browserName")
            or start_result.get("browserName")
            or safe_browser_oauth
        ).strip()
        debugging_port = _safe_browser_id(start_result.get("debuggingPort"))
        if debugging_port <= 0:
            raise RuntimeError(f"startBrowser 未返回有效 debuggingPort: {safe_browser_oauth}")
        download_path = str(start_result.get("downloadPath") or "").strip()
        if not download_path:
            raise RuntimeError(f"startBrowser 未返回 downloadPath: {safe_browser_oauth}")
        browser_path = str(start_result.get("browserPath") or "").strip()
        if not browser_path:
            raise RuntimeError(f"startBrowser 未返回 browserPath: {safe_browser_oauth}")
        record = self._map.upsert(
            browser_oauth=safe_browser_oauth,
            browser_id=browser_id,
            browser_name=browser_name,
            debugging_port=debugging_port,
            download_path=download_path,
            browser_path=browser_path,
            core_type=start_result.get("core_type"),
            core_version=str(start_result.get("core_version") or "").strip(),
        )
        trace_event(
            "session.upsert.success",
            store_id=safe_browser_oauth,
            browser_id=browser_id,
            browser_name=browser_name,
            debugging_port=debugging_port,
            download_path=download_path,
            browser_path=browser_path,
            core_type=start_result.get("core_type"),
            core_version=start_result.get("core_version"),
        )
        return record

    def start_store_session(
        self,
        browser_oauth: str,
    ) -> tuple[ZiniaoStoreSessionState, dict[str, Any]]:
        safe_browser_oauth = _safe_browser_oauth(browser_oauth)
        trace_event("session.start.request", store_id=safe_browser_oauth)
        _, _, catalog_by_oauth = self._browser_catalog()
        catalog_entry = catalog_by_oauth.get(safe_browser_oauth)
        if catalog_entry is None:
            trace_event("session.catalog.miss", level="error", store_id=safe_browser_oauth)
            raise RuntimeError(f"目标店铺不存在: {safe_browser_oauth}")
        trace_event(
            "session.catalog.hit",
            store_id=safe_browser_oauth,
            browser_id=catalog_entry.get("browserId"),
            browser_name=catalog_entry.get("browserName"),
        )
        start_result = self._browser.start_browser(safe_browser_oauth)
        record = self._record_from_start(
            browser_oauth=safe_browser_oauth,
            catalog_entry=catalog_entry,
            start_result=start_result,
        )
        trace_event(
            "session.start.success",
            store_id=safe_browser_oauth,
            browser_id=record.browser_id,
            browser_name=record.browser_name,
            debugging_port=record.debugging_port,
            browser_path=record.browser_path,
        )
        return (record, dict(start_result or {}))

    def list_running_stores(self) -> list[dict[str, Any]]:
        status = self.list_store_status()
        return [dict(item or {}) for item in list(status.get("running_stores") or [])]

    def list_store_status(self) -> dict[str, list[dict[str, Any]]]:
        catalog_entries, catalog_by_id, catalog_by_oauth = self._browser_catalog()
        running_stores = self._normalized_running_summaries(
            catalog_by_id=catalog_by_id,
            catalog_by_oauth=catalog_by_oauth,
        )
        self._reconcile_map(
            {
                str(item.get("browserOauth") or "").strip()
                for item in running_stores
                if str(item.get("browserOauth") or "").strip()
            }
        )
        running_browser_ids = {
            int(item.get("browserId") or 0)
            for item in running_stores
            if int(item.get("browserId") or 0) > 0
        }
        running_browser_oauths = {
            str(item.get("browserOauth") or "").strip()
            for item in running_stores
            if str(item.get("browserOauth") or "").strip()
        }
        inactive_stores = [
            {
                "browserOauth": str(item.get("browserOauth") or "").strip(),
                "browserId": int(item.get("browserId") or 0),
                "browserName": str(item.get("browserName") or "").strip(),
            }
            for item in catalog_entries
            if int(item.get("browserId") or 0) > 0
            and int(item.get("browserId") or 0) not in running_browser_ids
            and str(item.get("browserOauth") or "").strip() not in running_browser_oauths
        ]
        return {
            "running_stores": [
                {
                    "browserOauth": str(item.get("browserOauth") or "").strip(),
                    "browserId": int(item.get("browserId") or 0),
                    "browserName": str(item.get("browserName") or "").strip(),
                }
                for item in running_stores
            ],
            "inactive_stores": inactive_stores,
        }

    def ensure_store_session(self, browser_oauth: str, *, force_restart: bool = False) -> ZiniaoStoreSessionState:
        safe_browser_oauth = _safe_browser_oauth(browser_oauth)
        trace_event("session.ensure.request", store_id=safe_browser_oauth, force_restart=force_restart)
        _, catalog_by_id, catalog_by_oauth = self._browser_catalog()
        catalog_entry = catalog_by_oauth.get(safe_browser_oauth)
        if catalog_entry is None:
            trace_event("session.catalog.miss", level="error", store_id=safe_browser_oauth)
            raise RuntimeError(f"目标店铺不存在: {safe_browser_oauth}")
        running_summaries = self._normalized_running_summaries(
            catalog_by_id=catalog_by_id,
            catalog_by_oauth=catalog_by_oauth,
        )
        running_browser_oauths = {
            str(item.get("browserOauth") or "").strip()
            for item in running_summaries
            if str(item.get("browserOauth") or "").strip()
        }
        self._reconcile_map(running_browser_oauths)

        if not force_restart and safe_browser_oauth in running_browser_oauths:
            existing = self._map.get(safe_browser_oauth)
            if existing is not None:
                trace_event(
                    "session.ensure.reuse",
                    store_id=safe_browser_oauth,
                    browser_id=existing.browser_id,
                    debugging_port=existing.debugging_port,
                    browser_path=existing.browser_path,
                )
                return existing

        record = self._record_from_start(
            browser_oauth=safe_browser_oauth,
            catalog_entry=catalog_entry,
            start_result=self._browser.start_browser(safe_browser_oauth),
        )
        trace_event(
            "session.ensure.started",
            store_id=safe_browser_oauth,
            force_restart=force_restart,
            browser_id=record.browser_id,
            debugging_port=record.debugging_port,
            browser_path=record.browser_path,
        )
        return record

    def stop_store_session(self, browser_oauth: str) -> bool:
        safe_browser_oauth = _safe_browser_oauth(browser_oauth)
        trace_event("session.stop.request", store_id=safe_browser_oauth)
        try:
            self._browser.stop_browser(safe_browser_oauth)
        finally:
            deleted = self._map.delete(safe_browser_oauth)
            trace_event("session.stop.cleanup", store_id=safe_browser_oauth, deleted=deleted)
        return deleted

    def close_client(self) -> int:
        self._browser.close_client()
        cleared = self._map.clear()
        trace_event("session.client.close", cleared_sessions=cleared)
        return cleared


__all__ = ["StoreSessionService"]
