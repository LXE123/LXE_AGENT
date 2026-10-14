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
from services.agent_cli.logistics import feiwo_query as feiwo

FBA = "FBA191GB5WTM"
ARGS = {"store_id": "test-store", "fba": FBA}


@pytest.fixture
def provider_response():
    return json.loads((Path(__file__).parent / "fixtures/feiwo_tracking.json").read_text(encoding="utf-8"))


def projection(payload):
    shipment = payload["data"]["shipment"]
    return {"http_status": 200, "content_type": "application/json", "business_status": payload["status"],
        "info": payload["info"], "provider_request_time": payload["request_time"],
        "shipment_present": True, "shipment": {key: shipment[key] for key in feiwo.SHIPMENT_FIELDS},
        "traces": shipment["traces"], "trace_count": len(shipment["traces"])}


def test_real_response_exact_match_preserves_limits_and_raw_tracking(provider_response):
    result = feiwo.parse_result(projection(provider_response), {**ARGS, "expected_warehouse": "TEST1"})
    assert result["success"] and result["request_succeeded"] and result["found"] and result["complete"]
    assert result["matched_count"] == 1
    assert result["provider_request_time"] == "2026-10-14 09:23:21"
    match, = result["matches"]
    assert match["fba_numbers"] == [FBA]
    assert match["shipment_number"] == "WEB25098791"
    assert match["carrier"] == "FEDEX"
    assert match["tracking_numbers"] == ["884661650703"]
    assert match["source_fields"]["outer_carrier_tracking_number"] == "FEDEX 884661650703"
    assert match["shipment_status"] == "delivered" and match["parcel_count"] == 1
    assert match["warehouse"] is None and match["warehouse_matches"] is None
    assert match["postcode"] == "77032" and "warehouse" in match["missing_fields"]
    assert match["eta"] is None and match["trace_timezone"] is None
    assert "expected_warehouse_not_verified" in match["warnings"]
    # No inferred ETA from port text, or delivery time from the latest trace.
    assert result["trace_count"] == 14
    assert match["traces"] == provider_response["data"]["shipment"]["traces"]
    assert match["traces"][0]["time"] == "2025-10-18 19:51:00"
    assert match["traces"][1] == {"time": "2025-10-18 13:00:00", "info": "Delivered Houston, TX, US"}
    assert "delivered_at" not in match
    assert any("预计" in trace["info"] for trace in match["traces"])


@pytest.mark.parametrize("suffix", ["U000001", "9", "X"])
def test_complete_fba_must_match_without_stripping_suffix(provider_response, suffix):
    response = projection(provider_response)
    response["shipment"]["ext_number"] = FBA + suffix
    result = feiwo.parse_result(response, ARGS)
    assert result["request_succeeded"] and not result["success"] and not result["found"]
    assert result["error"]["code"] == "identity_mismatch"
    assert result["matches"] == []
    assert feiwo.parse_result(response, {**ARGS, "fba": FBA + suffix})["found"]


@pytest.mark.parametrize("update,code", [
    ({"http_status": 403, "info": "actual forbidden"}, "http_error"),
    ({"http_status": None}, "http_error"),
    ({"business_status": 0, "info": "实际查询失败"}, "provider_error"),
    ({"business_status": True}, "provider_error"),
    ({"business_status": "1"}, "provider_error"),
    ({"shipment_present": False, "shipment": None}, "invalid_shipment"),
    ({"shipment": []}, "invalid_shipment"),
    ({"traces": None}, "invalid_traces"),
    ({"traces": [{"time": 123, "info": "actual event"}]}, "invalid_traces"),
    ({"traces": [{"time": "", "info": {"unexpected": "object"}}]}, "invalid_traces"),
    ({"response_truncated": True}, "truncated_response"),
    ({"fields_truncated": True}, "truncated_response"),
    ({"traces_truncated": True}, "truncated_response"),
])
def test_failures_never_become_not_found_or_success(provider_response, update, code):
    result = feiwo.parse_result({**projection(provider_response), **update}, ARGS)
    assert not result["success"] and not result["found"] and not result["complete"]
    assert result["error"]["code"] == code
    assert result["auth_refresh_required"] is False
    if "info" in update:
        assert update["info"] in result["error"]["message"]


@pytest.mark.parametrize("field,value", [
    ("ext_number", None), ("ext_number", "not an FBA"), ("ext_number", FBA.lower()),
    ("shipment_id", {"invalid_type": "object"}), ("outer_carrier_code", False),
    ("parcel_count", True), ("parcel_count", -1), ("parcel_count", "1"),
])
def test_malformed_shipment_fields_fail(provider_response, field, value):
    response = projection(provider_response)
    response["shipment"][field] = value
    assert feiwo.parse_result(response, ARGS)["error"]["code"] == "invalid_shipment"


