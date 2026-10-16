from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from services.agent_cli.logistics import yuntuo_parser as yuntuo

FBA = "FBA19P9T04B2"


@pytest.fixture
def payload():
    return json.loads((Path(__file__).parent / "fixtures/yuntuo_tracequery.json").read_text(encoding="utf-8"))


def parse(payload, **kwargs):
    return yuntuo.parse_result(payload, http_status=kwargs.pop("http_status", 200),
        fba=kwargs.pop("fba", FBA), **kwargs)


def test_real_shipment_preserves_source_verified_transfer_number_without_inventing_carrier_or_eta(payload):
    result = parse(payload, expected_warehouse="TEST1")
    assert result["success"] and result["request_succeeded"] and result["complete"]
    assert result["found"] and result["matched_count"] == result["returned_count"] == 1
    assert result["result_code"] == 0 and result["message"] == "请求成功"
    match, = result["matches"]
    assert match["fba_numbers"] == [FBA]
    assert match["shipment_number"] == "999260910003548"
    assert match["reference_number"] == "1Z16HE510305235582"
    assert match["carrier"] is None
    assert match["tracking_numbers"] == ["1Z16HE510305235582"]
    assert match["tracking_number_source"] == "refno"
    assert match["destination"] == "US-美国"
    assert match["transport_number"] == ""
    assert match["warehouse"] is match["warehouse_matches"] is match["eta"] is None
    assert match["trace_timezone"] is match["parcel_count"] is None
    assert set(match["missing_fields"]) == {"carrier", "warehouse"}
    assert "expected_warehouse_not_verified" in match["warnings"]
    assert match["trace_count"] == 20
    assert match["traces"] == payload["body"][0]["podInfoDTOList"]
    assert match["traces"][0]["scanStatus"] == "货物已签收"
    assert match["traces"][0]["scanTime"] == "2026/10/07 23:43"
    assert match["traces"][0]["scanDatetime"] == 1791387795000
    assert "delivered_at" not in match and "shipment_status" not in match
    assert any("ETA:" in trace["remark"] for trace in match["traces"])
    assert any("UPS" in trace["remark"] for trace in match["traces"])


@pytest.mark.parametrize("raw,numbers", [
    ("1Z16HE510305235582", ["1Z16HE510305235582"]),
    (" 1Z16HE510305235582 ", ["1Z16HE510305235582"]),
    ("1Z16HE510305235582,1Z16HE510305235583", []),
    ("UPS 1Z16HE510305235582", []),
    ("---", []), ("", []),
])
def test_unknown_transfer_number_layouts_preserve_raw_field_without_guessing(payload, raw, numbers):
    payload["body"][0]["refno"] = raw
    match, = parse(payload)["matches"]
    assert match["tracking_numbers"] == numbers
    assert match["source_fields"]["refno"] == raw
    assert match["reference_number"] == raw
    assert match["carrier"] is None
    assert ("tracking_numbers" in match["missing_fields"]) is (not bool(numbers))
    assert ("tracking_layout_unrecognized; preserve raw refno" in match["warnings"]) is bool(raw and not numbers)


@pytest.mark.parametrize("suffix", ["U000001", "9", "X"])
def test_full_identity_never_matches_partial_fba(payload, suffix):
    payload["body"][0]["referenceno"] += suffix
    result = parse(payload)
    assert not result["success"] and not result["found"] and result["matches"] == []
    assert result["error"]["code"] == "identity_mismatch"
    assert parse(payload, fba=FBA + suffix)["found"]


def test_multiple_matching_rows_preserved_and_mixed_identities_fail(payload):
    second = copy.deepcopy(payload["body"][0])
    second.update(jobno="synthetic-second-job", refno="synthetic-second-reference", carrier="Explicit Carrier")
    payload["body"].append(second)
    result = parse(payload)
    assert result["success"] and result["matched_count"] == 2
    assert result["matches"][1]["shipment_number"] == "synthetic-second-job"
    assert result["matches"][1]["carrier"] == "Explicit Carrier"
    assert result["matches"][1]["tracking_numbers"] == []
    assert any("multiple_matching_rows" in warning for warning in result["warnings"])
    second["referenceno"] = FBA + "X"
    failure = parse(payload)
    assert not failure["success"] and failure["matches"] == []
    assert failure["error"]["code"] == "identity_mismatch"


