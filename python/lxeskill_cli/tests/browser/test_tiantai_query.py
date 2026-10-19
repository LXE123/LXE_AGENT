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
from services.agent_cli.logistics import tiantai_query as tiantai


FBA = "FBA15MPDN5VF"
ACCOUNT = "深圳市雷袖尔科技有限公司"
ARGS = {"store_id": "test-store", "fba": FBA, "account_name": ACCOUNT}


@pytest.fixture
def provider_response():
    path = Path(__file__).parent / "fixtures/tiantai_shipment_list.json"
    return json.loads(path.read_text(encoding="utf-8"))


def projection(payload):
    grid = payload["data"]["components"]["gridView"]
    table = grid["table"]
    return {
        "http_status": 200,
        "account_visible": True,
        "content_type": "application/json",
        "business_success": payload["success"],
        "info": payload["info"],
        "error_code": payload["errorCode"],
        "errors": payload["errors"],
        "list_present": True,
        "rows": table["dataSource"],
        "row_count": len(table["dataSource"]),
        "pagination": table["pagination"],
        "tabs": grid["tabs"],
    }


def parsed(response, **overrides):
    return tiantai.parse_result(response, tiantai._validate({**ARGS, **overrides}))


def test_real_response_exact_match_preserves_observed_limits(provider_response):
    result = parsed(projection(provider_response), expected_warehouse="FRA7")
    assert result["success"] and result["request_succeeded"] and result["found"]
    assert result["complete"] and result["all_tab_confirmed"]
    assert result["pagination"] == {"page": 1, "pageSize": 30, "total": 1}
    match, = result["matches"]
    assert match["fba_numbers"] == [FBA]
    assert match["shipment_number"] == "TAI10727074"
    assert match["service"] == "欧洲空派递延-带D"
    assert match["destination_name"] == "Amazon"
    assert match["destination_country"] == "德国\n02977"
    assert match["parcel_count"] == 2
    assert match["depot"] == "龙华仓"
    assert match["warehouse"] is None and match["warehouse_matches"] is None
    assert match["carrier"] is None and match["tracking_numbers"] == []
    assert match["carrier_source_text"] == "--" and match["eta"] is None
    assert match["created"] == 1792228874
    assert match["missing_fields"] == ["warehouse", "carrier", "tracking_numbers", "eta"]
    assert match["warnings"] == ["warehouse_not_returned"]


def test_all_payload_matches_captured_contract():
    assert tiantai.request_payload(FBA) == {
        "timeLimit": 0,
        "page": 1,
        "activeTab": "all",
        "keywords": FBA,
        "isActiveTab": "in_transit",
        "init": 1,
        "scenes": 0,
    }
    assert tiantai.request_payload(FBA, 3)["page"] == 3


@pytest.mark.parametrize("suffix", ["U000001", "9", "X"])
def test_never_strips_or_prefix_matches_box_identifiers(provider_response, suffix):
    response = projection(provider_response)
    response["rows"][0]["shipment_id"] = FBA + suffix
    assert parsed(response)["status"] == "not_found_unverified"
    assert parsed(response, fba=FBA + suffix)["found"] is True


def test_future_carrier_text_is_preserved_without_unverified_parsing(provider_response):
    response = projection(provider_response)
    response["rows"][0]["outer_carrier"] = "UPS<br/>1ZUNVERIFIED123"
    match, = parsed(response)["matches"]
    assert match["carrier"] is None and match["tracking_numbers"] == []
    assert match["carrier_source_text"] == "UPS\n1ZUNVERIFIED123"
    assert match["warnings"] == ["tracking_layout_unverified_for_tiantai"]


def test_future_explicit_warehouse_can_be_compared(provider_response):
    response = projection(provider_response)
    response["rows"][0]["to_warehouse_code"] = "FRA7"
    match, = parsed(response, expected_warehouse="FRA7")["matches"]
    assert match["warehouse"] == "FRA7" and match["warehouse_matches"] is True
    response["rows"][0]["to_warehouse_code"] = "LEJ5"
    match, = parsed(response, expected_warehouse="FRA7")["matches"]
    assert match["warehouse_matches"] is False and "warehouse_mismatch" in match["warnings"]


