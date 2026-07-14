from __future__ import annotations

import hashlib
from types import SimpleNamespace

import pytest

from services.browser.store import ziniao_process


class FakeResponse:
    def __init__(self, *, status_code: int = 200, text: str = "", chunks: list[bytes] | None = None) -> None:
        self.status_code = status_code
        self.text = text
        self._chunks = list(chunks or [])
        self.closed = False

    def iter_content(self, chunk_size: int = 1):
        _ = chunk_size
        yield from self._chunks

    def close(self) -> None:
        self.closed = True


class FakeExternalSession:
    def __init__(self, responses: list[FakeResponse]) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, object]] = []

    def get(self, url: str, **kwargs):
        self.calls.append({"url": url, "kwargs": dict(kwargs)})
        if not self.responses:
            raise AssertionError(f"unexpected GET: {url}")
        return self.responses.pop(0)


def _sha1(payload: bytes) -> str:
    return hashlib.sha1(payload).hexdigest()


def _driver_config(name: str, payload: bytes) -> str:
    return (
        "["
        f'{{"name": "{name}", "sha1": "{_sha1(payload)}", "url": "https://example.test/{name}"}}'
        "]"
    )


def test_download_driver_downloads_missing_windows_driver(monkeypatch, tmp_path):
    payload = b"driver-binary"
    fake_session = FakeExternalSession(
        [
            FakeResponse(text=_driver_config("chromedriver120", payload)),
            FakeResponse(chunks=[payload]),
        ]
    )
    monkeypatch.setattr(ziniao_process.platform, "system", lambda: "Windows")
    monkeypatch.setattr(ziniao_process, "external_requests_session", fake_session)

    ziniao_process.download_driver(str(tmp_path))

    driver_path = tmp_path / "chromedriver120.exe"
    assert driver_path.read_bytes() == payload
    assert [call["url"] for call in fake_session.calls] == [
        "https://cdn-superbrowser-attachment.ziniao.com/webdriver/exe_32/config.json",
        "https://example.test/chromedriver120",
    ]


def test_download_driver_skips_existing_driver_when_sha1_matches(monkeypatch, tmp_path):
    payload = b"driver-binary"
    (tmp_path / "chromedriver120.exe").write_bytes(payload)
    fake_session = FakeExternalSession([FakeResponse(text=_driver_config("chromedriver120", payload))])
    monkeypatch.setattr(ziniao_process.platform, "system", lambda: "Windows")
    monkeypatch.setattr(ziniao_process, "external_requests_session", fake_session)

    ziniao_process.download_driver(str(tmp_path))

    assert (tmp_path / "chromedriver120.exe").read_bytes() == payload
    assert len(fake_session.calls) == 1


def test_download_driver_redownloads_existing_driver_when_sha1_mismatches(monkeypatch, tmp_path):
    payload = b"new-driver"
    (tmp_path / "chromedriver120.exe").write_bytes(b"old-driver")
    fake_session = FakeExternalSession(
        [
            FakeResponse(text=_driver_config("chromedriver120", payload)),
            FakeResponse(chunks=[payload]),
        ]
    )
    monkeypatch.setattr(ziniao_process.platform, "system", lambda: "Windows")
    monkeypatch.setattr(ziniao_process, "external_requests_session", fake_session)

    ziniao_process.download_driver(str(tmp_path))

    assert (tmp_path / "chromedriver120.exe").read_bytes() == payload
    assert len(fake_session.calls) == 2


def test_download_driver_skips_download_on_linux(monkeypatch, tmp_path):
    fake_session = FakeExternalSession([])
    monkeypatch.setattr(ziniao_process.platform, "system", lambda: "Linux")
    monkeypatch.setattr(ziniao_process, "external_requests_session", fake_session)

    ziniao_process.download_driver(str(tmp_path))

    assert fake_session.calls == []


def test_download_driver_rejects_sha1_mismatch_after_download(monkeypatch, tmp_path):
    fake_session = FakeExternalSession(
        [
            FakeResponse(
                text='[{"name": "chromedriver120", "sha1": "bad", "url": "https://example.test/driver"}]'
            ),
            FakeResponse(chunks=[b"driver-binary"]),
        ]
    )
    monkeypatch.setattr(ziniao_process.platform, "system", lambda: "Windows")
    monkeypatch.setattr(ziniao_process, "external_requests_session", fake_session)

    with pytest.raises(RuntimeError, match="sha1 mismatch"):
        ziniao_process.download_driver(str(tmp_path))


def test_kill_process_uses_windows_process_name_by_version(monkeypatch):
    commands: list[list[str]] = []

    def fake_run(cmd, **kwargs):
        commands.append(list(cmd))
        assert kwargs["check"] is False
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(ziniao_process.platform, "system", lambda: "Windows")
    monkeypatch.setattr(ziniao_process.subprocess, "run", fake_run)
    monkeypatch.setattr(ziniao_process.time, "sleep", lambda seconds: None)

    ziniao_process.kill_process("v6")
    ziniao_process.kill_process("v5")

    assert commands == [
        ["taskkill", "/f", "/t", "/im", "ziniao.exe"],
        ["taskkill", "/f", "/t", "/im", "SuperBrowser.exe"],
    ]


def test_kill_process_nonzero_return_does_not_raise(monkeypatch):
    monkeypatch.setattr(ziniao_process.platform, "system", lambda: "Windows")
    monkeypatch.setattr(
        ziniao_process.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=128, stdout="", stderr="not found"),
    )
    monkeypatch.setattr(ziniao_process.time, "sleep", lambda seconds: None)

    ziniao_process.kill_process("v6")


def test_kill_process_rejects_invalid_version_before_subprocess(monkeypatch):
    monkeypatch.setattr(ziniao_process.platform, "system", lambda: "Windows")
    monkeypatch.setattr(
        ziniao_process.subprocess,
        "run",
        lambda *args, **kwargs: pytest.fail("subprocess.run should not be called"),
    )

    with pytest.raises(RuntimeError, match="ZINIAO_BROWSER_VERSION"):
        ziniao_process.kill_process("v7")
