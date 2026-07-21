from __future__ import annotations

import time
from pathlib import Path

from browser_auth_service import service
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
        return self._values[index]


class FakePage:
    def __init__(self, frames: list[FakeFrame], *, url: str = "https://private.mabangerp.com/") -> None:
        self.frames = frames
        self.main_frame = frames[0] if frames else None
        self.url = url
        self.waits: list[int] = []

    def wait_for_timeout(self, timeout_ms: int) -> None:
        self.waits.append(timeout_ms)


def test_launch_chromium_uses_single_full_browser_for_headed_and_headless_modes() -> None:
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
        {"channel": "chromium", "headless": True},
        {"channel": "chromium", "headless": False},
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

    token = _extract_token(
        page,
        "https://amz1-private.mabangerp.com",
        "freeToken",
        wait_seconds=0,
        poll_interval_ms=1,
    )

    assert token == ""
    assert private_frame.calls == 0


def test_extract_token_returns_empty_when_target_origin_has_no_token() -> None:
    token_frame = FakeFrame("https://amz1-private.mabangerp.com/dashboard", [""])
    broken_frame = FakeFrame("https://sub.amz1-private.mabangerp.com/widget", raises=True)
    page = FakePage([token_frame, broken_frame])

    token = _extract_token(
        page,
        "https://amz1-private.mabangerp.com",
        "freeToken",
        wait_seconds=0,
        poll_interval_ms=1,
    )

    assert token == ""
    assert token_frame.calls == 1
    assert broken_frame.calls == 1


def _token_payload(token_value: str = "cached-token") -> dict[str, object]:
    return {
        "cookies": [],
        "origins": [
            {
                "origin": "https://amz1-private.mabangerp.com",
                "localStorage": [
                    {"name": "freeToken", "value": token_value},
                    {"name": "lang", "value": "cn"},
                ],
            },
            {
                "origin": "https://amz1.mabangerp.com",
                "localStorage": [{"name": "freeToken", "value": "other-origin-token"}],
            },
        ],
        "last_refreshed_at": int(time.time()),
    }


def test_ensure_fba_auth_uses_cache_when_fresh_and_not_forced(tmp_path: Path, monkeypatch) -> None:
    payload = _token_payload("cached-token")

    def fail_sync_playwright():
        raise AssertionError("fresh cache should not open Playwright")

    monkeypatch.setattr(service, "sync_playwright", fail_sync_playwright)

    result = service._ensure_fba_auth(
        account="account",
        password="password",
        state_file=tmp_path / "state.json",
        payload=payload,
        phpsessid_status={"valid": True},
        require_wms_cookie_header=False,
        force_refresh=False,
    )

    assert result["source"] == "cache"
    assert result["free_token"] == "cached-token"


def test_ensure_fba_auth_force_refresh_uses_clean_context(tmp_path: Path, monkeypatch) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text("{}", encoding="utf-8")
    payload = _token_payload("cached-token")
    captured_context: dict[str, object] = {}
    login_calls: list[tuple[str, str]] = []

    class FakePage:
        def __init__(self) -> None:
            self.url = "https://private.mabangerp.com/"

        def goto(self, url: str, wait_until: str = "load") -> None:
            self.url = url

        def wait_for_timeout(self, timeout_ms: int) -> None:
            return None

    class FakeContext:
        def new_page(self) -> FakePage:
            return FakePage()

        def close(self) -> None:
            return None

    class FakeBrowser:
        def close(self) -> None:
            return None

    class FakeChromium:
        def launch(self, *, channel: str, headless: bool):
            assert channel == "chromium"
            return FakeBrowser()

    class FakePlaywright:
        chromium = FakeChromium()

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

    def fake_open_context(browser, state_file, can_reuse_state, storage_state_payload=None):
        captured_context["can_reuse_state"] = can_reuse_state
        captured_context["storage_state_payload"] = storage_state_payload
        captured_context["state_exists"] = state_file.exists()
        return FakeContext()

    def fake_save_storage_state(context, state_file, extra_fields=None):
        return {
            "origins": [
                {
                    "origin": "https://amz1-private.mabangerp.com",
                    "localStorage": [{"name": "freeToken", "value": "fresh-token"}],
                }
            ],
            **(extra_fields or {}),
        }

    monkeypatch.setattr(service, "sync_playwright", lambda: FakePlaywright())
    monkeypatch.setattr(service, "_open_context", fake_open_context)
    monkeypatch.setattr(service, "_perform_login", lambda page, account, password: login_calls.append((account, password)))
    monkeypatch.setattr(service, "_extract_token", lambda page, origin, key: "fresh-token")
    monkeypatch.setattr(service, "_save_storage_state", fake_save_storage_state)

    result = service._ensure_fba_auth(
        account="account",
        password="password",
        state_file=state_file,
        payload=payload,
        phpsessid_status={"valid": True},
        require_wms_cookie_header=False,
        force_refresh=True,
    )

    assert captured_context == {
        "can_reuse_state": False,
        "storage_state_payload": None,
        "state_exists": False,
    }
    assert login_calls == [("account", "password")]
    assert result["source"] == "relogin"
    assert result["free_token"] == "fresh-token"


