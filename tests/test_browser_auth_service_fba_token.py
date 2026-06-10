from __future__ import annotations

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
