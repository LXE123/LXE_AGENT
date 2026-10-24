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
from services.agent_cli.logistics import yuntuo_query as yuntuo

FBA = "FBA19P9T04B2"
ARGS = {"store_id": "test-store", "fba": FBA}


@pytest.fixture
def payload():
    return json.loads((Path(__file__).parent / "fixtures/yuntuo_tracequery.json").read_text(encoding="utf-8"))


def projection(payload):
    return {"http_status": 200, "request_attempted": True, "header_source": "page_http_service",
        "content_type": "application/json", "payload": payload}


def fake_session(monkeypatch, response, *, url=yuntuo.ORIGIN + yuntuo.PAGE_PATH + "?jobno=" + FBA, failure=None):
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

    monkeypatch.setattr(yuntuo, "store_driver_session", attach)
    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "unit-test-session")
    return calls


def test_repeated_queries_attach_strictly_without_restart_or_navigation(monkeypatch, payload):
    calls = fake_session(monkeypatch, projection(payload))
    first, second = yuntuo.run(ARGS), yuntuo.run(ARGS)
    assert first["success"] and second["success"] and first["matches"] == second["matches"]
    assert first["queried_at"] != second["queried_at"] and first["queried_at"].endswith("+00:00")
    assert first["header_source"] == "page_http_service"
    assert first["source"] == {"url": yuntuo.ORIGIN + yuntuo.PATH, "method": "GET",
        "query": {"noList": FBA, "queryType": 99}}
    assert first["page_url"] == yuntuo.ORIGIN + yuntuo.PAGE_PATH
    assert first["matches"][0]["tracking_numbers"] == ["1Z16HE510305235582"]
    assert first["matches"][0]["carrier"] is None
    assert not any(w.startswith("response_projection_only") for w in first["warnings"])
    assert calls[0] == ("attach", "test-store", {"strict_attach": True, "target_host": yuntuo.HOST})
    assert len([call for call in calls if call[0] == "query"]) == 2


@pytest.mark.parametrize("url", [
    "http://vip.yjtms.com:11000/customer/trackquery/", "https://vip.yjtms.com/customer/trackquery/",
    "https://vip.yjtms.com:11000/viplogin", "https://vip.yjtms.com.evil.test:11000/customer/trackquery/",
    "https://user:secret@vip.yjtms.com:11000/customer/trackquery/",
    "https://vip.yjtms.com:33745/customer/trackquery/",
])
def test_wrong_origin_port_or_path_cannot_request(monkeypatch, payload, url):
    calls = fake_session(monkeypatch, projection(payload), url=url)
    assert not yuntuo.run(ARGS)["success"]
    assert not any(call[0] == "query" for call in calls)


@pytest.mark.parametrize("update", [
    {"url": "https://other.test"}, {"headers": {"token": "private"}}, {"sign": "private"},
    {"script": "fetch('/write')"}, {"cookie": "private"}, {"query_type": 1},
    {"fba": FBA + ",FBAOTHER123"}, {"fba": FBA.lower()}, {"fba": "FBA" + "X" * 100},
    {"store_id": ""}, {"store_id": "x" * 257}, {"fba": ""}, {"expected_warehouse": "invalid code"},
])
def test_invalid_input_cannot_attach(monkeypatch, update):
    monkeypatch.setattr(yuntuo, "store_driver_session", lambda *a, **k: pytest.fail("must not attach"))
    assert not yuntuo.run({**ARGS, **update})["success"]


def test_session_required(monkeypatch):
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)
    monkeypatch.setattr(yuntuo, "store_driver_session", lambda *a, **k: pytest.fail("must not attach"))
    assert "LXE_AGENT_SESSION_ID" in yuntuo.run(ARGS)["error"]["message"]


def test_selenium_error_and_cause_are_preserved_without_retry(monkeypatch, payload):
    error = RuntimeError("actual attach error https://user:secret@vip.yjtms.com:11000/error?token=private")
    error.__cause__ = OSError("actual socket closed")
    calls = fake_session(monkeypatch, projection(payload), failure=error)
    result = yuntuo.run(ARGS)
    assert not result["success"]
    assert "actual attach error" in result["error"]["message"] and "actual socket closed" in result["error"]["message"]
    assert "private" not in json.dumps(result) and "secret" not in json.dumps(result)
    assert len([call for call in calls if call[0] == "query"]) == 1


