from __future__ import annotations

import copy
from contextlib import contextmanager
import json
from pathlib import Path
import shutil
import subprocess
from types import SimpleNamespace

import pytest

from lxeskill import cli
from services.agent_cli.logistics import wesa_query as wesa

FBA = "FBA19PWM5L6T"
ACCOUNT = "深圳市新棱镜贸易有限公司"
ARGS = {"store_id": "test-store", "fba": FBA, "account_name": ACCOUNT, "expected_warehouse": "PSP3"}


@pytest.fixture
def provider_response():
    return json.loads((Path(__file__).parent / "fixtures/wesa_shipment_list.json").read_text(encoding="utf-8"))


def projection(payload):
    """Python tests consume the same bounded contract as the browser adapter.

    The actual JS-to-fixture projection is checked separately below.
    """
    grid = payload["data"]["components"]["gridView"]
    table = grid["table"]
    return {"http_status": 200, "account_visible": True, "content_type": "application/json",
        "business_success": payload["success"], "info": payload["info"],
        "error_code": payload["errorCode"], "errors": payload["errors"],
        "list_present": True, "rows": table["dataSource"], "row_count": len(table["dataSource"]),
        "pagination": table["pagination"], "tabs": grid["tabs"]}


def parsed(response, **overrides):
    return wesa.parse_result(response, wesa._validate({**ARGS, **overrides}))


def test_real_response_exact_match(provider_response):
    result = parsed(projection(provider_response))
    assert result["success"] and result["request_succeeded"] and result["found"]
    assert result["complete"] and result["all_tab_confirmed"]
    assert result["pagination"] == {"page": 1, "pageSize": 30, "total": 1}
    assert result["matched_count"] == 1
    match, = result["matches"]
    assert match["fba_numbers"] == [FBA]
    assert match["shipment_number"] == "WS10026638"
    assert match["warehouse"] == "PSP3" and match["warehouse_matches"] is True
    assert match["carrier"] == "UPS"
    assert match["tracking_numbers"] == ["1ZK1013D0321365378"]
    assert match["parcel_count"] == "1/1"
    assert match["source_text"]["outer_carrier"] == "UPS\n1ZK1013D0321365378"
    assert match["source_html"]["outer_carrier"] == provider_response["data"]["components"]["gridView"]["table"]["dataSource"][0]["outer_carrier"]
    assert match["missing_fields"] == match["warnings"] == []
    assert "eta" not in match and "created" not in match


@pytest.mark.parametrize("suffix", ["U000001", "9", "X"])
def test_never_strips_box_suffix_or_prefix_matches(provider_response, suffix):
    response = projection(provider_response)
    response["rows"][0]["shipment_id"] = FBA + suffix
    assert parsed(response)["status"] == "not_found"
    assert parsed(response, fba=FBA + suffix)["found"] is True


def test_multiple_rows_and_multiple_numbers_preserved(provider_response):
    response = projection(provider_response)
    row = response["rows"][0]
    row["outer_carrier"] += "<br/>1ZSECOND123<br/>1ZK1013D0321365378"
    response["rows"].append(copy.deepcopy(row))
    response["pagination"]["total"] = 2
    response["row_count"] = 2
    result = parsed(response)
    assert result["matched_count"] == 2
    assert "multiple_matching_rows" in result["warnings"]
    assert result["matches"][0]["tracking_numbers"] == ["1ZK1013D0321365378", "1ZSECOND123"]


def test_missing_fields_and_warehouse_conflict_do_not_disappear(provider_response):
    response = projection(provider_response)
    response["rows"][0]["outer_carrier"] = ""
    result = parsed(response, expected_warehouse="SMF2")
    assert result["success"] and result["found"]
    match, = result["matches"]
    assert match["warehouse_matches"] is False
    assert "warehouse_mismatch" in match["warnings"]
    assert match["missing_fields"] == ["carrier", "tracking_numbers"]


def test_unknown_carrier_layout_retains_source_without_guessing(provider_response):
    response = projection(provider_response)
    response["rows"][0]["outer_carrier"] = "DHL/UPS<br/>Tracking: unknown"
    match, = parsed(response)["matches"]
    assert match["carrier"] == "DHL/UPS"
    assert match["tracking_numbers"] == []
    assert "carrier_layout_unrecognized" in match["warnings"]
    assert "Tracking: unknown" in match["source_text"]["outer_carrier"]


