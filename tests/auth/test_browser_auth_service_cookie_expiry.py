from __future__ import annotations

import browser_auth_service.service as service

NOW_TS = 1_781_000_000.0


def _cookie(name: str, expires: object, value: str = "value") -> dict[str, object]:
    return {
        "name": name,
        "value": value,
        "domain": service.PRIVATE_AMZ_HOST,
        "path": "/",
        "expires": expires,
    }


def _private_amz_payload(*cookies: dict[str, object]) -> dict[str, object]:
    return {"cookies": list(cookies)}


def _valid_private_amz_cookies() -> list[dict[str, object]]:
    return [
        _cookie("PHPSESSID", NOW_TS + 600),
        _cookie("MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE", NOW_TS + 600),
        _cookie("MABANG_ERP_PRO_MEMBERINFO_LOGIN_PLUS", NOW_TS + 600),
        _cookie("signed", NOW_TS + 600),
        _cookie("route", -1),
    ]


def test_private_amz_cookie_bundle_is_valid_when_required_cookies_are_fresh(monkeypatch) -> None:
    monkeypatch.setattr(service.time, "time", lambda: NOW_TS)
    payload = _private_amz_payload(*_valid_private_amz_cookies())

    assert service._has_private_amz_cookie_bundle(payload)
    assert service._invalid_cookie_status_labels_for_host(
        payload,
        service.PRIVATE_AMZ_HOST,
        service.PRIVATE_AMZ_REQUIRED_COOKIE_NAMES,
    ) == []


def test_private_amz_cookie_bundle_reports_missing_required_cookie(monkeypatch) -> None:
    monkeypatch.setattr(service.time, "time", lambda: NOW_TS)
    cookies = [
        item
        for item in _valid_private_amz_cookies()
        if item["name"] != "signed"
    ]
    payload = _private_amz_payload(*cookies)

    assert not service._has_private_amz_cookie_bundle(payload)
    assert service._invalid_cookie_status_labels_for_host(
        payload,
        service.PRIVATE_AMZ_HOST,
        service.PRIVATE_AMZ_REQUIRED_COOKIE_NAMES,
    ) == ["signed(missing)"]


def test_private_amz_cookie_bundle_reports_expired_required_cookie(monkeypatch) -> None:
    monkeypatch.setattr(service.time, "time", lambda: NOW_TS)
    cookies = _valid_private_amz_cookies()
    cookies[1] = _cookie("MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE", NOW_TS - 1)
    payload = _private_amz_payload(*cookies)

    assert not service._has_private_amz_cookie_bundle(payload)
    assert service._invalid_cookie_status_labels_for_host(
        payload,
        service.PRIVATE_AMZ_HOST,
        service.PRIVATE_AMZ_REQUIRED_COOKIE_NAMES,
    ) == ["MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE(expired)"]


def test_private_amz_cookie_bundle_reports_cookie_expiring_within_skew(monkeypatch) -> None:
    monkeypatch.setattr(service.time, "time", lambda: NOW_TS)
    cookies = _valid_private_amz_cookies()
    cookies[3] = _cookie("signed", NOW_TS + 299)
    payload = _private_amz_payload(*cookies)

    assert not service._has_private_amz_cookie_bundle(payload)
    assert service._invalid_cookie_status_labels_for_host(
        payload,
        service.PRIVATE_AMZ_HOST,
        service.PRIVATE_AMZ_REQUIRED_COOKIE_NAMES,
    ) == ["signed(expires_soon)"]


def test_private_amz_cookie_bundle_accepts_session_cookie_with_value(monkeypatch) -> None:
    monkeypatch.setattr(service.time, "time", lambda: NOW_TS)
    payload = _private_amz_payload(*_valid_private_amz_cookies())

    assert service._has_private_amz_cookie_bundle(payload)


def test_private_amz_cookie_bundle_rejects_empty_session_cookie_value(monkeypatch) -> None:
    monkeypatch.setattr(service.time, "time", lambda: NOW_TS)
    cookies = _valid_private_amz_cookies()
    cookies[4] = _cookie("route", -1, value="")
    payload = _private_amz_payload(*cookies)

    assert not service._has_private_amz_cookie_bundle(payload)
    assert service._invalid_cookie_status_labels_for_host(
        payload,
        service.PRIVATE_AMZ_HOST,
        service.PRIVATE_AMZ_REQUIRED_COOKIE_NAMES,
    ) == ["route(value_missing)"]
