from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import ANY

import pytest

from services.browser.store import ziniao_browser_client, ziniao_client


class FakeClient:
    def __init__(
        self,
        readiness_failures_before_success: int = 0,
        update_core_results: list[dict] | None = None,
    ) -> None:
        self.readiness_failures_before_success = readiness_failures_before_success
        self.update_core_results = list(update_core_results or [{"statusCode": 0}])
        self.calls: list[str] = []

    def get_browser_list(self):
        self.calls.append("get_browser_list")
        return []

    def get_running_info(self):
        self.calls.append("get_running_info")
        attempts = sum(1 for call in self.calls if call == "get_running_info")
        if attempts <= self.readiness_failures_before_success:
            raise RuntimeError("client not ready")
        return []

    def update_core(self):
        self.calls.append("update_core")
        if not self.update_core_results:
            raise AssertionError("unexpected update_core call")
        return self.update_core_results.pop(0)

    def start_browser(self, browser_oauth: str):
        self.calls.append(f"start_browser:{browser_oauth}")
        return {"browserOauth": browser_oauth}

    def stop_browser(self, browser_oauth: str):
        self.calls.append(f"stop_browser:{browser_oauth}")

    def exit_client(self):
        self.calls.append("exit_client")


def _client_path(tmp_path):
    path = tmp_path / "ziniao.exe"
    path.write_text("fake", encoding="utf-8")
    return str(path)


def _configure(monkeypatch, tmp_path, *, client_path: str | None = None, system: str = "Windows") -> None:
    monkeypatch.setattr(
        ziniao_browser_client,
        "platform",
        SimpleNamespace(system=lambda: system),
        raising=False,
    )
    monkeypatch.setattr(ziniao_browser_client.ziniao_settings, "ZINIAO_BROWSER_VERSION", "v6", raising=False)
    monkeypatch.setattr(ziniao_browser_client.ziniao_settings, "ZINIAO_WEBDRIVER_PATH", str(tmp_path), raising=False)
    monkeypatch.setattr(
        ziniao_browser_client.ziniao_settings,
        "ZINIAO_CLIENT_PATH",
        client_path if client_path is not None else _client_path(tmp_path),
        raising=False,
    )
    monkeypatch.setattr(ziniao_browser_client.ziniao_settings, "ZINIAO_SOCKET_PORT", 19000, raising=False)


def test_build_client_command_uses_windows_webdriver_args(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path, system="Windows")

    assert ziniao_browser_client._build_client_command(19000) == [
        _client_path(tmp_path),
        "--run_type=web_driver",
        "--ipc_type=http",
        "--port=19000",
    ]


def test_build_client_command_uses_macos_open_a_for_app_name(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path, client_path="ziniao", system="Darwin")

    assert ziniao_browser_client._build_client_command(19000) == [
        "open",
        "-a",
        "ziniao",
        "--args",
        "--run_type=web_driver",
        "--ipc_type=http",
        "--port=19000",
    ]


def test_build_client_command_resolves_macos_inner_executable_to_app_bundle(monkeypatch, tmp_path):
    client_path = tmp_path / "ziniao.app" / "Contents" / "MacOS" / "ziniao"
    client_path.parent.mkdir(parents=True)
    client_path.write_text("fake", encoding="utf-8")
    client_path.chmod(0o755)
    _configure(monkeypatch, tmp_path, client_path=str(client_path), system="Darwin")

    assert ziniao_browser_client._build_client_command(19000) == [
        "open",
        "-a",
        str(tmp_path / "ziniao.app"),
        "--args",
        "--run_type=web_driver",
        "--ipc_type=http",
        "--port=19000",
    ]


def test_build_client_command_uses_linux_no_sandbox(monkeypatch, tmp_path):
    client_path = tmp_path / "ziniaobrowser"
    client_path.write_text("fake", encoding="utf-8")
    client_path.chmod(0o755)
    _configure(monkeypatch, tmp_path, client_path=str(client_path), system="Linux")

    assert ziniao_browser_client._build_client_command(19000) == [
        str(client_path),
        "--no-sandbox",
        "--run_type=web_driver",
        "--ipc_type=http",
        "--port=19000",
    ]