def test_string_parcel_count_is_retained_as_text(provider_response):
    response = projection(provider_response)
    response["rows"][0]["parcel_count"] = "<strong>2/2</strong>"
    match, = parsed(response)["matches"]
    assert match["parcel_count"] == "2/2"


def test_invalid_business_field_reports_actual_shape(provider_response):
    response = projection(provider_response)
    response["rows"][0]["parcel_count"] = {"unexpected": 2}
    result = parsed(response)
    assert not result["success"] and result["error"]["code"] == "invalid_shipment"
    assert "parcel_count" in result["error"]["message"]


def test_empty_and_partial_results_are_not_overstated(provider_response):
    response = projection(provider_response)
    response.update(rows=[], row_count=0)
    response["pagination"].update(total=0)
    result = parsed(response)
    assert result["success"] and result["status"] == "not_found_unverified"
    assert result["warnings"] == ["empty_result_unverified"]
    response["pagination"].update(total=31)
    result = parsed(response)
    assert result["status"] == "not_found_on_page" and not result["complete"]
    assert result["warnings"] == ["partial_page; other pages were not queried"]


def test_non_all_response_keeps_query_success_but_warns(provider_response):
    response = projection(provider_response)
    response["tabs"]["activeTab"] = "picked"
    result = parsed(response)
    assert result["success"] and result["found"] and not result["all_tab_confirmed"]
    assert "returned_active_tab_not_all; cross-status coverage unverified" in result["warnings"]


@pytest.mark.parametrize("update,code", [
    ({"http_status": 401, "info": "实际未授权"}, "http_error"),
    ({"business_success": 0, "info": "实际登录过期"}, "provider_error"),
    ({"business_success": True}, "provider_error"),
    ({"error_code": "ACTUAL_PROVIDER_CODE"}, "provider_error"),
    ({"errors": ["actual provider error"]}, "provider_error"),
    ({"list_present": False}, "invalid_list"),
    ({"invalid_row": True}, "invalid_list"),
    ({"pagination": None}, "invalid_pagination"),
    ({"fields_truncated": True}, "truncated_response"),
    ({"response_truncated": True}, "truncated_response"),
])
def test_failure_shapes_never_become_success(provider_response, update, code):
    result = parsed({**projection(provider_response), **update})
    assert not result["success"] and not result["request_succeeded"]
    assert result["error"]["code"] == code
    assert result["auth_refresh_required"] is False


@pytest.mark.parametrize("update", [
    {"url": "https://other.test"},
    {"script": "fetch('/write')"},
    {"password": "no"},
    {"fba": FBA + ",FBAOTHER123"},
    {"fba": FBA.lower()},
    {"page": 0},
    {"page": True},
    {"page": "2"},
    {"expected_warehouse": "bad code"},
    {"account_name": ""},
    {"store_id": ""},
])
def test_invalid_arguments_fail_before_browser(monkeypatch, update):
    monkeypatch.setattr(tiantai, "store_driver_session", lambda *a, **k: pytest.fail("must not attach"))
    result = tiantai.run({**ARGS, **update})
    assert result["success"] is False and result["error"]["message"]


def test_missing_session_fails_without_attaching(monkeypatch):
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)
    monkeypatch.setattr(tiantai, "store_driver_session", lambda *a, **k: pytest.fail("must not attach"))
    result = tiantai.run(ARGS)
    assert not result["success"] and "LXE_AGENT_SESSION_ID" in result["error"]["message"]


def fake_session(monkeypatch, response, *, origin=tiantai.ORIGIN, failure=None):
    calls = []
    driver = SimpleNamespace(
        current_url=origin + "/tms/wos/shipment?private=abc",
        switch_to=SimpleNamespace(default_content=lambda: None),
    )
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

    monkeypatch.setattr(tiantai, "store_driver_session", attach)
    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "unit-test-session")
    return calls


def test_repeated_calls_strictly_attach_and_do_not_navigate_or_retry(monkeypatch, provider_response):
    calls = fake_session(monkeypatch, projection(provider_response))
    first, second = tiantai.run(ARGS), tiantai.run(ARGS)
    assert first["success"] and second["success"] and first["matches"] == second["matches"]
    assert first["queried_at"].endswith("+00:00")
    assert first["page_url"] == tiantai.ORIGIN + "/tms/wos/shipment"
    assert first["account_name"] == ACCOUNT
    assert calls[0] == ("attach", "test-store", {"strict_attach": True, "target_host": tiantai.HOST})
    assert len([call for call in calls if call[0] == "query"]) == 2
    assert calls[2][2] == tiantai.request_payload(FBA)


