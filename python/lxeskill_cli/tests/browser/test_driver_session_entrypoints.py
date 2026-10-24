from __future__ import annotations

from types import SimpleNamespace

import pytest

from services.agent_cli._shared import browser_session as browser_session_module
from services.browser.store import store_driver_session as store_driver_session_module
from services.browser.tools import dispatcher, driver_session, executor
from shared.process_lock import InterProcessLockTimeout


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

    def ensure_store_session(
        self,
        store_id: str,
        *,
        force_restart: bool = False,
        start_if_missing: bool = True,
    ):
        if start_if_missing:
            self._calls.append(("ensure_store_session", store_id, force_restart))
        else:
            self._calls.append(("ensure_store_session", store_id, force_restart, start_if_missing))
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
        core_type=0,
        core_version="138.1.2.80",
    )


def _patch_store_driver_session(monkeypatch, tmp_path, service, driver, calls) -> None:
    monkeypatch.setattr(store_driver_session_module, "state_root", lambda: tmp_path)
    monkeypatch.setattr(store_driver_session_module, "StoreSessionService", lambda: service)
    monkeypatch.setattr(
        store_driver_session_module,
        "attached_driver",
        lambda **kwargs: calls.append(("attached_driver", kwargs)) or _DriverContext(driver, calls),
    )
    monkeypatch.setattr(
        store_driver_session_module,
        "select_first_normal_tab",
        lambda selected_driver, **kwargs: calls.append(("select_first_normal_tab", selected_driver, kwargs)),
    )


def test_ziniao_page_session_selects_first_normal_tab(monkeypatch, tmp_path) -> None:
    calls: list[tuple] = []
    driver = object()
    service = _FakeStoreSessionService(_store_session(), calls)
    runtime = SimpleNamespace(session_id="session-1")

    _patch_store_driver_session(monkeypatch, tmp_path, service, driver, calls)

    with executor._page_workflow_session(runtime, store_id="store-1", output_dir=tmp_path) as session:
        assert session.driver is driver

    assert ("select_first_normal_tab", driver, {}) in calls


def test_ziniao_page_session_forwards_strict_attach_and_target_host(monkeypatch, tmp_path) -> None:
    calls: list[tuple] = []
    driver = object()

    class FakeDriverSession:
        def __enter__(self):
            return _store_session(), driver

        def __exit__(self, exc_type, exc, tb):
            return False

    def fake_store_driver_session(store_id: str, **kwargs):
        calls.append((store_id, kwargs))
        return FakeDriverSession()

    monkeypatch.setattr(executor, "store_driver_session", fake_store_driver_session)

    with executor._page_workflow_session(
        SimpleNamespace(session_id="session-1"),
        store_id="store-1",
        output_dir=tmp_path,
        strict_attach=True,
        target_host="wsaexp.nextsls.com",
    ) as session:
        assert session.driver is driver

    assert calls == [
        ("store-1", {"strict_attach": True, "target_host": "wsaexp.nextsls.com"})
    ]


def test_page_and_store_session_forward_explicit_handle_without_starting(monkeypatch, tmp_path):
    calls = []
    driver = object()
    service = _FakeStoreSessionService(_store_session(), calls)
    _patch_store_driver_session(monkeypatch, tmp_path, service, driver, calls)
    monkeypatch.setattr(store_driver_session_module, "select_unique_host_tab",
        lambda selected_driver, host, **kwargs: calls.append(("select", selected_driver, host, kwargs)))

    with executor._page_workflow_session(SimpleNamespace(session_id="test"), store_id="store-1",
            output_dir=tmp_path, strict_attach=True, target_host="ttaiex.nextsls.com", target_handle="account-b") as session:
        assert session.driver is driver
    assert ("select", driver, "ttaiex.nextsls.com", {"target_handle": "account-b"}) in calls
    assert ("ensure_store_session", "store-1", False, False) in calls
    assert not any(call[0] == "select_first_normal_tab" for call in calls)


def test_fba_cli_browser_session_selects_first_normal_tab(monkeypatch, tmp_path) -> None:
    calls: list[tuple] = []
    driver = object()
    service = _FakeStoreSessionService(_store_session(), calls)

    _patch_store_driver_session(monkeypatch, tmp_path, service, driver, calls)

    with browser_session_module.browser_session(
        session_id="session-1",
        context={"store_id": "store-1"},
        output_dir=tmp_path,
    ) as session:
        assert session.driver is driver

    assert ("select_first_normal_tab", driver, {}) in calls


