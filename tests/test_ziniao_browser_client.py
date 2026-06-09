from __future__ import annotations

from types import SimpleNamespace

import pytest

from services.browser.store import ziniao_browser_client


class FakeClient:
    def __init__(self, failures_before_success: int = 0) -> None:
        self.failures_before_success = failures_before_success
        self.calls: list[str] = []

    def get_browser_list(self):
        self.calls.append("get_browser_list")
        failures = sum(1 for call in self.calls if call == "get_browser_list")
        if failures <= self.failures_before_success:
            raise RuntimeError("client not ready")
        return []

    def get_running_info(self):
        self.calls.append("get_running_info")
        return []

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


def _configure(monkeypatch, tmp_path, *, client_path: str | None = None) -> None:
    monkeypatch.setattr(ziniao_browser_client.ziniao_settings, "ZINIAO_BROWSER_VERSION", "v6", raising=False)
    monkeypatch.setattr(ziniao_browser_client.ziniao_settings, "ZINIAO_WEBDRIVER_PATH", str(tmp_path), raising=False)
    monkeypatch.setattr(
        ziniao_browser_client.ziniao_settings,
        "ZINIAO_CLIENT_PATH",
        client_path if client_path is not None else _client_path(tmp_path),
        raising=False,
    )
    monkeypatch.setattr(ziniao_browser_client.ziniao_settings, "ZINIAO_SOCKET_PORT", 19000, raising=False)


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
        "register_client",
        staticmethod(lambda **kwargs: calls.append(("register_client", dict(kwargs))) or 1234),
    )

    client = ziniao_browser_client.ZiniaoBrowserClient()
    fake_client = FakeClient()
    client._client = fake_client

    assert client.open_client() is True
    assert client.open_client() is True

    assert fake_client.calls == ["get_browser_list"]
    assert calls == [
        (
            "register_client",
            {
                "control_port": 19000,
                "client_path": _client_path(tmp_path),
                "client_pid": 0,
            },
        )
    ]


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

    def fake_register_client(**kwargs):
        calls.append(("register_client", dict(kwargs)))
        return 4321

    monkeypatch.setattr(ziniao_browser_client.subprocess, "Popen", fake_popen)
    monkeypatch.setattr(
        ziniao_browser_client.ZiniaoLifecycleManager,
        "register_client",
        staticmethod(fake_register_client),
    )

    client = ziniao_browser_client.ZiniaoBrowserClient()
    fake_client = FakeClient(failures_before_success=1)
    client._client = fake_client

    assert client.open_client() is True

    assert fake_client.calls == ["get_browser_list", "get_browser_list"]
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
    assert calls[-1][0] == "register_client"
    assert calls[-1][1]["client_pid"] == 4321
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
        "register_client",
        staticmethod(lambda **kwargs: 1234),
    )

    client = ziniao_browser_client.ZiniaoBrowserClient()
    fake_client = FakeClient()
    client._client = fake_client

    client.get_browser_list()
    client.start_browser("store-1")
    client.get_running_info()

    assert calls == []
    assert fake_client.calls == [
        "get_browser_list",
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
    fake_client = FakeClient(failures_before_success=100)
    client._client = fake_client

    client.stop_browser("store-1")
    client.close_client()

    assert fake_client.calls == ["get_browser_list", "get_browser_list"]


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
    client._client = FakeClient(failures_before_success=1)

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
    client._client = FakeClient(failures_before_success=1)

    with pytest.raises(RuntimeError, match="不是可执行文件"):
        client.open_client()