def test_open_client_api_available_does_not_prepare_or_launch(monkeypatch, tmp_path):
    calls: list[object] = []
    _configure(monkeypatch, tmp_path)
    monkeypatch.setattr(
        ziniao_browser_client,
        "download_driver",
        lambda path: pytest.fail("download_driver should not be called"),
    )
    monkeypatch.setattr(
        ziniao_browser_client,
        "kill_process",
        lambda version: pytest.fail("kill_process should not be called"),
    )
    monkeypatch.setattr(
        ziniao_browser_client.subprocess,
        "Popen",
        lambda *args, **kwargs: pytest.fail("Popen should not be called"),
    )
    monkeypatch.setattr(
        ziniao_browser_client.ZiniaoLifecycleManager,
        "resolve_client_pid",
        staticmethod(
            lambda control_port, preferred_pid=0: calls.append(
                ("resolve_client_pid", control_port, preferred_pid)
            )
            or 1234
        ),
    )

    client = ziniao_browser_client.ZiniaoBrowserClient()
    fake_client = FakeClient()
    client._client = fake_client

    assert client.open_client() is True
    assert client.open_client() is True

    assert fake_client.calls == ["get_running_info"]
    assert calls == [("resolve_client_pid", 19000, 0)]


def test_open_client_api_unavailable_prepares_launches_and_polls(monkeypatch, tmp_path):
    calls: list[object] = []
    _configure(monkeypatch, tmp_path)
    monkeypatch.setattr(
        ziniao_browser_client,
        "download_driver",
        lambda path: calls.append(("download_driver", path)),
    )
    monkeypatch.setattr(
        ziniao_browser_client,
        "kill_process",
        lambda version: calls.append(("kill_process", version)),
    )
    monkeypatch.setattr(ziniao_browser_client.time, "sleep", lambda seconds: calls.append(("sleep", seconds)))

    def fake_popen(cmd, **kwargs):
        calls.append(("popen", list(cmd), dict(kwargs)))
        return SimpleNamespace(pid=4321)

    def fake_resolve_client_pid(control_port, preferred_pid=0):
        calls.append(("resolve_client_pid", control_port, preferred_pid))
        return 4321

    monkeypatch.setattr(ziniao_browser_client.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(
        ziniao_browser_client.ZiniaoLifecycleManager,
        "resolve_client_pid",
        staticmethod(fake_resolve_client_pid),
    )

    client = ziniao_browser_client.ZiniaoBrowserClient()
    fake_client = FakeClient(readiness_failures_before_success=1)
    client._client = fake_client

    assert client.open_client() is True

    assert fake_client.calls == ["get_running_info", "get_running_info"]
    assert calls[0:3] == [
        ("download_driver", str(tmp_path)),
        ("kill_process", "v6"),
        (
            "popen",
            [
                _client_path(tmp_path),
                "--run_type=web_driver",
                "--ipc_type=http",
                "--port=19000",
            ],
            {
                "stdout": ziniao_browser_client.subprocess.DEVNULL,
                "stderr": ziniao_browser_client.subprocess.DEVNULL,
                "creationflags": getattr(ziniao_browser_client.subprocess, "CREATE_NO_WINDOW", 0),
            },
        ),
    ]
    assert calls[-1] == ("resolve_client_pid", 19000, 4321)
    assert client._client_pid == 4321


def test_client_ready_prevents_repeated_prepare_across_api_methods(monkeypatch, tmp_path):
    calls: list[tuple[str, str]] = []
    _configure(monkeypatch, tmp_path)
    monkeypatch.setattr(
        ziniao_browser_client,
        "download_driver",
        lambda path: calls.append(("download_driver", path)),
    )
    monkeypatch.setattr(
        ziniao_browser_client,
        "kill_process",
        lambda version: calls.append(("kill_process", version)),
    )
    monkeypatch.setattr(
        ziniao_browser_client.ZiniaoLifecycleManager,
        "resolve_client_pid",
        staticmethod(lambda _control_port, preferred_pid=0: preferred_pid or 1234),
    )

    client = ziniao_browser_client.ZiniaoBrowserClient()
    fake_client = FakeClient()
    client._client = fake_client

    client.get_browser_list()
    client.start_browser("store-1")
    client.get_running_info()

    assert calls == []
    assert fake_client.calls == [
        "get_running_info",
        "update_core",
        "get_browser_list",
        "start_browser:store-1",
        "get_running_info",
    ]


def test_stop_browser_and_close_client_do_not_start_when_api_unavailable(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path)
    monkeypatch.setattr(
        ziniao_browser_client,
        "download_driver",
        lambda path: pytest.fail("download_driver should not be called"),
    )
    monkeypatch.setattr(
        ziniao_browser_client,
        "kill_process",
        lambda version: pytest.fail("kill_process should not be called"),
    )
    monkeypatch.setattr(
        ziniao_browser_client.subprocess,
        "Popen",
        lambda *args, **kwargs: pytest.fail("Popen should not be called"),
    )

    client = ziniao_browser_client.ZiniaoBrowserClient()
    fake_client = FakeClient(readiness_failures_before_success=100)
    client._client = fake_client

    client.stop_browser("store-1")
    client.close_client()

    assert fake_client.calls == ["get_running_info", "get_running_info"]


def test_get_browser_list_updates_core_before_authenticated_request(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path)
    monkeypatch.setattr(
        ziniao_browser_client.ZiniaoLifecycleManager,
        "resolve_client_pid",
        staticmethod(lambda _control_port, preferred_pid=0: preferred_pid or 1234),
    )

    client = ziniao_browser_client.ZiniaoBrowserClient()
    fake_client = FakeClient(
        update_core_results=[{"statusCode": -10000}, {"statusCode": 0}],
    )
    client._client = fake_client
    monkeypatch.setattr(ziniao_browser_client.time, "sleep", lambda _seconds: None)

    assert client.get_browser_list() == []
    assert fake_client.calls == [
        "get_running_info",
        "update_core",
        "update_core",
        "get_browser_list",
    ]


def test_get_browser_list_does_not_restart_or_retry_on_auth_failure(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path)
    monkeypatch.setattr(
        ziniao_browser_client,
        "download_driver",
        lambda path: pytest.fail("download_driver should not be called"),
    )
    monkeypatch.setattr(
        ziniao_browser_client,
        "kill_process",
        lambda version: pytest.fail("kill_process should not be called"),
    )
    monkeypatch.setattr(
        ziniao_browser_client.subprocess,
        "Popen",
        lambda *args, **kwargs: pytest.fail("Popen should not be called"),
    )
    monkeypatch.setattr(
        ziniao_browser_client.ZiniaoLifecycleManager,
        "resolve_client_pid",
        staticmethod(lambda _control_port, preferred_pid=0: preferred_pid or 1234),
    )

    client = ziniao_browser_client.ZiniaoBrowserClient()
    fake_client = FakeClient(update_core_results=[{"statusCode": -10003, "err": "登录失败"}])
    client._client = fake_client

    with pytest.raises(RuntimeError, match="-10003"):
        client.get_browser_list()

    assert fake_client.calls == ["get_running_info", "update_core"]


def test_update_core_sends_credentials_and_surfaces_auth_failure_once(monkeypatch):
    calls: list[dict] = []

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"statusCode": -10003, "err": "登录失败"}

    def fake_post(url, **kwargs):
        calls.append({"url": url, "kwargs": dict(kwargs)})
        return FakeResponse()

    monkeypatch.setattr(
        ziniao_client,
        "local_service_requests_session",
        SimpleNamespace(post=fake_post),
    )
    client = ziniao_client.ZiniaoClient(
        16851,
        {"company": "company", "username": "username", "password": "password"},
    )

    with pytest.raises(ziniao_client.ZiniaoClientError, match="-10003"):
        client.update_core()

    assert len(calls) == 1
    assert calls[0]["url"] == "http://127.0.0.1:16851"
    assert calls[0]["kwargs"]["timeout"] == 120
    assert json.loads(calls[0]["kwargs"]["data"].decode("utf-8")) == {
        "action": "updateCore",
        "requestId": ANY,
        "company": "company",
        "username": "username",
        "password": "password",
    }


