from __future__ import annotations

from types import SimpleNamespace

from agent_runtime.packs.browser import dispatcher, executor
from services.agent_cli._shared import browser_session as browser_session_module


class _DriverContext:
    def __init__(self, driver: object, calls: list[tuple]) -> None:
        self._driver = driver
        self._calls = calls

    def __enter__(self):
        self._calls.append(("driver_enter",))
        return self._driver

    def __exit__(self, exc_type, exc, tb):
        self._calls.append(("driver_exit",))
        return False


class _FakeStoreSessionService:
    def __init__(self, store_session: object, calls: list[tuple]) -> None:
        self._store_session = store_session
        self._calls = calls

    def ensure_store_session(self, store_id: str, *, force_restart: bool = False):
        self._calls.append(("ensure_store_session", store_id, force_restart))
        return self._store_session

    def start_store_session(self, store_id: str):
        self._calls.append(("start_store_session", store_id))
        return (
            self._store_session,
            {
                "ipDetectionPage": "https://ip-check.test",
                "launcherPage": "https://sellercentral.amazon.com",
            },
        )

    def stop_store_session(self, store_id: str) -> bool:
        self._calls.append(("stop_store_session", store_id))
        return True

    def list_store_status(self) -> dict[str, list[dict]]:
        return {"running_stores": [], "inactive_stores": []}


def _store_session() -> SimpleNamespace:
    return SimpleNamespace(
        browser_path="D:\\RPA\\browser",
        debugging_port=16851,
        browser_oauth="store-1",
        browser_name="Amazon-YRZ",
        download_path="D:\\RPA\\downloads",
    )


def test_ziniao_page_session_selects_first_normal_tab(monkeypatch, tmp_path) -> None:
    calls: list[tuple] = []
    driver = object()
    service = _FakeStoreSessionService(_store_session(), calls)
    runtime = SimpleNamespace(state_data={}, session_id="session-1")

    monkeypatch.setattr(executor, "StoreSessionService", lambda: service)
    monkeypatch.setattr(
        executor,
        "attached_driver",
        lambda **kwargs: calls.append(("attached_driver", kwargs)) or _DriverContext(driver, calls),
    )
    monkeypatch.setattr(
        executor,
        "select_first_normal_tab",
        lambda selected_driver, **kwargs: calls.append(("select_first_normal_tab", selected_driver, kwargs)),
    )

    with executor._page_workflow_session(runtime, store_id="store-1", output_dir=tmp_path) as session:
        assert session.driver is driver

    assert ("select_first_normal_tab", driver, {}) in calls


def test_fba_cli_browser_session_selects_first_normal_tab(monkeypatch, tmp_path) -> None:
    calls: list[tuple] = []
    driver = object()
    service = _FakeStoreSessionService(_store_session(), calls)

    monkeypatch.setattr(browser_session_module, "StoreSessionService", lambda: service)
    monkeypatch.setattr(
        browser_session_module.shared_state_client,
        "load_agent_session_state",
        lambda session_id: SimpleNamespace(state_data={}),
    )
    monkeypatch.setattr(
        browser_session_module,
        "attached_driver",
        lambda **kwargs: calls.append(("attached_driver", kwargs)) or _DriverContext(driver, calls),
    )
    monkeypatch.setattr(
        browser_session_module,
        "select_first_normal_tab",
        lambda selected_driver, **kwargs: calls.append(("select_first_normal_tab", selected_driver, kwargs)),
    )

    with browser_session_module.browser_session(
        session_id="session-1",
        context={"store_id": "store-1"},
        output_dir=tmp_path,
    ) as session:
        assert session.driver is driver

    assert ("select_first_normal_tab", driver, {}) in calls


def test_open_store_selects_blank_capable_tab_before_ip_check(monkeypatch, tmp_path) -> None:
    calls: list[tuple] = []
    driver = object()
    service = _FakeStoreSessionService(_store_session(), calls)

    monkeypatch.setattr(dispatcher, "_store_session_service", lambda: service)
    monkeypatch.setattr(dispatcher, "_client_running", lambda: True)
    monkeypatch.setattr(
        dispatcher,
        "attached_driver",
        lambda **kwargs: calls.append(("attached_driver", kwargs)) or _DriverContext(driver, calls),
    )
    monkeypatch.setattr(
        dispatcher,
        "select_first_normal_tab",
        lambda selected_driver, **kwargs: calls.append(("select_first_normal_tab", selected_driver, kwargs)),
    )
    monkeypatch.setattr(
        dispatcher,
        "check_ip",
        lambda selected_driver, url: calls.append(("check_ip", selected_driver, url)) or True,
    )
    monkeypatch.setattr(
        dispatcher,
        "open_launcher_page",
        lambda selected_driver, url: calls.append(("open_launcher_page", selected_driver, url)) or url,
    )

    dispatcher.dispatch_ziniao_browser(None, {"action": "open_store", "store_id": "store-1"}, output_dir=tmp_path)

    assert calls.index(("select_first_normal_tab", driver, {"allow_blank": True})) < calls.index(
        ("check_ip", driver, "https://ip-check.test")
    )