def test_fba_cli_browser_session_passes_core_fields_to_attached_driver(monkeypatch, tmp_path) -> None:
    calls: list[tuple] = []
    driver = object()
    service = _FakeStoreSessionService(_store_session(), calls)

    _patch_store_driver_session(monkeypatch, tmp_path, service, driver, calls)

    with browser_session_module.browser_session(
        session_id="session-1",
        context={"store_id": "store-1"},
        output_dir=tmp_path,
    ):
        pass

    assert (
        "attached_driver",
        {
            "browser_path": "D:\\RPA\\browser",
            "debugging_port": 16851,
            "core_type": 0,
            "core_version": "138.1.2.80",
        },
    ) in calls


def test_store_driver_session_restarts_store_when_attach_fails(monkeypatch, tmp_path) -> None:
    calls: list[tuple] = []
    driver = object()
    service = _FakeStoreSessionService(_store_session(), calls)
    attempts: list[int] = []

    def flaky_attached_driver(**kwargs):
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("无法连接当前紫鸟浏览器，请重新打开店铺")
        calls.append(("attached_driver", kwargs))
        return _DriverContext(driver, calls)

    monkeypatch.setattr(store_driver_session_module, "state_root", lambda: tmp_path)
    monkeypatch.setattr(store_driver_session_module, "StoreSessionService", lambda: service)
    monkeypatch.setattr(store_driver_session_module, "attached_driver", flaky_attached_driver)
    monkeypatch.setattr(store_driver_session_module, "select_first_normal_tab", lambda selected_driver, **kwargs: None)

    with store_driver_session_module.store_driver_session("store-1") as (store_session, attached):
        assert attached is driver

    assert ("ensure_store_session", "store-1", False) in calls
    assert ("ensure_store_session", "store-1", True) in calls


def test_store_driver_session_strict_attach_fails_without_start_or_restart(monkeypatch, tmp_path) -> None:
    calls: list[tuple] = []
    service = _FakeStoreSessionService(_store_session(), calls)

    def failing_attached_driver(**kwargs):
        calls.append(("attached_driver", kwargs))
        raise RuntimeError("配对 chromedriver 附着失败")

    monkeypatch.setattr(store_driver_session_module, "state_root", lambda: tmp_path)
    monkeypatch.setattr(store_driver_session_module, "StoreSessionService", lambda: service)
    monkeypatch.setattr(store_driver_session_module, "attached_driver", failing_attached_driver)

    with pytest.raises(RuntimeError, match="配对 chromedriver 附着失败"):
        with store_driver_session_module.store_driver_session("store-1", strict_attach=True):
            pass

    assert calls[0] == ("ensure_store_session", "store-1", False, False)
    assert not any(call[:3] == ("ensure_store_session", "store-1", True) for call in calls)


def test_executor_reports_store_busy_when_store_lock_times_out(monkeypatch, tmp_path) -> None:
    def busy_lock(path, **kwargs):
        raise InterProcessLockTimeout("timed out waiting for lock")

    monkeypatch.setattr(store_driver_session_module, "state_root", lambda: tmp_path)
    monkeypatch.setattr(store_driver_session_module, "interprocess_lock", busy_lock)

    result = executor.execute_browser_tool(
        SimpleNamespace(session_id="session-1"),
        tool_name="ziniao_page",
        arguments={"action": "browser_snapshot", "store_id": "store-1"},
    )

    assert result.success is False
    assert result.error_code == "store_busy"


def test_open_store_selects_blank_capable_tab_before_ip_check(monkeypatch, tmp_path) -> None:
    calls: list[tuple] = []
    driver = object()
    service = _FakeStoreSessionService(_store_session(), calls)

    monkeypatch.setattr(store_driver_session_module, "state_root", lambda: tmp_path)
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


def test_attached_driver_passes_core_fields_to_selenium_runner(monkeypatch) -> None:
    calls: list[dict] = []
    driver = SimpleNamespace(implicitly_wait=lambda seconds: calls.append({"implicitly_wait": seconds}))

    class FakeRunner:
        def get_driver(self, open_ret_json):
            calls.append(dict(open_ret_json))
            return driver

    monkeypatch.setattr(driver_session, "_resolve_browser_driver", lambda: FakeRunner())
    monkeypatch.setattr(driver_session, "detach_driver", lambda selected_driver: calls.append({"detach": selected_driver}))

    with driver_session.attached_driver(
        browser_path="/tmp/browser",
        debugging_port=9222,
        core_type=0,
        core_version="138.1.2.80",
    ) as attached:
        assert attached is driver

    assert {
        "browserPath": "/tmp/browser",
        "debuggingPort": 9222,
        "core_type": 0,
        "core_version": "138.1.2.80",
    } in calls
