from copy import deepcopy
from unittest.mock import Mock
from uuid import uuid4

import pytest

from services.agent_cli.logistics import login, profiles, query, settings


@pytest.fixture
def account(monkeypatch, tmp_path):
    monkeypatch.setattr(settings, "data_directory", lambda: tmp_path / "settings")
    monkeypatch.delenv("LXESKILL_SKILL_SCOPE", raising=False)
    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "test-session")

    def make(provider="wesa", enabled=True, credential=False):
        snapshot = settings.read_snapshot()
        return settings.save_profile({"display_name": f"{provider}-{snapshot['revision']}",
            "provider_id": provider, "enabled": enabled,
            "login_username": "fixture-login" if credential else None,
            "credential_id": str(uuid4()) if credential else None}, snapshot["revision"])["profiles"][-1]
    return make


@pytest.mark.parametrize("provider", ["wesa", "tiantai", "feiwo", "yuntuo", "jiufang"])
def test_routes_fixed_adapter_without_changing_evidence(account, monkeypatch, provider):
    profile = account(provider)
    evidence = {"success": True, "request_succeeded": True, "found": False,
        "missing_fields": ["eta"], "warnings": ["fixture warning"], "complete": False,
        "source_fields": {"provider_raw": "observed"}}
    before = deepcopy(evidence)
    adapter = Mock(return_value=evidence)
    monkeypatch.setattr(query.ADAPTERS[provider], "run", adapter)
    args = {"profile_id": profile["profile_id"], "fba": "FBA19SS5YN6R", "expected_warehouse": "SMF3"}
    if provider != "jiufang":
        args["store_id"] = "explicit-store=="
    if provider in ("wesa", "tiantai"):
        args["account_name"] = "当前页面公司"
    result = query.run(args)
    assert result["success"] is True
    assert result["result"] == before
    assert evidence == before
    expected = {key: value for key, value in args.items() if key != "profile_id"}
    adapter.assert_called_once_with(expected)
    assert "credential_id" not in str(result)


def test_public_query_needs_no_session_or_desktop(account, monkeypatch):
    profile = account("jiufang")
    monkeypatch.delenv("LXE_AGENT_SESSION_ID")
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "jiufang-logistics-query")
    call = Mock(return_value={"success": True, "request_succeeded": True})
    monkeypatch.setattr(query.jiufang_query, "run", call)
    result = query.run({"profile_id": profile["profile_id"], "fba": "FBA15GJ013CQU000001", "identifier_kind": "box"})
    assert result["success"]
    call.assert_called_once_with({"fba": "FBA15GJ013CQU000001", "identifier_kind": "box"})


def test_rejects_disabled_missing_invalid_and_cross_scope_accounts(account, monkeypatch):
    enabled = account()
    disabled = account(enabled=False)
    call = Mock(side_effect=AssertionError("must not query"))
    monkeypatch.setattr(query.wesa_query, "run", call)
    base = {"profile_id": enabled["profile_id"], "fba": "FBA19SS5YN6R", "store_id": "store", "account_name": "当前公司"}
    for patch in ({"profile_id": disabled["profile_id"]}, {"profile_id": "bad"},
                  {"profile_id": "00000000-0000-0000-0000-000000000001"},
                  {"fba": "FBA19SS5YN6R,FBA19SS5YN6R"}, {"url": "http://other"}):
        assert query.run({**base, **patch})["success"] is False
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "jiufang-logistics-query")
    assert "requires skill fba-logistics-query" in query.run(base)["error"]["message"]
    call.assert_not_called()


def test_no_configured_login_or_legacy_company_is_used_as_live_company(account, monkeypatch):
    profile = account()
    call = Mock(side_effect=AssertionError("must not query"))
    monkeypatch.setattr(query.wesa_query, "run", call)
    result = query.run({"profile_id": profile["profile_id"], "store_id": "store", "fba": "FBA19SS5YN6R"})
    assert not result["success"]
    assert "current page" in result["error"]["message"]
    call.assert_not_called()


@pytest.mark.parametrize("provider,extra", [("jiufang", {"store_id": "store"}), ("jiufang", {"account_name": "公司"}),
    ("feiwo", {"page": 2}), ("yuntuo", {"identifier_kind": "box"})])