@pytest.mark.parametrize("update,status,code", [
    ({"result_code": 123, "message": "实际认证失败"}, 200, "provider_error"),
    ({"message": "actual forbidden"}, 403, "http_error"),
    ({"result_code": True}, 200, "invalid_response"),
    ({"result_code": "0"}, 200, "invalid_response"),
    ({"result_code": None}, 200, "invalid_response"),
    ({"body": None}, 200, "invalid_response"),
    ({"body": {}}, 200, "invalid_response"),
    ({"body": []}, 200, "empty_result_unverified"),
    ({"body": [None]}, 200, "invalid_shipment"),
])
def test_synthetic_errors_and_unknown_empty_contract_are_not_business_absence(payload, update, status, code):
    result = parse({**payload, **update}, http_status=status)
    assert not result["success"] and not result["found"] and not result["complete"]
    assert result["matches"] == [] and result["auth_refresh_required"] is False
    assert result["error"]["code"] == code
    if "message" in update:
        assert update["message"] in result["error"]["message"]


@pytest.mark.parametrize("field,value", [("carrier", False), ("referenceno", None),
    ("referenceno", "not-an-FBA"), ("referenceno", FBA + "," + FBA),
    ("jobno", {}), ("refno", ["unobserved", "layout"]), ("transportno", 123)])
def test_unobserved_field_shapes_fail_without_guessing(payload, field, value):
    payload["body"][0][field] = value
    assert parse(payload)["error"]["code"] == "invalid_shipment"


@pytest.mark.parametrize("traces", [None, {}, [None], [{"scanTime": 123}],
    [{"scanTime": "raw", "scanStatus": "state", "remark": "text", "scanDatetime": True}],
    [{"scanTime": "raw", "scanStatus": "state", "remark": "text", "scanStation": []}]])
def test_unobserved_trace_shapes_fail(payload, traces):
    payload["body"][0]["podInfoDTOList"] = traces
    assert parse(payload)["error"]["code"] == "invalid_traces"


@pytest.mark.parametrize("target", ["rows", "traces", "identity", "remark"])
def test_budgets_fail_explicitly_before_returning_partial_matches(payload, target):
    row = payload["body"][0]
    if target == "rows":
        payload["body"] *= 101
    elif target == "traces":
        row["podInfoDTOList"] *= 11
    elif target == "identity":
        row["referenceno"] = FBA + "X" * 8000
    else:
        row["podInfoDTOList"][0]["remark"] = "x" * 8001
    result = parse(payload)
    assert result["error"]["code"] == "truncated_response"
    assert "[truncated]" in result["error"]["message"]
    assert not result["complete"] and not result["found"] and result["matches"] == []


def test_projection_excludes_unknown_fields_authentication_and_employee_data(payload):
    payload.update(token="must-not-export", sign="must-not-export")
    row = payload["body"][0]
    row["private_auth"] = "must-not-export"
    row["podInfoDTOList"][0].update(createUserName="must-not-export", fileUrls="must-not-export", token="must-not-export")
    result = parse(payload)
    assert result["success"] and "must-not-export" not in json.dumps(result)
    payload.update(result_code=456, message="actual failure https://user:private@vip.yjtms.com:11000/error?token=private")
    failure = parse(payload)
    assert "actual failure" in failure["error"]["message"]
    assert "private" not in json.dumps(failure)


@pytest.mark.parametrize("kwargs", [{"fba": FBA.lower()}, {"fba": FBA + "," + FBA},
    {"fba": "FBA" + "X" * 100}, {"expected_warehouse": "invalid code"}])
def test_invalid_input_rejected(payload, kwargs):
    assert parse(payload, **kwargs)["error"]["code"] == "invalid_arguments"