def test_open_client_invalid_browser_version_does_not_launch(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path)
    monkeypatch.setattr(ziniao_browser_client.ziniao_settings, "ZINIAO_BROWSER_VERSION", "v7", raising=False)
    monkeypatch.setattr(
        ziniao_browser_client,
        "download_driver",
        lambda path: pytest.fail("download_driver should not be called"),
    )
    monkeypatch.setattr(
        ziniao_browser_client,
        "kill_process",
        lambda version: pytest.fail("kill_process should not be called"),
    )
    monkeypatch.setattr(
        ziniao_browser_client.subprocess,
        "Popen",
        lambda *args, **kwargs: pytest.fail("Popen should not be called"),
    )

    client = ziniao_browser_client.ZiniaoBrowserClient()
    client._client = FakeClient(readiness_failures_before_success=1)

    with pytest.raises(RuntimeError, match="ZINIAO_BROWSER_VERSION"):
        client.open_client()


def test_open_client_rejects_directory_client_path_before_popen(monkeypatch, tmp_path):
    _configure(monkeypatch, tmp_path, client_path=str(tmp_path))
    monkeypatch.setattr(ziniao_browser_client, "download_driver", lambda path: None)
    monkeypatch.setattr(ziniao_browser_client, "kill_process", lambda version: None)
    monkeypatch.setattr(
        ziniao_browser_client.subprocess,
        "Popen",
        lambda *args, **kwargs: pytest.fail("Popen should not be called"),
    )

    client = ziniao_browser_client.ZiniaoBrowserClient()
    client._client = FakeClient(readiness_failures_before_success=1)

    with pytest.raises(RuntimeError, match="不是可执行文件"):
        client.open_client()
