from __future__ import annotations

import json

import pytest

from browser_auth_service import service
from browser_auth_service.host import HostBrowserError
from browser_auth_service.service import _extract_token


class FakeFrame:
    def __init__(self, url: str, values: list[object] | None = None, *, raises: bool = False) -> None:
        self.url = url
        self._values = list(values or [""])
        self._raises = raises
        self.calls = 0

    def evaluate(self, script: str, key: str) -> object:
        self.calls += 1
        if self._raises:
            raise RuntimeError("frame not ready")
        index = min(self.calls - 1, len(self._values) - 1)
        value = self._values[index]
        if isinstance(value, Exception):
            raise value
        return value


class FakePage:
    def __init__(self, frames: list[FakeFrame], *, url: str = "https://private.mabangerp.com/") -> None:
        self.frames = frames
        self.main_frame = frames[0] if frames else None
        self.url = url
        self.waits: list[int] = []

    def wait_for_timeout(self, timeout_ms: int) -> None:
        self.waits.append(timeout_ms)


def test_launch_chromium_uses_bound_executable_for_both_modes(monkeypatch) -> None:
    monkeypatch.setattr(service, "bound_executable", lambda: "/browser/chrome")
    calls: list[dict[str, object]] = []

    class FakeChromium:
        def launch(self, **options):
            calls.append(options)
            return object()

    class FakePlaywright:
        chromium = FakeChromium()

    service._launch_chromium(FakePlaywright(), headless=True)
    service._launch_chromium(FakePlaywright(), headless=False)

    assert calls == [
        {"executable_path": "/browser/chrome", "headless": True},
        {"executable_path": "/browser/chrome", "headless": False},
    ]


def test_extract_token_waits_for_target_origin_frame() -> None:
    private_frame = FakeFrame("https://private.mabangerp.com/index.php", ["wrong-token"])
    token_frame = FakeFrame("https://amz1-private.mabangerp.com/dashboard", ["", "", "free-token"])
    page = FakePage([private_frame, token_frame])

    token = _extract_token(
        page,
        "https://amz1-private.mabangerp.com",
        "freeToken",
        wait_seconds=1,
        poll_interval_ms=1,
    )

    assert token == "free-token"
    assert private_frame.calls == 0
    assert token_frame.calls == 3
    assert page.waits == [1, 1]


def test_extract_token_does_not_read_non_target_origin() -> None:
    private_frame = FakeFrame("https://private.mabangerp.com/index.php", ["wrong-token"])
    page = FakePage([private_frame])

    with pytest.raises(service.FbaTokenReadError) as captured:
        _extract_token(page, service.FBA_LOGISTICS_TOKEN_ORIGIN, "freeToken", wait_seconds=0)

    assert captured.value.details["reason"] == "target_frame_missing"
    assert captured.value.details["read_error_count"] == 0
    assert captured.value.details["frame_urls"] == [private_frame.url]
    assert private_frame.calls == 0


def test_extract_token_reports_empty_storage_and_any_read_errors() -> None:
    token_frame = FakeFrame("https://amz1-private.mabangerp.com/dashboard", [""])
    broken_frame = FakeFrame("https://sub.amz1-private.mabangerp.com/widget", raises=True)
    page = FakePage([token_frame, broken_frame])

    with pytest.raises(service.FbaTokenReadError) as captured:
        _extract_token(page, service.FBA_LOGISTICS_TOKEN_ORIGIN, "freeToken", wait_seconds=0)

    details = captured.value.details
    assert details["reason"] == "storage_value_empty"
    assert details["successful_reads"] == 1
    assert details["read_error_count"] == 1
    assert details["last_read_error"]["message"] == "frame not ready"
    assert token_frame.calls == 1
    assert broken_frame.calls == 1


def test_extract_token_empty_storage_is_not_reported_as_read_failure():
    page = FakePage([FakeFrame(service.FBA_LOGISTICS_TOKEN_ORIGIN, [None, ""])])
    with pytest.raises(service.FbaTokenReadError) as captured:
        _extract_token(page, service.FBA_LOGISTICS_TOKEN_ORIGIN, "freeToken", wait_seconds=0)
    assert captured.value.details["reason"] == "storage_value_empty"
    assert captured.value.details["last_read_error"] is None


def test_extract_token_recovers_from_transient_read_error():
    frame = FakeFrame(service.FBA_LOGISTICS_TOKEN_ORIGIN, [RuntimeError("frame detached"), "fresh-value"])
    page = FakePage([frame])
    assert _extract_token(page, service.FBA_LOGISTICS_TOKEN_ORIGIN, "freeToken") == "fresh-value"
    assert frame.calls == 2
    assert len(page.waits) == 1


def test_extract_token_preserves_remote_error_with_redaction_and_bounds(monkeypatch, caplog):
    monkeypatch.setenv("LXE_AUTH_BROWSER_HOST_TOKEN", "private-host-credential")
    cause = HostBrowserError({
        "exception_type": "SecurityError",
        "message": "Access to localStorage denied; private-host-credential; freeToken=secret-value " + "details " * 700,
    })
    url = service.FBA_LOGISTICS_TOKEN_ORIGIN + "/frame?ticket=private-ticket#private-fragment"
    page = FakePage([FakeFrame(url, [cause])])
    with pytest.raises(service.FbaTokenReadError) as captured:
        _extract_token(page, service.FBA_LOGISTICS_TOKEN_ORIGIN, "freeToken", wait_seconds=0)
    details = captured.value.details
    assert details["reason"] == "storage_read_failed"
    assert details["last_read_error"]["exception_type"] == "SecurityError"
    assert "Access to localStorage denied" in details["last_read_error"]["message"]
    assert "[truncated " in details["last_read_error"]["message"]
    assert captured.value.__cause__ is cause
    output = json.dumps(details) + caplog.text + str(captured.value)
    for secret in ("private-host-credential", "secret-value", "private-ticket", "private-fragment"):
        assert secret not in output


def test_extract_token_marks_omitted_frame_urls():
    page = FakePage([FakeFrame(f"https://unrelated.example/{index}") for index in range(25)])
    with pytest.raises(service.FbaTokenReadError) as captured:
        _extract_token(page, service.FBA_LOGISTICS_TOKEN_ORIGIN, "freeToken", wait_seconds=0)
    assert len(captured.value.details["frame_urls"]) == 20
    assert captured.value.details["frame_urls_omitted"] == 5
