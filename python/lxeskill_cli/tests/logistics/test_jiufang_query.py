from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest
import requests

from lxeskill import cli
from services.agent_cli.logistics import jiufang_query as jf


def fixture(name="single"):
    return json.loads((Path(__file__).parent / f"fixtures/jiufang_{name}.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("raw,kind,fba,suffix", [
    ("FBA15GJ013CQU000001", "auto", "FBA15GJ013CQ", "U000001"),
    ("FBA15GJ013CQU000002", "box", "FBA15GJ013CQ", "U000002"),
    (" FBA15GJ013CQU000001 ", "auto", "FBA15GJ013CQ", "U000001"),
    ("FBA1234567U000001", "auto", "FBA1234567", "U000001"),
    ("FBA12345678901234567890U000001", "auto", "FBA12345678901234567890", "U000001"),
    ("FBA15GJ013CQ", "auto", "FBA15GJ013CQ", None),
    ("FBA15GJ013CQU", "auto", "FBA15GJ013CQU", None),
    ("FBA15GJ013CQU00001", "auto", "FBA15GJ013CQU00001", None),
    ("FBA15GJ013CQU000001X", "auto", "FBA15GJ013CQU000001X", None),
    ("FBA15GJ013CQU000001", "shipment", "FBA15GJ013CQU000001", None),
])
def test_normalization_does_not_assume_main_identifier_length(raw, kind, fba, suffix):
    result = jf.normalize_identifier(raw, kind)
    assert result["input_fba"] == raw
    assert result["fba"] == fba and result["box_suffix"] == suffix
    assert result["identity_verified"] is False


@pytest.mark.parametrize("args", [
    {}, {"fba": None}, {"fba": []}, {"fba": "FBA15GJ013CQ,FBA15GJ1LNL0"},
    {"fba": "SP260914001"}, {"fba": "fba15gj013cq"}, {"fba": "FBA" + "A" * 62},
    {"fba": "FBA15GJ013CQ", "identifier_kind": "box"},
    {"fba": "FBA15GJ013CQ", "identifier_kind": "guess"},
    {"fba": "FBA15GJ013CQ", "url": "https://example.com"},
    {"fba": "FBA15GJ013CQ", "store_id": "another-store"},
    {"fba": "FBA15GJ013CQ", "expected_warehouse": "au-xsy2"},
])
def test_invalid_input_never_requests_network(args, monkeypatch):
    monkeypatch.setattr(jf, "_read_public", lambda _: pytest.fail("Unexpected request"))
    result = jf.run(args)
    assert not result["success"] and not result["request_attempted"]
    assert result["error"]["message"]


def test_single_fixture_matches_user_screenshot_and_preserves_every_trace():
    payload = fixture()
    result = jf.parse_result(payload, {"fba": "FBA15GJGP83C", "expected_warehouse": "XSY2"})
    assert result["success"] and result["identity_verified"] and result["complete"]
    match, = result["matches"]
    assert match["shipment_number"] == "ZX26106E33"
    assert match["warehouse"] == "XSY2" and match["warehouse_matches"] is True
    assert match["parcel_count"] == 1 and match["weight"] == 12.8
    assert match["shipment_status"] == "delivered"
    assert match["traces"] == payload["data"][0]["lines"]
    assert len(match["traces"]) == 12
    assert match["carrier"] is None and match["eta"] is None and match["trace_timezone"] is None
    assert match["tracking_numbers"] == []


def test_box_query_requests_one_main_fba_and_confirms_shared_waybill(monkeypatch):
    calls = []

    def read(fba):
        calls.append(fba)
        return 200, "application/json", json.dumps(fixture("multi")).encode()

    monkeypatch.setattr(jf, "_read_public", read)
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)
    result = jf.run({"fba": "FBA15GJ013CQU000001", "expected_warehouse": "XSY2"})
    assert calls == ["FBA15GJ013CQ"]
    assert result["input_fba"] == "FBA15GJ013CQU000001" and result["box_suffix"] == "U000001"
    assert result["identity_verified"] and result["source"]["authentication"] == "anonymous"
    match, = result["matches"]
    assert match["fba_numbers"] == ["FBA15GJ013CQ", "FBA15GJ1LNL0"]
    assert match["reference_number"] == "FBA15GJ013CQ-FBA15GJ1LNL0"
    assert match["shipment_number"] == "ZX2609QG14"
    assert match["totals_scope"] == "waybill" and match["parcel_count"] == 4 and match["weight"] == 54.2
    assert any("shared_waybill" in warning for warning in match["warnings"])
    assert jf.parse_result(fixture("multi"), {"fba": "FBA15GJ1LNL0"})["identity_verified"]


@pytest.mark.parametrize("returned", ["FBA15GJ013CQU", "FBA15GJ013CQU000001", "FBA15GJ013CQX", "FBA15MG3TCXJ"])
def test_substrings_box_ids_and_unrelated_shipments_never_confirm_a_main_fba(returned):
    payload = fixture("multi")
    payload["data"][0]["shipmentId"] = returned
    result = jf.parse_result(payload, {"fba": "FBA15GJ013CQ"})
    assert result["error"]["code"] == "identity_mismatch"
    assert not result["found"] and not result["identity_verified"] and result["matches"] == []


def test_reference_number_does_not_override_wrong_shipment_identity():
    payload = fixture("multi")
    payload["data"][0].update(referenceNo="FBA15GJ013CQ", shipmentId="FBA15MG3TCXJ")
    assert jf.parse_result(payload, {"fba": "FBA15GJ013CQ"})["error"]["code"] == "identity_mismatch"