def test_cli_session_skill_scope_and_actual_provider_error(monkeypatch, capsys, payload):
    argv = ["logistics", "yuntuo", "query", "--store-id", "test-store", "--fba", FBA]
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)
    assert cli.main(argv) == cli.EXIT_ENVIRONMENT
    assert json.loads(capsys.readouterr().out)["error"]["code"] == "session_required"
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "fba-shipment-delivery-window")
    assert cli.main(argv) == cli.EXIT_ENVIRONMENT
    assert json.loads(capsys.readouterr().out)["error"]["code"] == "skill_not_in_scope"
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "fba-logistics-query")
    fake_session(monkeypatch, projection(payload))
    assert cli.main(argv) == 0
    assert json.loads(capsys.readouterr().out)["data"]["matches"][0]["tracking_numbers"] == ["1Z16HE510305235582"]
    payload.update(result_code=404, message="actual captured-shaped failure", solution="provider details")
    fake_session(monkeypatch, projection(payload))
    assert cli.main(argv) != 0
    envelope = json.loads(capsys.readouterr().out)
    assert not envelope["ok"] and "actual captured-shaped failure" in envelope["error"]["message"]


def test_actual_adapter_javascript_delegates_headers_projects_real_fixture_and_stops_on_failures(payload):
    bun = shutil.which("bun")
    assert bun, "Bun is required to exercise the actual adapter JavaScript"
    script = r"""
const input = await Bun.stdin.json();
const results = [];
for (const scenario of input.scenarios) {
  globalThis.location = {origin: scenario.origin || 'https://vip.yjtms.com:11000', pathname: scenario.path || '/customer/trackquery/'};
  const headerCalls = [], calls = [];
  const nativeHeaders = {version: '1.0', token: 'must-not-export-token', sign: 'must-not-export-sign',
    hyeCurrentStatId: 49, locale: 'zhCN', timeZone: 'Asia/Hong_Kong | UTC+08:00'};
  if (scenario.headerUpdate) Object.assign(nativeHeaders, scenario.headerUpdate);
  const service = {getRequestHeader(params) {
    headerCalls.push(params);
    if (scenario.headerError) throw new TypeError('actual native-header failure');
    return scenario.invalidHeaderObject ? [] : nativeHeaders;
  }};
  const element = () => ({__vue__: {$httpService: service}});
  let nodes = [element(), element()];
  if (scenario.noService) nodes = [{__vue__: {$httpService: {get() {throw new Error('must not use generic wrapper');}}}}];
  if (scenario.multipleServices) nodes.push({__vue__: {$httpService: {getRequestHeader() {}}}});
  if (scenario.scanTruncated) nodes = Array.from({length: 2001}, element);
  globalThis.document = {documentElement: nodes[0], createTreeWalker() {
    let index = 0; return {currentNode: nodes[0], nextNode() {return nodes[++index] || null;}};
  }};
  globalThis.fetch = async (url, options) => {
    calls.push({url, method: options.method, credentials: options.credentials, redirect: options.redirect,
      headerNames: Object.keys(options.headers).sort(), nativeHeaderIdentity: options.headers === nativeHeaders});
    if (scenario.networkError) throw new TypeError('actual network error must-not-export-token must-not-export-sign');
    return new Response(scenario.body === undefined ? JSON.stringify(input.fixture) : scenario.body,
      {status: scenario.status || 200, headers: {'Content-Type': 'application/json'}});
  };
  const result = await new Promise(resolve => new Function(input.script)(input.fba, resolve));
  results.push({headerCalls, calls, result});
}
process.stdout.write(JSON.stringify(results));
"""
    payload["token"] = "must-not-export-top-level"
    payload["body"][0]["private_auth"] = "must-not-export-shipment"
    payload["body"][0]["podInfoDTOList"][0]["createUserName"] = "must-not-export-employee"
    scenarios = [{}, {"origin": "https://other.test"}, {"path": "/viplogin"},
        {"noService": True}, {"multipleServices": True}, {"scanTruncated": True},
        {"headerError": True}, {"invalidHeaderObject": True}, {"headerUpdate": {"arbitrary": "value"}},
        {"headerUpdate": {"token": ""}}, {"networkError": True},
        {"body": '<html><input value="hidden-secret">实际请登录<script>private-value</script></html>'},
        {"body": "[]"}, {"body": "x" * 2097153},
        {"status": 403, "body": '{"result_code":404,"message":"actual forbidden must-not-export-token","solution":"actual details"}'},
        {"body": '{"result_code":0,"body":[],"message":"empty synthetic"}'}]
    for target in ("identity", "trace_info", "trace_count", "row_count", "info", "shipment_shape", "trace_shape"):
        data = copy.deepcopy(payload)
        row = data["body"][0]
        if target == "identity":
            row["referenceno"] = FBA + "X" * 8000
        elif target == "trace_info":
            row["podInfoDTOList"][0]["remark"] = "x" * 8001
        elif target == "trace_count":
            row["podInfoDTOList"] *= 11
        elif target == "row_count":
            data["body"] *= 101
        elif target == "info":
            data["message"] = "actual failure " + "x" * 8001
        elif target == "shipment_shape":
            data["body"] = None
        else:
            row["podInfoDTOList"][0]["scanTime"] = {"token": "must-not-export-object"}
        scenarios.append({"body": json.dumps(data)})
    process = subprocess.run([bun, "-e", script], input=json.dumps({"script": yuntuo.QUERY_SCRIPT,
        "fba": FBA, "fixture": payload, "scenarios": scenarios}), capture_output=True,
        text=True, timeout=15, check=False)
    assert process.returncode == 0, process.stderr
    outputs = json.loads(process.stdout)
    assert len(outputs) == len(scenarios)
    assert "must-not-export" not in json.dumps(outputs)
    result = yuntuo.parse_projection(outputs[0]["result"], ARGS)
    assert result["success"] and result["matches"][0]["trace_count"] == 20
    assert result["matches"][0]["carrier"] is None and result["matches"][0]["eta"] is None
    assert outputs[0]["headerCalls"] == [{"noList": FBA, "queryType": 99}]
    assert outputs[0]["calls"] == [{"url": yuntuo.PATH + "?noList=" + FBA + "&queryType=99",
        "method": "GET", "credentials": "same-origin", "redirect": "error", "nativeHeaderIdentity": True,
        "headerNames": ["hyeCurrentStatId", "locale", "sign", "timeZone", "token", "version"]}]
    for index, code in [(1, "page_mismatch"), (2, "page_mismatch"),
        (3, "page_service_unavailable"), (4, "page_service_unavailable"), (5, "page_service_unavailable"),
        (6, "request_failed"), (7, "invalid_page_headers"), (8, "invalid_page_headers"),
        (9, "invalid_page_headers"), (10, "request_failed"), (11, "invalid_json"),
        (12, "invalid_response"), (13, "response_too_large"), (14, "http_error"),
        (15, "empty_result_unverified"), (16, "truncated_response"), (17, "truncated_response"),
        (18, "truncated_response"), (19, "truncated_response"), (20, "truncated_response"),
        (21, "invalid_response"), (22, "invalid_traces")]:
        failure = yuntuo.parse_projection(outputs[index]["result"], ARGS)
        assert not failure["success"] and failure["error"]["code"] == code
        if index < 10:
            assert not outputs[index]["calls"]
    assert "actual forbidden" in yuntuo.parse_projection(outputs[14]["result"], ARGS)["error"]["message"]
    login = yuntuo.safe_output(yuntuo.parse_projection(outputs[11]["result"], ARGS))
    assert "实际请登录" in login["error"]["message"]
    assert "hidden-secret" not in json.dumps(login) and "private-value" not in json.dumps(login)
