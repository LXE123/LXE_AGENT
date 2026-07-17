from __future__ import annotations

import json
from typing import Any, get_type_hints

import pytest

from services.agent_cli._shared.context_json import parse_context_file_argument
from services.agent_cli.browser.amazon_fba import (
    confirm_own_carrier,
    enter_tracking_codes,
    prepare_multi_box_excel,
    prepare_upload,
)
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


@pytest.mark.parametrize(
    ("module", "stage_runner", "expected_include_file_path"),
    (
        (prepare_upload, prepare_upload.run_prepare_upload, None),
        (prepare_multi_box_excel, prepare_multi_box_excel.run_prepare_multi_box_excel, None),
        (confirm_own_carrier, confirm_own_carrier.run_confirm_own_carrier, True),
        (enter_tracking_codes, enter_tracking_codes.run_enter_tracking_codes, False),
    ),
    ids=("prepare-upload", "prepare-multi-box", "confirm-own-carrier", "enter-tracking-codes"),
)
def test_shipment_stage_adapter_resolves_annotations_and_delegates(
    monkeypatch: pytest.MonkeyPatch,
    module: Any,
    stage_runner: Any,
    expected_include_file_path: bool | None,
) -> None:
    captured: dict[str, Any] = {}
    expected = {"finished": True}

    def fake_direct_fba_workflow(**kwargs: Any) -> dict[str, Any]:
        captured.update(kwargs)
        return expected

    def fake_workflow_runner(**_kwargs: Any) -> dict[str, Any]:
        return {}

    monkeypatch.setattr(module, "run_direct_fba_workflow", fake_direct_fba_workflow)

    assert "workflow_runner" in get_type_hints(stage_runner)
    result = stage_runner(
        context=_context_payload(),
        timeout_sec=45,
        workflow_runner=fake_workflow_runner,
    )

    assert result is expected
    assert captured["context"] == _context_payload()
    assert captured["timeout_sec"] == 45
    assert captured["workflow_runner"] is fake_workflow_runner
    if expected_include_file_path is None:
        assert "include_file_path" not in captured
    else:
        assert captured["include_file_path"] is expected_include_file_path


@pytest.mark.parametrize(
    "module",
    (prepare_upload, prepare_multi_box_excel, confirm_own_carrier, enter_tracking_codes),
    ids=("prepare-upload", "prepare-multi-box", "confirm-own-carrier", "enter-tracking-codes"),
)
def test_shipment_stage_run_reaches_shared_runner_without_name_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
    module: Any,
) -> None:
    path = tmp_path / "context.json"
    path.write_text(json.dumps(_context_payload(), ensure_ascii=False), encoding="utf-8")
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)

    payload = module.run({"context_file": str(path), "timeout_sec": 45})

    assert payload["params_ready"] is False
    assert payload["finished"] is False
    assert payload["exception"] == "缺少 LXE_AGENT_SESSION_ID"