def test_multiple_matching_waybills_are_all_preserved_and_one_wrong_row_fails():
    payload = fixture()
    payload["data"].append(copy.deepcopy(payload["data"][0]))
    payload["data"][1]["waybillNo"] = "SYNTHETIC-SECOND"
    result = jf.parse_result(payload, {"fba": "FBA15GJGP83C"})
    assert result["matched_count"] == 2 and len(result["matches"]) == 2
    assert "multiple_matching_waybills; preserve all matches" in result["warnings"]
    payload["data"][1]["shipmentId"] = "FBA15MG3TCXJ"
    result = jf.parse_result(payload, {"fba": "FBA15GJGP83C"})
    assert not result["success"] and result["matches"] == []


def test_warehouse_conflict_and_unfinished_signoff_are_not_hidden():
    payload = fixture()
    payload["data"][0]["lines"][-1]["state"] = False
    result = jf.parse_result(payload, {"fba": "FBA15GJGP83C", "expected_warehouse": "DTM1"})
    match, = result["matches"]
    assert match["warehouse_matches"] is False and "warehouse_mismatch" in match["warnings"]
    assert match["shipment_status"] == "" and match["eta"] is None


@pytest.mark.parametrize("payload,status,code,fragment", [
    ({"code": 403, "message": "实际禁止访问"}, 403, "http_error", "实际禁止访问"),
    ({"code": 500, "message": "实际业务失败"}, 200, "provider_error", "实际业务失败"),
    ({"code": True}, 200, "provider_error", "true"),
    ([], 200, "invalid_response", "[]"),
    ({"code": 200, "data": {}}, 200, "invalid_rows", "{}"),
    ({"code": 200, "data": [], "data2": ["FBA15GJGP83C"]}, 200, "empty_result_unverified", "FBA15GJGP83C"),
    ({"code": 200, "data": [None]}, 200, "invalid_row", "null"),
])
def test_failures_preserve_real_diagnostics(payload, status, code, fragment):
    result = jf.parse_result(payload, {"fba": "FBA15GJGP83C"}, status)
    assert not result["success"] and not result["found"] and not result["complete"]
    assert result["error"]["code"] == code and fragment in result["error"]["message"]


@pytest.mark.parametrize("field,value", [
    ("weight", True), ("weight", float("nan")), ("weight", -1),
    ("packageNum", 1.5), ("waybillNo", {}), ("shipmentId", None),
    ("shipmentId", "FBA15GJGP83C;FBA15GJ013CQ"), ("shipmentId", "FBA15GJGP83C,"),
    ("destination", "X" * 8001), ("lines", None), ("lines", [{}] * 201),
    ("lines", [{"status": 140, "state": "false", "content": "已签收(结)"}]),
    ("lines", [{"status": 140, "state": True, "content": "已签收(结)", "remark": "X" * 8001}]),
])
def test_bad_types_and_oversize_fields_fail_without_truncated_identity_matching(field, value):
    payload = fixture()
    payload["data"][0][field] = value
    result = jf.parse_result(payload, {"fba": "FBA15GJGP83C"})
    assert not result["success"] and not result["identity_verified"]


def test_network_exception_and_non_json_response_keep_actual_error(monkeypatch):
    def broken(_):
        raise requests.ConnectionError("actual socket failure")

    monkeypatch.setattr(jf, "_read_public", broken)
    result = jf.run({"fba": "FBA15GJGP83C"})
    assert result["request_attempted"] and "actual socket failure" in result["error"]["message"]
    monkeypatch.setattr(jf, "_read_public", lambda _: (502, "text/plain", b"actual upstream gateway failure"))
    result = jf.run({"fba": "FBA15GJGP83C"})
    assert result["http_status"] == 502 and "actual upstream gateway failure" in result["error"]["message"]


@pytest.mark.parametrize("oversize", [False, True])
def test_public_transport_never_attaches_auth_or_follows_redirects(monkeypatch, oversize):
    calls = []

    class Response:
        status_code = 200
        headers = {"Content-Type": "application/json"}

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def iter_content(self, chunk_size):
            yield b"x" * (jf.MAX_BYTES + 1) if oversize else b"{}"

    class Session:
        trust_env = True

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def post(self, url, **kwargs):
            assert self.trust_env is False
            calls.append((url, kwargs))
            return Response()

    monkeypatch.setattr(jf.requests, "Session", Session)
    if oversize:
        with pytest.raises(ValueError, match=r"2097152.*\[truncated\]"):
            jf._read_public("FBA15GJGP83C")
    else:
        assert jf._read_public("FBA15GJGP83C") == (200, "application/json", b"{}")
    url, kwargs = calls[0]
    assert url == jf.URL and kwargs == {"json": ["FBA15GJGP83C"], "timeout": (10, 30),
                                       "stream": True, "allow_redirects": False}
    assert len(calls) == 1


def test_cli_dispatches_without_session_or_store(monkeypatch, capsys):
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)
    monkeypatch.setattr(jf, "_read_public", lambda _: (200, "application/json", json.dumps(fixture("multi")).encode()))
    assert cli.main(["logistics", "jiufang", "query", "--fba", "FBA15GJ013CQU000001", "--expected-warehouse", "XSY2"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["ok"] and result["data"]["identity_verified"]
    assert result["data"]["fba"] == "FBA15GJ013CQ"
