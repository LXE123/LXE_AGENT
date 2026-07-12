from __future__ import annotations

import io
import json
import sys
from pathlib import Path

from py_tools import lxeskill
from py_tools.business import allowed_output_file, load_catalog


def _records(capsys) -> list[dict]:
    lines = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    return [json.loads(line) for line in lines]


def test_catalog_defines_every_cli_command_and_hidden_alias() -> None:
    catalog = load_catalog()

    assert len(catalog) == 28
    assert sum(bool(entry.get("module")) for entry in catalog.values()) == 25
    assert sum(entry.get("handler") == "browser" for entry in catalog.values()) == 2
    assert sum(entry.get("visibility") == "maintenance" for entry in catalog.values()) == 1
    assert len({tuple(entry["command_path"]) for entry in catalog.values()}) == len(catalog)
    assert all(entry["legacy_aliases"] == [name] for name, entry in catalog.items())


def test_list_and_help_write_one_terminal_jsonl_record(capsys) -> None:
    assert lxeskill.main(["list"]) == 0
    records = _records(capsys)
    assert len(records) == 1
    assert records[0]["type"] == "result"
    assert records[0]["ok"] is True
    assert len(records[0]["data"]["commands"]) == 28

    assert lxeskill.main(["fba", "customs", "fill", "--help"]) == 0
    records = _records(capsys)
    assert len(records) == 1
    assert records[0]["data"]["command"] == "fba customs fill"
    assert records[0]["data"]["input_schema"]["required"] == ["input_xlsx"]


def test_stdin_json_normalizes_progress_and_terminal_result(monkeypatch, capsys) -> None:
    calls: list[tuple[dict, dict, dict]] = []

    def fake_execute(entry, arguments, session, *, on_event, on_text):
        calls.append((entry, arguments, session))
        on_text("legacy progress text")
        on_event({"type": "progress", "step": "download", "status": "running", "message": "working"})
        return True, [{"type": "text", "text": '{"success":true,"value":7}'}], [], None

    monkeypatch.setattr(lxeskill, "execute_module_json", fake_execute)
    monkeypatch.setattr(sys, "stdin", io.StringIO('{"delivery_no":"SP123"}'))

    assert lxeskill.main(["fba", "export-tax", "delivery-summary", "--stdin-json"]) == 0
    captured = capsys.readouterr()
    records = [json.loads(line) for line in captured.out.splitlines()]
    assert [record["type"] for record in records] == ["progress", "result"]
    assert sum(record["type"] == "result" for record in records) == 1
    assert records[-1]["data"] == {"success": True, "value": 7}
    assert "legacy progress text" in captured.err
    assert calls[0][1] == {"delivery_no": "SP123"}


def test_legacy_alias_is_hidden_but_dispatches_same_command(monkeypatch, capsys) -> None:
    seen: list[str] = []

    def fake_execute(entry, arguments, session, *, on_event, on_text):
        seen.append(entry["name"])
        return True, [{"type": "text", "text": '{"success":true}'}], [], None

    monkeypatch.setattr(lxeskill, "execute_module_json", fake_execute)

    assert lxeskill.main(["mabang_resolve_fba_store", "--store-name", "Demo"]) == 0
    records = _records(capsys)
    assert records[-1]["command"] == "replenish store resolve"
    assert seen == ["mabang_resolve_fba_store"]


def test_business_failure_preserves_payload_in_the_only_terminal(monkeypatch, capsys) -> None:
    def fake_execute(entry, arguments, session, *, on_event, on_text):
        return (
            False,
            [{"type": "text", "text": '{"success":false,"context":{"stage":"download"}}'}],
            [],
            {"code": "business_cli_failed", "message": "login expired"},
        )

    monkeypatch.setattr(lxeskill, "execute_module_json", fake_execute)

    assert lxeskill.main(["fba", "shipment", "delivery-csv-download", "--delivery-no", "SP1"]) == lxeskill.EXIT_BUSINESS
    records = _records(capsys)
    assert len(records) == 1
    assert records[0]["ok"] is False
    assert records[0]["data"]["context"] == {"stage": "download"}
    assert records[0]["error"] == {"code": "business_cli_failed", "message": "login expired"}
    assert records[0]["recovery"] == {"command": "lxeskill auth refresh --scope fba --force"}


def test_catalog_failure_still_writes_one_internal_terminal(monkeypatch, capsys) -> None:
    monkeypatch.setattr(lxeskill, "load_catalog", lambda: (_ for _ in ()).throw(RuntimeError("broken catalog")))

    assert lxeskill.main(["list"]) == lxeskill.EXIT_INTERNAL

    records = _records(capsys)
    assert len(records) == 1
    assert records[0]["error"] == {"code": "RuntimeError", "message": "broken catalog"}


def test_output_file_must_be_under_artifacts_or_skill_assets(tmp_path) -> None:
    artifact = Path(lxeskill.PROJECT_ROOT) / "artifacts" / "lxeskill-test.txt"
    artifact.parent.mkdir(parents=True, exist_ok=True)
    artifact.write_text("ok", encoding="utf-8")
    try:
        assert allowed_output_file(str(artifact)) == artifact.resolve()
        outside = tmp_path / "outside.txt"
        outside.write_text("no", encoding="utf-8")
        try:
            allowed_output_file(str(outside))
        except ValueError as exc:
            assert "outside allowed artifact roots" in str(exc)
        else:
            raise AssertionError("outside file should have been rejected")
    finally:
        artifact.unlink(missing_ok=True)
