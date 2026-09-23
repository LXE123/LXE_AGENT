from __future__ import annotations

from hashlib import sha256
from typing import Any

from services.zhihui_tms.session import ZhihuiTmsSessionProvider


class FakeResponse:
    def __init__(self, status_code: int, payload: Any) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> Any:
        return self._payload


class FakeSession:
    def __init__(self, responses: list[FakeResponse]) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []

    def request(self, method: str, url: str, **kwargs: Any) -> FakeResponse:
        self.calls.append({"method": method, "url": url, **kwargs})
        return self.responses.pop(0)


def test_provider_uses_loopback_capability_and_a_stable_account_fingerprint() -> None:
    session = FakeSession(
        [
            FakeResponse(200, {"ok": True, "result": {"api_token": "fixture-token"}}),
            FakeResponse(200, {"ok": True, "result": None}),
            FakeResponse(200, {"ok": True, "result": None}),
        ]
    )
    provider = ZhihuiTmsSessionProvider(
        endpoint="http://127.0.0.1:43210",
        capability="a" * 64,
        session=session,
    )

    assert provider.read("fixture-account") == "fixture-token"
    provider.write("fixture-account", "new-fixture-token")
    provider.clear("fixture-account")

    fingerprint = sha256(b"fixture-account").hexdigest()
    assert [call["json"] for call in session.calls] == [
        {"operation": "read", "account_fingerprint": fingerprint},
        {"operation": "write", "account_fingerprint": fingerprint, "api_token": "new-fixture-token"},
        {"operation": "clear", "account_fingerprint": fingerprint},
    ]
    assert session.calls[0]["method"] == "POST"
    assert session.calls[0]["url"] == "http://127.0.0.1:43210/v1/zhihui-tms-session"
    assert session.calls[0]["headers"] == {"Authorization": f"Bearer {'a' * 64}"}
    assert session.calls[0]["timeout"] == (2.0, 5.0)
    assert session.calls[0]["allow_redirects"] is False


def test_missing_untrusted_or_failed_host_degrades_to_an_empty_noop_session() -> None:
    missing = ZhihuiTmsSessionProvider.from_environment({})
    assert missing.read("fixture-account") is None
    missing.write("fixture-account", "fixture-token")
    missing.clear("fixture-account")

    untrusted = ZhihuiTmsSessionProvider.from_environment(
        {
            "LXE_ZHIHUI_TMS_SESSION_HOST_URL": "https://untrusted.example",
            "LXE_ZHIHUI_TMS_SESSION_HOST_TOKEN": "a" * 64,
        }
    )
    assert untrusted.read("fixture-account") is None

    failed = ZhihuiTmsSessionProvider(
        endpoint="http://127.0.0.1:43210",
        capability="a" * 64,
        session=FakeSession([FakeResponse(403, {"ok": False, "error": "rejected"})]),
    )
    assert failed.read("fixture-account") is None