def test_rejects_provider_inapplicable_flags(account, monkeypatch, provider, extra):
    profile = account(provider)
    call = Mock(side_effect=AssertionError("must not query"))
    monkeypatch.setattr(query.ADAPTERS[provider], "run", call)
    args = {"profile_id": profile["profile_id"], "fba": "FBA19SS5YN6R"}
    if provider != "jiufang":
        args["store_id"] = "store"
    assert not query.run({**args, **extra})["success"]
    call.assert_not_called()


def test_actual_failure_is_preserved_without_retry(account, monkeypatch):
    profile = account("feiwo")
    error = {"code": "provider_error", "message": "fixture actual 403 diagnosis"}
    call = Mock(return_value={"success": False, "error": error, "http_status": 403, "warnings": ["keep"]})
    monkeypatch.setattr(query.feiwo_query, "run", call)
    result = query.run({"profile_id": profile["profile_id"], "store_id": "store", "fba": "FBA19SS5YN6R"})
    assert result["error"] == error
    assert result["result"]["http_status"] == 403
    assert call.call_count == 1


def test_profile_listing_is_scoped_and_has_no_credential_references(account, monkeypatch):
    account("wesa")
    jiufang = account("jiufang")
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "jiufang-logistics-query")
    result = profiles.run({})
    assert result["success"]
    assert [p["profile_id"] for p in result["profiles"]] == [jiufang["profile_id"]]
    assert "credential_id" not in str(result)
    assert not profiles.run({"provider": "wesa"})["success"]


def test_browser_query_requires_session_before_adapter(account, monkeypatch):
    profile = account("feiwo")
    monkeypatch.delenv("LXE_AGENT_SESSION_ID")
    result = query.run({"profile_id": profile["profile_id"], "store_id": "store", "fba": "FBA19SS5YN6R"})
    assert not result["success"]
    assert "LXE_AGENT_SESSION_ID is required" in result["error"]["message"]


@pytest.mark.parametrize("endpoint", ["https://127.0.0.1:1234", "http://example.test:1234", "http://127.0.0.1:1234/x", "http://user@127.0.0.1:1234", "http://127.0.0.1:1234?x=1", "http://127.0.0.1"])
def test_login_client_rejects_nonlocal_or_modified_endpoint(account, monkeypatch, endpoint):
    profile = account()
    monkeypatch.setenv("LXE_LOGISTICS_LOGIN_HOST_URL", endpoint)
    monkeypatch.setenv("LXE_LOGISTICS_LOGIN_HOST_TOKEN", "host-token-fixture")
    call = Mock(side_effect=AssertionError("no network"))
    monkeypatch.setattr(login.requests, "Session", call)
    result = login.run({"profile_id": profile["profile_id"], "store_id": "store"})
    assert not result["success"]
    call.assert_not_called()


def test_login_client_uses_only_ids_no_password_and_no_proxy(account, monkeypatch):
    profile = account()
    monkeypatch.setenv("LXE_LOGISTICS_LOGIN_HOST_URL", "http://127.0.0.1:1234")
    monkeypatch.setenv("LXE_LOGISTICS_LOGIN_HOST_TOKEN", "host-token-fixture")
    response = Mock(status_code=200)
    response.iter_content.return_value = [b'{"success":true,"status":"authenticated"}']
    response.__enter__ = Mock(return_value=response)
    response.__exit__ = Mock(return_value=False)
    session = Mock()
    session.__enter__ = Mock(return_value=session)
    session.__exit__ = Mock(return_value=False)
    session.post.return_value = response
    monkeypatch.setattr(login.requests, "Session", Mock(return_value=session))
    result = login.run({"profile_id": profile["profile_id"], "store_id": "store"})
    assert result["success"]
    assert session.trust_env is False
    _, kwargs = session.post.call_args
    assert kwargs["json"] == {"profile_id": profile["profile_id"], "store_id": "store", "session_id": "test-session", "expected_revision": 1}
    assert kwargs["allow_redirects"] is False
    assert session.post.call_count == 1


def test_auto_login_precedes_query_and_preserves_login_evidence(account, monkeypatch):
    profile = account()
    calls = []
    def authenticate(*args):
        calls.append("login")
        return {"success": True, "status": "already_authenticated", "profile_identity_verified": False}
    def read(args):
        calls.append("query")
        assert args["account_name"] == "实际页面公司"
        return {"success": True, "request_succeeded": True}
    monkeypatch.setattr(query, "ensure_login", authenticate)
    monkeypatch.setattr(query.wesa_query, "run", read)
    result = query.run({"profile_id": profile["profile_id"], "fba": "FBA19SS5YN6R", "store_id": "store",
                        "account_name": "实际页面公司", "login_mode": "auto"})
    assert result["success"] and not result["login"]["profile_identity_verified"]
    assert calls == ["login", "query"]


