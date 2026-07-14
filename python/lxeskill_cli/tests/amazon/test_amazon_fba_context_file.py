from __future__ import annotations

import json

import pytest

from services.agent_cli._shared.context_json import parse_context_file_argument
from services.agent_cli.browser.amazon_fba._shared import run_stage


def _context_payload() -> dict[str, str]:
    return {
        "store_id": "imjUiB8rg/2uP9OIOP2uFw==",
        "site": "US",
        "consignment_no": "SP260408007",
        "transport_mode": "空运",
    }


def test_parse_context_file_argument_reads_valid_json_with_chinese(tmp_path):
    path = tmp_path / "context.json"
    path.write_text(json.dumps(_context_payload(), ensure_ascii=False), encoding="utf-8")

    context = parse_context_file_argument(str(path))

    assert context["store_id"] == "imjUiB8rg/2uP9OIOP2uFw=="
    assert context["site"] == "US"
    assert context["consignment_no"] == "SP260408007"
    assert context["transport_mode"] == "空运"


def test_parse_context_file_argument_reads_utf8_bom(tmp_path):
    path = tmp_path / "context-bom.json"
    path.write_text(json.dumps(_context_payload(), ensure_ascii=False), encoding="utf-8-sig")

    context = parse_context_file_argument(str(path))

    assert context["transport_mode"] == "空运"


def test_parse_context_file_argument_rejects_missing_file(tmp_path):
    with pytest.raises(ValueError, match="context 文件不存在"):
        parse_context_file_argument(str(tmp_path / "missing.json"))


def test_parse_context_file_argument_rejects_invalid_json(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text("{bad", encoding="utf-8")

    with pytest.raises(ValueError, match="--context-file 必须指向 JSON 对象文件"):
        parse_context_file_argument(str(path))


def test_parse_context_file_argument_rejects_non_object_json(tmp_path):
    path = tmp_path / "list.json"
    path.write_text("[]", encoding="utf-8")

    with pytest.raises(ValueError, match="--context-file 必须指向 JSON 对象文件"):
        parse_context_file_argument(str(path))


def test_parse_context_file_argument_rejects_missing_required_field(tmp_path):
    path = tmp_path / "missing-field.json"
    payload = _context_payload()
    payload.pop("transport_mode")
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(ValueError, match="context 缺少必填字段: transport_mode"):
        parse_context_file_argument(str(path))


def test_run_stage_parses_context_file_and_clamps_timeout(tmp_path):
    path = tmp_path / "context.json"
    path.write_text(json.dumps(_context_payload(), ensure_ascii=False), encoding="utf-8")
    seen: dict = {}

    def fake_runner(*, context: dict, timeout_sec: int) -> dict:
        seen.update({"context": context, "timeout_sec": timeout_sec})
        return {"params_ready": True, "finished": True}

    payload = run_stage({"context_file": str(path), "timeout_sec": 45}, fake_runner)

    assert payload["finished"] is True
    assert seen["context"]["consignment_no"] == "SP260408007"
    assert seen["timeout_sec"] == 45


def test_run_stage_returns_not_ready_for_missing_context_file(tmp_path):
    payload = run_stage({"context_file": str(tmp_path / "absent.json")}, lambda **_: {"finished": True})

    assert payload["params_ready"] is False
    assert payload["finished"] is False
    assert payload["exception"]