@pytest.mark.parametrize("carrier,raw,numbers", [
    ("FEDEX", "884661650703", ["884661650703"]),
    ("FEDEX", "FedEx 884661650703", ["884661650703"]),
    ("FEDEX", "UPS 884661650703", []),
    ("FEDEX", "FEDEX 884661650703, 884661650704", []),
    ("", "FEDEX 884661650703", []),
    ("FEDEX", "", []),
])
def test_unrecognized_tracking_preserves_source_without_guessing(provider_response, carrier, raw, numbers):
    response = projection(provider_response)
    response["shipment"].update(outer_carrier_code=carrier, outer_carrier_tracking_number=raw, parcel_count=2)
    response["traces"] = []
    result = feiwo.parse_result(response, ARGS)
    assert result["success"] and result["found"]
    match, = result["matches"]
    assert match["tracking_numbers"] == numbers
    assert match["source_fields"]["outer_carrier_tracking_number"] == raw
    assert any("multiple_parcels" in warning for warning in match["warnings"])
    assert ("tracking_numbers" in match["missing_fields"]) is (not bool(numbers))


@pytest.mark.parametrize("update", [
    {"url": "https://other.test"}, {"method": "POST"}, {"script": "fetch('/write')"},
    {"cookie": "private"}, {"account_name": "unverified"}, {"fba": FBA + ",FBAOTHER123"},
    {"fba": FBA.lower()}, {"fba": "FBA" + "X" * 100},
    {"store_id": ""}, {"fba": ""}, {"expected_warehouse": "invalid code"},
])
def test_invalid_input_cannot_attach_or_request(monkeypatch, update):
    monkeypatch.setattr(feiwo, "store_driver_session", lambda *a, **k: pytest.fail("must not attach"))
    result = feiwo.run({**ARGS, **update})
    assert not result["success"] and result["error"]["message"]


def test_missing_session_cannot_attach(monkeypatch):
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)
    monkeypatch.setattr(feiwo, "store_driver_session", lambda *a, **k: pytest.fail("must not attach"))
    result = feiwo.run(ARGS)
    assert not result["success"] and "LXE_AGENT_SESSION_ID" in result["error"]["message"]


def fake_session(monkeypatch, response, *, url=feiwo.ORIGIN + feiwo.PATH + "#/tracking?numbers=" + FBA, failure=None):
    calls = []
    driver = SimpleNamespace(current_url=url, switch_to=SimpleNamespace(default_content=lambda: None))
    driver.set_script_timeout = lambda seconds: calls.append(("timeout", seconds))

    def execute(script, fba):
        calls.append(("query", script, fba))
        if failure:
            raise failure
        return copy.deepcopy(response)

    driver.execute_async_script = execute

    @contextmanager
    def attach(store_id, **kwargs):
        calls.append(("attach", store_id, kwargs))
        yield SimpleNamespace(browser_name="fixture store"), driver

    monkeypatch.setattr(feiwo, "store_driver_session", attach)
    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "unit-test-session")
    return calls


def test_repeated_calls_strictly_attach_once_and_preserve_query_contract(monkeypatch, provider_response):
    calls = fake_session(monkeypatch, projection(provider_response))
    first, second = feiwo.run(ARGS), feiwo.run(ARGS)
    assert first["success"] and second["success"] and first["matches"] == second["matches"]
    assert first["queried_at"] != second["queried_at"]
    assert first["queried_at"].endswith("+00:00")
    assert first["provider_request_time"] == "2026-10-14 09:23:21"
    assert first["source"] == {"url": feiwo.ORIGIN + feiwo.PATH, "method": "GET", "query": {"inajax": "1", "tracking_number": FBA}}
    assert first["page_url"] == feiwo.ORIGIN + feiwo.PATH
    assert calls[0] == ("attach", "test-store", {"strict_attach": True, "target_host": feiwo.HOST})
    assert len([call for call in calls if call[0] == "query"]) == 2


@pytest.mark.parametrize("url", [
    "http://feichi.nextsls.com.evil.test/tracking/app", "https://feichi.nextsls.com/tracking/app",
    "http://feichi.nextsls.com/other", "http://user:secret@feichi.nextsls.com/tracking/app",
    "http://feichi.nextsls.com:12334/tracking/app",
])
def test_wrong_page_never_requests(monkeypatch, provider_response, url):
    calls = fake_session(monkeypatch, projection(provider_response), url=url)
    assert not feiwo.run(ARGS)["success"]
    assert not any(call[0] == "query" for call in calls)


def test_actual_selenium_exception_and_cause_are_preserved_without_retry(monkeypatch, provider_response):
    error = RuntimeError("actual attach failure https://user:secret@feichi.nextsls.com/tracking/app?token=private")
    error.__cause__ = OSError("actual socket closed")
    calls = fake_session(monkeypatch, projection(provider_response), failure=error)
    result = feiwo.run(ARGS)
    assert not result["success"]
    message = result["error"]["message"]
    assert "actual attach failure" in message and "actual socket closed" in message
    assert "secret" not in message and "private" not in message
    assert len([call for call in calls if call[0] == "query"]) == 1