def test_yuntuo_auto_login_precedes_query_without_company_name(account, monkeypatch):
    profile = account("yuntuo", credential=True)
    calls = []
    monkeypatch.setattr(query, "ensure_login", Mock(side_effect=lambda *args: calls.append("login") or
        {"success": True, "status": "authenticated", "configured_login_submitted": True}))
    monkeypatch.setattr(query.yuntuo_query, "run", Mock(side_effect=lambda args: calls.append("query") or
        {"success": True, "request_succeeded": True, "found": True}))
    result = query.run({"profile_id": profile["profile_id"], "fba": "FBA19P9T04B2", "store_id": "store"})
    assert result["success"] and result["login"]["configured_login_submitted"], result
    assert calls == ["login", "query"]
    query.yuntuo_query.run.assert_called_once_with({"fba": "FBA19P9T04B2", "store_id": "store"})


def test_missing_company_after_login_never_guesses_a_company(account, monkeypatch):
    profile = account()
    monkeypatch.setattr(query, "ensure_login", Mock(return_value={"success": True, "configured_login_submitted": True,
        "profile_identity_verified": False, "form_evidence": {"company_names": ["只有一个公司有限公司"]}}))
    call = Mock(side_effect=AssertionError("must not query"))
    monkeypatch.setattr(query.wesa_query, "run", call)
    result = query.run({"profile_id": profile["profile_id"], "fba": "FBA19SS5YN6R", "store_id": "store", "login_mode": "auto"})
    assert not result["success"] and result["login"]["success"]
    assert "fresh snapshot" in result["error"]["message"]
    call.assert_not_called()


def test_login_failure_never_queries_or_retries(account, monkeypatch):
    profile = account()
    error = {"code": "browser_login_failed", "message": "fixture actual login rejection"}
    authenticate = Mock(return_value={"success": False, "error": error})
    monkeypatch.setattr(query, "ensure_login", authenticate)
    call = Mock(side_effect=AssertionError("must not query"))
    monkeypatch.setattr(query.wesa_query, "run", call)
    result = query.run({"profile_id": profile["profile_id"], "fba": "FBA19SS5YN6R", "store_id": "store", "login_mode": "auto"})
    assert result["error"] == error
    assert authenticate.call_count == 1
    call.assert_not_called()


def test_config_change_during_login_stops_before_query(account, monkeypatch):
    profile = account()
    def authenticate(*args):
        account("feiwo")
        return {"success": True}
    monkeypatch.setattr(query, "ensure_login", authenticate)
    call = Mock(side_effect=AssertionError("must not query"))
    monkeypatch.setattr(query.wesa_query, "run", call)
    result = query.run({"profile_id": profile["profile_id"], "fba": "FBA19SS5YN6R", "store_id": "store",
                        "account_name": "实际页面公司", "login_mode": "auto"})
    assert not result["success"]
    assert "settings changed during login" in result["error"]["message"]
    call.assert_not_called()


@pytest.mark.parametrize("extra", [{"page": True}, {"page": 0}, {"expected_warehouse": "invalid"}, {"login_mode": "other"}])
def test_invalid_query_parameters_never_start_login(account, monkeypatch, extra):
    profile = account()
    authenticate = Mock(side_effect=AssertionError("must not login"))
    monkeypatch.setattr(query, "ensure_login", authenticate)
    result = query.run({"profile_id": profile["profile_id"], "fba": "FBA19SS5YN6R", "store_id": "store", "login_mode": "auto", **extra})
    assert not result["success"]
    authenticate.assert_not_called()


def test_cli_unified_public_route_does_not_require_browser_or_login(account, monkeypatch, capsys):
    from lxeskill import cli
    profile = account("jiufang")
    monkeypatch.delenv("LXE_AGENT_SESSION_ID")
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "jiufang-logistics-query")
    monkeypatch.setattr(query.jiufang_query, "run", Mock(return_value={"success": True, "request_succeeded": True, "found": True}))
    assert cli.main(["logistics", "query", "--profile-id", profile["profile_id"], "--fba", "FBA19SS5YN6R"]) == 0
    import json
    output = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert output["ok"] and output["data"]["result"]["found"]
    assert cli.main(["logistics", "login", "--profile-id", profile["profile_id"], "--store-id", "store"]) != 0
