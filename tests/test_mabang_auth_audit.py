from __future__ import annotations

from http.cookies import SimpleCookie

from services.mabang import auth_audit


def test_cookie_header_summary_does_not_include_values() -> None:
    summary = auth_audit.cookie_header_summary(
        "PHPSESSID=secret-sid; route=secret-route; blank="
    )

    assert "PHPSESSID" in summary
    assert "route" in summary
    assert "secret-sid" not in summary
    assert "secret-route" not in summary


def test_cookies_by_domain_summary_does_not_include_values() -> None:
    summary = auth_audit.cookies_by_domain_summary(
        {
            "private-amz.mabangerp.com": [
                {"name": "PHPSESSID", "value": "secret-sid", "domain": "private-amz.mabangerp.com"},
                {"name": "signed", "value": "secret-signed", "domain": "private-amz.mabangerp.com"},
            ],
            "private.mabangerp.com": [
                {"name": "MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE", "value": "secret-memcache"},
            ],
        }
    )

    assert "PHPSESSID@private-amz.mabangerp.com" in summary
    assert "signed@private-amz.mabangerp.com" in summary
    assert "MABANG_ERP_PRO_MEMBERINFO_LOGIN_COOKIE@private.mabangerp.com" in summary
    assert "secret-sid" not in summary
    assert "secret-signed" not in summary
    assert "secret-memcache" not in summary


def test_session_cookie_jar_summary_does_not_include_values() -> None:
    class FakeCookieJar:
        def filter_cookies(self, url: str):
            cookie = SimpleCookie()
            cookie["PHPSESSID"] = "secret-sid"
            cookie["route"] = "secret-route"
            return cookie

    class FakeSession:
        cookie_jar = FakeCookieJar()

    summary = auth_audit.session_cookie_jar_summary(
        FakeSession(),
        "https://wms.private.mabangerp.com/export_service/fbaamazon/ExeclFbaPackInfo2Amazon",
    )

    assert "PHPSESSID" in summary
    assert "route" in summary
    assert "wms.private.mabangerp.com" in summary
    assert "secret-sid" not in summary
    assert "secret-route" not in summary


def test_log_auth_material_acquired_includes_purpose_and_material_summary(caplog) -> None:
    caplog.set_level("INFO", logger="services.mabang.auth_audit")

    auth_audit.log_auth_material_acquired(
        purpose="wms_consignment_excel_export",
        caller="services.mabang.auth.get_fba_wms_cookie_header",
        scope="fba",
        source="refresh",
        force_refresh=True,
        cookies_by_domain={"wms.private.mabangerp.com": [{"name": "PHPSESSID", "value": "secret"}]},
        free_token="secret-token",
        wms_cookie_header="PHPSESSID=secret",
    )

    text = caplog.text
    assert "event=auth_material_acquired" in text
    assert "purpose=wms_consignment_excel_export" in text
    assert "scope=fba" in text
    assert "source=refresh" in text
    assert "token_present=True" in text
    assert "PHPSESSID" in text
    assert "secret-token" not in text
    assert "secret" not in text