@pytest.mark.parametrize("rows,total,page,expected_status", [([], 0, 1, "not_found"), ([], 32, 1, "not_found_on_page"), ([], 32, 2, "not_found_on_page")])
def test_zero_results_and_partial_pages_are_distinct(provider_response, rows, total, page, expected_status):
    response = projection(provider_response)
    response.update(rows=rows, row_count=0)
    response["pagination"].update(page=page, total=total)
    result = parsed(response, page=page)
    assert result["success"] and not result["found"]
    assert result["status"] == expected_status
    assert result["complete"] is (total == 0 and page == 1)


def test_active_tab_alone_does_not_determine_query_success(provider_response):
    response = projection(provider_response)
    response["tabs"]["activeTab"] = "delivered"
    result = parsed(response)
    assert result["success"] and result["found"] and not result["all_tab_confirmed"]
    assert result["warnings"]


@pytest.mark.parametrize("update,code", [
    ({"http_status": 401, "info": "实际未授权"}, "http_error"),
    ({"http_status": 403, "info": "实际权限错误"}, "http_error"),
    ({"business_success": 0, "info": "实际登录过期"}, "provider_error"),
    ({"business_success": True}, "provider_error"),
    ({"error_code": "ACTUAL_PROVIDER_CODE"}, "provider_error"),
    ({"errors": ["actual provider error"]}, "provider_error"),
    ({"list_present": False}, "invalid_list"),
    ({"invalid_row": True}, "invalid_list"),
    ({"pagination": None}, "invalid_pagination"),
    ({"pagination": {"page": 2, "pageSize": 30, "total": 1}}, "invalid_pagination"),
    ({"pagination": {"page": 1, "pageSize": 30, "total": "1"}}, "invalid_pagination"),
    ({"fields_truncated": True}, "truncated_response"),
    ({"response_truncated": True}, "truncated_response"),
])
def test_failure_shapes_never_become_success(provider_response, update, code):
    result = parsed({**projection(provider_response), **update})
    assert not result["success"] and not result["request_succeeded"]
    assert result["error"]["code"] == code
    assert result["auth_refresh_required"] is False


def test_error_preview_strips_hidden_credentials_and_keeps_real_text(provider_response, monkeypatch):
    monkeypatch.setenv("TEST_SECRET", "environment-secret")
    result = parsed({**projection(provider_response), "error": {"code": "invalid_json", "message": "SyntaxError: bad JSON"},
        "body_preview": '<html><input name="token" value="hidden-secret"><script>var token="script-secret"</script>实际请登录 password=shown-secret environment-secret</html>'})
    text = json.dumps(result, ensure_ascii=False)
    assert "SyntaxError: bad JSON" in text and "实际请登录" in text
    for secret in ("hidden-secret", "script-secret", "shown-secret", "environment-secret"):
        assert secret not in text


def test_diagnostics_redact_before_truncating():
    assert "[truncated]" in wesa.diagnostic("actual failure " + "x" * 3000)
    assert "secret" not in wesa.diagnostic("https://user:secret@example.com/path?token=abc#fragment")
    assert "example.com/path" in wesa.diagnostic("https://user:secret@example.com/path?token=abc#fragment")


def test_evidence_output_does_not_export_embedded_secrets():
    safe = wesa._safe_output({"source_html": {"shipment_id": '<span>FBA1234567</span><input value="hidden-auth"><script>secret material</script>'}})
    text = json.dumps(safe)
    assert "FBA1234567" in text
    assert "hidden-auth" not in text and "secret material" not in text


@pytest.mark.parametrize("update", [
    {"url": "https://other.test"}, {"script": "fetch('/write')"}, {"password": "no"},
    {"fba": FBA + ",FBAOTHER123"}, {"fba": FBA.lower()}, {"query_mode": "picked"},
    {"page": 0}, {"page": True}, {"page": "2"}, {"expected_warehouse": "bad code"},
    {"account_name": ""}, {"store_id": ""},
])
def test_invalid_arguments_fail_before_browser(monkeypatch, update):
    def forbidden(*args, **kwargs):
        pytest.fail("invalid input must not attach or request")
    monkeypatch.setattr(wesa, "store_driver_session", forbidden)
    result = wesa.run({**ARGS, **update})
    assert result["success"] is False and result["error"]["message"]


