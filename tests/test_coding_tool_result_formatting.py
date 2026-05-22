from __future__ import annotations

import json

from agent_runtime.tools import coding_tools


def _tool_text(payload: dict) -> str:
    result = coding_tools._command_payload_tool_result(payload)
    return str(result.content[0]["text"])


def test_process_completed_new_output_json_is_unescaped_without_summarizing():
    output = {
        "ok": True,
        "job_id": "imp_20260430_094659_001",
        "status": "succeeded",
        "file_path": r"D:\rpa\python\20260420\lxe_agent_local\artifacts\file.xlsx",
        "result": {
            "status": "accepted",
            "decision_reason": "accepted_latest",
            "provider": "ProviderA",
            "feed_family": "Air",
            "version_date": "2026-04-29",
            "batch_id": "7c1d1069-2f6f-49ba-afab-82f03c54d008",
            "pipeline_summary": {"large": ["kept"] * 20},
            "artifacts": {
                "summary_json": r"D:\RPA\logistics_fba\data\out\summary.json",
                "audit_csv": r"D:\RPA\logistics_fba\data\out\parser_audit.csv",
            },
        },
    }
    payload = {
        "session": "exec_21bd6527",
        "status": "completed",
        "new_output": json.dumps(output, ensure_ascii=False),
        "exit_code": 0,
        "duration_sec": 21.13,
    }

    text = _tool_text(payload)

    assert "new_output:" in text
    assert "parsed JSON" not in text
    assert "job_id: imp_20260430_094659_001" in text
    assert "result:" in text
    assert "  status: accepted" in text
    assert "provider: ProviderA" in text
    assert r"summary_json: D:\RPA\logistics_fba\data\out\summary.json" in text
    assert "pipeline_summary" in text
    assert text.count("- kept") == 20
    assert '\\"' not in text
    assert "\\\\" not in text


def test_exec_completed_output_json_is_unescaped():
    output = {
        "ok": True,
        "job_id": "imp_20260430_100000_001",
        "status": "succeeded",
        "result": {
            "status": "accepted",
            "provider": "ProviderB",
            "feed_family": "Sea",
            "version_date": "2026-04-30",
            "batch_id": "batch_001",
            "artifacts": {
                "pipeline_meta": r"D:\RPA\logistics_fba\data\out\pipeline_meta.json",
            },
        },
    }
    payload = {
        "session": "exec_done",
        "status": "completed",
        "output": json.dumps(output, ensure_ascii=False) + "\r\n",
        "exit_code": 0,
    }

    text = _tool_text(payload)

    assert "output:" in text
    assert "parsed JSON" not in text
    assert "job_id: imp_20260430_100000_001" in text
    assert "result:" in text
    assert "  status: accepted" in text
    assert "feed_family: Sea" in text
    assert r"pipeline_meta: D:\RPA\logistics_fba\data\out\pipeline_meta.json" in text
    assert '\\"' not in text


def test_non_json_command_output_is_preserved_without_truncation():
    raw_output = "plain output start\n" + ("x" * 8_000) + "\nplain output end"
    payload = {
        "session": "exec_raw",
        "status": "completed",
        "output": raw_output,
        "exit_code": 0,
    }

    text = _tool_text(payload)

    assert "output:" in text
    assert "parsed JSON" not in text
    assert "plain output start" in text
    assert "plain output end" in text
    assert "[truncated " not in text
    assert "x" * 8_000 in text