def test_cli_requires_scope_session_and_exposes_failure_details(monkeypatch, capsys, provider_response):
    argv = ["logistics", "feiwo", "query", "--store-id", "test-store", "--fba", FBA]
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)
    assert cli.main(argv) == cli.EXIT_ENVIRONMENT
    assert json.loads(capsys.readouterr().out)["error"]["code"] == "session_required"
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "fba-shipment-delivery-window")
    assert cli.main(argv) == cli.EXIT_ENVIRONMENT
    assert json.loads(capsys.readouterr().out)["error"]["code"] == "skill_not_in_scope"
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "fba-logistics-query")
    fake_session(monkeypatch, projection(provider_response))
    assert cli.main(argv) == 0
    assert json.loads(capsys.readouterr().out)["data"]["matches"][0]["tracking_numbers"] == ["884661650703"]
    fake_session(monkeypatch, {**projection(provider_response), "business_status": 0, "info": "实际查询失败"})
    assert cli.main(argv) != 0
    envelope = json.loads(capsys.readouterr().out)
    assert not envelope["ok"] and "实际查询失败" in envelope["error"]["message"]


def test_actual_browser_script_with_real_response_and_failure_cases(provider_response):
    bun = shutil.which("bun")
    assert bun, "Bun is required to exercise the actual adapter JavaScript"
    script = r"""
const input = await Bun.stdin.json();
const results = [];
for (const scenario of input.scenarios) {
  globalThis.location = {origin: scenario.origin || 'http://feichi.nextsls.com', pathname: scenario.path || '/tracking/app'};
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({url, method: options.method, credentials: options.credentials, redirect: options.redirect,
      headers: options.headers, body: options.body});
    if (scenario.networkError) throw new TypeError('actual network failure');
    return new Response(scenario.body === undefined ? JSON.stringify(input.fixture) : scenario.body,
      {status: scenario.status || 200, headers: {'Content-Type': scenario.contentType || 'application/json'}});
  };
  const result = await new Promise(resolve => new Function(input.script)(input.fba, resolve));
  results.push({calls, result});
}
process.stdout.write(JSON.stringify(results));
"""
    provider_response["token"] = "must-not-export-token"
    provider_response["data"]["shipment"]["private_auth"] = "must-not-export-auth"
    provider_response["data"]["shipment"]["traces"][0]["cookie"] = "must-not-export-cookie"
    scenarios = [{}, {"origin": "http://other.test"}, {"path": "/other"}, {"networkError": True},
        {"body": '<html><input value="hidden-secret">实际请登录<script>private-token</script></html>'},
        {"body": "[]"}, {"body": "x" * (2097152 + 1)},
        {"status": 403, "body": '{"status":0,"info":"actual forbidden"}'}]
    for target in ("ext_number", "trace_info", "trace_count", "info", "shipment_shape", "trace_shape"):
        body = copy.deepcopy(provider_response)
        if target == "ext_number":
            body["data"]["shipment"]["ext_number"] = FBA + "X" * 8000
        elif target == "trace_info":
            body["data"]["shipment"]["traces"][0]["info"] = "x" * 8001
        elif target == "trace_count":
            body["data"]["shipment"]["traces"] *= 20
        elif target == "info":
            body["info"] = "actual failure " + "x" * 8001
        elif target == "shipment_shape":
            body["data"]["shipment"] = []
        else:
            body["data"]["shipment"]["traces"][0]["time"] = {"token": "must-not-export-object"}
        scenarios.append({"body": json.dumps(body)})
    process = subprocess.run([bun, "-e", script], input=json.dumps({"script": feiwo.QUERY_SCRIPT,
        "fba": FBA, "fixture": provider_response, "scenarios": scenarios}), capture_output=True,
        text=True, timeout=15, check=False)
    assert process.returncode == 0, process.stderr
    outputs = json.loads(process.stdout)
    assert len(outputs) == len(scenarios)
    result = feiwo.parse_result(outputs[0]["result"], ARGS)
    assert result["success"] and result["matches"][0]["tracking_numbers"] == ["884661650703"]
    assert outputs[0]["calls"] == [{"url": "/tracking/app?inajax=1&tracking_number=" + FBA,
        "method": "GET", "credentials": "same-origin", "redirect": "error"}]
    assert "must-not-export" not in json.dumps(outputs)
    for index, code in [(1, "page_mismatch"), (2, "page_mismatch"), (3, "request_failed"),
        (4, "invalid_json"), (5, "invalid_response"), (6, "response_too_large"),
        (7, "http_error"), (8, "truncated_response"), (9, "truncated_response"),
        (10, "truncated_response"), (11, "truncated_response"),
        (12, "invalid_shipment"), (13, "invalid_traces")]:
        failure = feiwo.parse_result(outputs[index]["result"], ARGS)
        assert not failure["success"] and failure["error"]["code"] == code
    assert not outputs[1]["calls"] and not outputs[2]["calls"]
    assert outputs[12]["result"]["shipment"] == {"invalid_type": "array"}
    assert "actual forbidden" in feiwo.parse_result(outputs[7]["result"], ARGS)["error"]["message"]
    login = feiwo.safe_output(feiwo.parse_result(outputs[4]["result"], ARGS))
    assert "实际请登录" in login["error"]["message"]
    assert "hidden-secret" not in json.dumps(login) and "private-token" not in json.dumps(login)