def test_missing_session_fails_without_attaching(monkeypatch):
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)
    monkeypatch.setattr(wesa, "store_driver_session", lambda *a, **k: pytest.fail("must not attach"))
    result = wesa.run(ARGS)
    assert not result["success"] and "LXE_AGENT_SESSION_ID" in result["error"]["message"]


def test_cli_requires_real_session_and_scope(monkeypatch, capsys):
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)
    argv = ["logistics", "wesa", "query", "--store-id", "test-store", "--fba", FBA, "--account-name", ACCOUNT]
    assert cli.main(argv) == cli.EXIT_ENVIRONMENT
    assert json.loads(capsys.readouterr().out)["error"]["code"] == "session_required"
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "fba-shipment-delivery-window")
    assert cli.main(argv) == cli.EXIT_ENVIRONMENT
    assert json.loads(capsys.readouterr().out)["error"]["code"] == "skill_not_in_scope"


def fake_session(monkeypatch, response, *, origin=wesa.ORIGIN, failure=None):
    calls = []
    driver = SimpleNamespace(current_url=origin + "/tms/wos/shipment?private=abc", switch_to=SimpleNamespace(default_content=lambda: None))
    driver.set_script_timeout = lambda seconds: calls.append(("timeout", seconds))

    def execute(script, payload, account_name):
        calls.append(("query", script, json.loads(payload), account_name))
        if failure:
            raise failure
        return copy.deepcopy(response)

    driver.execute_async_script = execute

    @contextmanager
    def attach(store_id, **kwargs):
        calls.append(("attach", store_id, kwargs))
        yield SimpleNamespace(browser_name="fixture store"), driver

    monkeypatch.setattr(wesa, "store_driver_session", attach)
    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "unit-test-session")
    return calls


def test_repeated_calls_strictly_attach_and_never_navigate_or_retry(monkeypatch, provider_response):
    calls = fake_session(monkeypatch, projection(provider_response))
    first, second = wesa.run(ARGS), wesa.run(ARGS)
    assert first["success"] and second["success"]
    assert first["matches"] == second["matches"]
    assert first["queried_at"].endswith("+00:00")
    assert first["page_url"] == wesa.ORIGIN + "/tms/wos/shipment"
    assert first["account_name"] == ACCOUNT
    assert calls[0] == ("attach", "test-store", {"strict_attach": True, "target_host": wesa.HOST})
    assert len([call for call in calls if call[0] == "query"]) == 2
    assert calls[2][2] == {"timeLimit": 0, "page": 1, "activeTab": "all", "keywords": FBA, "isActiveTab": "delivered", "init": 1, "scenes": 0}


def test_wrong_origin_cannot_receive_request(monkeypatch, provider_response):
    calls = fake_session(monkeypatch, projection(provider_response), origin="http://wsaexp.nextsls.com.evil.test")
    result = wesa.run(ARGS)
    assert not result["success"]
    assert not any(call[0] == "query" for call in calls)


def test_actual_driver_error_and_cause_preserved_without_retry(monkeypatch, provider_response):
    error = RuntimeError("attach wrapper")
    error.__cause__ = ValueError("actual chromedriver failure token=private-token")
    calls = fake_session(monkeypatch, projection(provider_response), failure=error)
    result = wesa.run(ARGS)
    assert "actual chromedriver failure" in result["error"]["message"]
    assert "private-token" not in result["error"]["message"]
    assert len([call for call in calls if call[0] == "query"]) == 1


def test_cli_dispatch_and_failure_recovery(monkeypatch, provider_response, capsys):
    fake_session(monkeypatch, projection(provider_response))
    argv = ["logistics", "wesa", "query", "--store-id", "test-store", "--fba", FBA, "--account-name", ACCOUNT, "--expected-warehouse", "PSP3"]
    assert cli.main(argv) == 0
    result = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert result["ok"] and result["data"]["found"]
    response = {"http_status": 401, "error": {"code": "request_failed", "message": "实际登录失败"}}
    fake_session(monkeypatch, response)
    assert cli.main(argv) == cli.EXIT_BUSINESS
    result = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert not result["ok"] and "实际登录失败" in result["error"]["message"]
    assert "recovery" not in result  # never refresh unrelated Mabang authentication