def test_ensure_fba_auth_wms_force_refresh_uses_clean_context(
    tmp_path: Path,
    monkeypatch,
) -> None:
    state_file = tmp_path / "state.json"
    state_file.write_text("{}", encoding="utf-8")
    payload = _token_payload("cached-token")
    payload["cookies"] = [
        {"name": "WMSID", "value": "old", "domain": "wms.private.mabangerp.com"},
        {"name": "PHPSESSID", "value": "keep", "domain": "private.mabangerp.com"},
    ]
    captured_context: dict[str, object] = {}
    login_calls: list[tuple[str, str]] = []

    class FakePage:
        def __init__(self) -> None:
            self.url = "https://private.mabangerp.com/"

        def goto(self, url: str, wait_until: str = "load") -> None:
            self.url = url

        def wait_for_timeout(self, timeout_ms: int) -> None:
            return None

    class FakeContext:
        def new_page(self) -> FakePage:
            return FakePage()

        def close(self) -> None:
            return None

    class FakeBrowser:
        def close(self) -> None:
            return None

    class FakeChromium:
        def launch(self, *, channel: str, headless: bool):
            assert channel == "chromium"
            return FakeBrowser()

    class FakePlaywright:
        chromium = FakeChromium()

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb) -> None:
            return None

    def fake_open_context(browser, state_file, can_reuse_state, storage_state_payload=None):
        captured_context["can_reuse_state"] = can_reuse_state
        captured_context["storage_state_payload"] = storage_state_payload
        captured_context["state_exists"] = state_file.exists()
        return FakeContext()

    def fake_save_storage_state(context, state_file, extra_fields=None):
        return {
            "origins": [
                {
                    "origin": "https://amz1-private.mabangerp.com",
                    "localStorage": [{"name": "freeToken", "value": "fresh-token"}],
                }
            ],
            **(extra_fields or {}),
        }

    monkeypatch.setattr(service, "sync_playwright", lambda: FakePlaywright())
    monkeypatch.setattr(service, "_open_context", fake_open_context)
    monkeypatch.setattr(service, "_perform_login", lambda page, account, password: login_calls.append((account, password)))
    monkeypatch.setattr(service, "_extract_token", lambda page, origin, key: "fresh-token")
    monkeypatch.setattr(service, "_collect_wms_cookie_header", lambda page, context, host, text: "fresh-wms=1")
    monkeypatch.setattr(service, "_save_storage_state", fake_save_storage_state)

    result = service._ensure_fba_auth(
        account="account",
        password="password",
        state_file=state_file,
        payload=payload,
        phpsessid_status={"valid": True},
        require_wms_cookie_header=True,
        force_refresh=True,
    )

    assert captured_context == {
        "can_reuse_state": False,
        "storage_state_payload": None,
        "state_exists": False,
    }
    assert login_calls == [("account", "password")]
    assert result["wms_cookie_header"] == "fresh-wms=1"