def test_wrong_origin_cannot_receive_request(monkeypatch, provider_response):
    calls = fake_session(monkeypatch, projection(provider_response), origin="http://ttaiex.nextsls.com.evil.test")
    result = tiantai.run(ARGS)
    assert not result["success"] and not any(call[0] == "query" for call in calls)


def test_actual_driver_error_is_preserved_and_redacted(monkeypatch, provider_response):
    error = RuntimeError("attach wrapper")
    error.__cause__ = ValueError("actual chromedriver failure token=private-token")
    calls = fake_session(monkeypatch, projection(provider_response), failure=error)
    result = tiantai.run(ARGS)
    assert "actual chromedriver failure" in result["error"]["message"]
    assert "private-token" not in result["error"]["message"]
    assert len([call for call in calls if call[0] == "query"]) == 1


def test_cli_dispatch(monkeypatch, provider_response, capsys):
    fake_session(monkeypatch, projection(provider_response))
    argv = ["logistics", "tiantai", "query", "--store-id", "test-store", "--fba", FBA,
            "--account-name", ACCOUNT]
    assert cli.main(argv) == 0
    result = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert result["ok"] and result["data"]["found"]


def test_actual_browser_script_uses_fixed_request_and_bounded_projection(provider_response):
    bun = shutil.which("bun")
    assert bun, "Bun is required to exercise the actual adapter JavaScript"
    script = r"""
const input = await Bun.stdin.json();
const results = [];
for (const scenario of input.scenarios) {
  globalThis.location = {origin: scenario.origin || 'http://ttaiex.nextsls.com'};
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
    provider_response["token"] = "must-not-export-token"
    row = provider_response["data"]["components"]["gridView"]["table"]["dataSource"][0]
    row["private_auth"] = "must-not-export-auth"
    scenarios = [
        {},
        {"origin": "http://other.test"},
        {"accountMissing": True},
        {"networkError": True},
        {"body": "<html>actual login page</html>", "contentType": "text/html"},
        {"body": "[]"},
        {"body": "x" * (2097152 + 1)},
        {"status": 403, "body": '{"success":0,"info":"actual forbidden"}'},
    ]
    oversized = copy.deepcopy(provider_response)
    oversized["data"]["components"]["gridView"]["table"]["dataSource"][0]["shipment_id"] = "x" * 8001 + FBA
    scenarios.append({"body": json.dumps(oversized)})
    process = subprocess.run(
        [bun, "-e", script],
        input=json.dumps({"script": tiantai.QUERY_SCRIPT, "payload": tiantai.request_payload(FBA),
                          "fixture": provider_response, "account": ACCOUNT, "scenarios": scenarios}),
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )
    assert process.returncode == 0, process.stderr
    outputs = json.loads(process.stdout)
    assert parsed(outputs[0]["result"])["matches"][0]["shipment_number"] == "TAI10727074"
    assert outputs[0]["calls"] == [{
        "url": tiantai.PATH,
        "method": "POST",
        "credentials": "same-origin",
        "redirect": "error",
        "headers": {"Content-Type": "application/json;charset=utf-8"},
        "body": tiantai.request_payload(FBA),
    }]
    assert "must-not-export" not in json.dumps(outputs)
    for index, code in [(1, "origin_mismatch"), (2, "account_not_visible"), (3, "request_failed"),
                        (4, "invalid_json"), (5, "invalid_response"), (6, "response_too_large")]:
        assert outputs[index]["result"]["error"]["code"] == code
        assert not parsed(outputs[index]["result"])["success"]
    assert not outputs[1]["calls"] and not outputs[2]["calls"]
    forbidden = parsed(outputs[7]["result"])
    assert forbidden["http_status"] == 403 and "actual forbidden" in forbidden["error"]["message"]
    assert outputs[8]["result"]["fields_truncated"] is True
    assert parsed(outputs[8]["result"])["error"]["code"] == "truncated_response"