def test_delivered_payload_matches_captured_contract():
    payload = wesa.request_payload(FBA, "delivered")
    assert payload == {"timeLimit": 0, "page": 1, "pageSize": 30, "keywords": FBA,
        "isActiveTab": "delivered", "service": "", "btnType": "", "config": "", "country": "",
        "created_daterange": "", "def_fields": "", "delivered_daterange": "", "depot_id": "", "name": "",
        "picking_daterange": "", "pickup_depot_id": "", "postcode": "", "restart": 0, "scenes": 0,
        "store_id": "", "to_warehouse_code": ""}


def test_actual_browser_script_with_real_response_and_network_failure_cases(provider_response):
    bun = shutil.which("bun")
    assert bun, "Bun is required to exercise the actual adapter JavaScript"
    script = r"""
const input = await Bun.stdin.json();
const results = [];
for (const scenario of input.scenarios) {
  globalThis.location = {origin: scenario.origin || 'http://wsaexp.nextsls.com'};
  globalThis.document = {body: {innerText: scenario.accountMissing ? 'other company' : input.account}};
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({url, method: options.method, credentials: options.credentials, redirect: options.redirect,
      headers: options.headers, body: JSON.parse(options.body)});
    if (scenario.networkError) throw new TypeError('actual network failure');
    return new Response(scenario.body === undefined ? JSON.stringify(input.fixture) : scenario.body,
      {status: scenario.status || 200, headers: {'Content-Type': scenario.contentType || 'application/json'}});
  };
  const result = await new Promise(resolve => new Function(input.script)(JSON.stringify(input.payload), input.account, resolve));
  results.push({calls, result});
}
process.stdout.write(JSON.stringify(results));
"""
    # Extra unknown/configuration/auth fields must not leave browser projection.
    provider_response["token"] = "must-not-export-token"
    row = provider_response["data"]["components"]["gridView"]["table"]["dataSource"][0]
    row["private_auth"] = "must-not-export-auth"
    scenarios = [{}, {"origin": "http://other.test"}, {"accountMissing": True},
        {"networkError": True}, {"body": "<html>actual login page</html>", "contentType": "text/html"},
        {"body": "[]"}, {"body": "x" * (2097152 + 1)},
        {"status": 403, "body": '{"success":0,"info":"actual forbidden"}'}]
    oversized_field = copy.deepcopy(provider_response)
    oversized_field["data"]["components"]["gridView"]["table"]["dataSource"][0]["shipment_id"] = "x" * 8001 + FBA
    scenarios.append({"body": json.dumps(oversized_field)})
    process = subprocess.run([bun, "-e", script], input=json.dumps({"script": wesa.QUERY_SCRIPT,
        "payload": wesa.request_payload(FBA), "fixture": provider_response, "account": ACCOUNT,
        "scenarios": scenarios}), capture_output=True, text=True, timeout=15, check=False)
    assert process.returncode == 0, process.stderr
    outputs = json.loads(process.stdout)
    assert len(outputs) == len(scenarios)
    assert parsed(outputs[0]["result"])["matches"][0]["shipment_number"] == "WS10026638"
    assert outputs[0]["calls"] == [{"url": wesa.PATH, "method": "POST", "credentials": "same-origin", "redirect": "error",
        "headers": {"Content-Type": "application/json;charset=utf-8"}, "body": wesa.request_payload(FBA)}]
    assert "must-not-export" not in json.dumps(outputs)
    for index, code in [(1, "origin_mismatch"), (2, "account_not_visible"), (3, "request_failed"), (4, "invalid_json"), (5, "invalid_response"), (6, "response_too_large")]:
        assert outputs[index]["result"]["error"]["code"] == code
        assert not parsed(outputs[index]["result"])["success"]
    assert not outputs[1]["calls"] and not outputs[2]["calls"]
    forbidden = parsed(outputs[7]["result"])
    assert forbidden["http_status"] == 403
    assert "actual forbidden" in forbidden["error"]["message"]
    assert outputs[8]["result"]["fields_truncated"] is True
    assert parsed(outputs[8]["result"])["error"]["code"] == "truncated_response"
