from __future__ import annotations

import io
import json
import subprocess
import sys
from pathlib import Path

from py_tools import lxeskill
from py_tools.business import allowed_output_file, load_catalog
from shared.workspace import activate_external_workspace, activate_project_workspace, artifact_root, internal_root, workspace_root


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


def test_normal_commands_do_not_load_skill_contract_or_yaml(tmp_path, monkeypatch, capsys) -> None:
    broken_skill = tmp_path / "skills" / "unrelated" / "SKILL.md"
    broken_skill.parent.mkdir(parents=True)
    broken_skill.write_text("---\ncommands: [\n---\n", encoding="utf-8")
    monkeypatch.setattr(lxeskill, "PROJECT_ROOT", tmp_path)

    assert lxeskill.main(["list"]) == 0
    records = _records(capsys)
    assert records[-1]["ok"] is True

    probe = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys; import py_tools.lxeskill; "
                "assert 'py_tools.lxeskill_contract' not in sys.modules; "
                "assert 'yaml' not in sys.modules"
            ),
        ],
        cwd=Path(__file__).parents[1],
        check=False,
        capture_output=True,
        text=True,
    )
    assert probe.returncode == 0, probe.stderr


def test_doctor_reports_repository_contract_without_adding_a_list_command(capsys) -> None:
    assert lxeskill.main(["doctor"]) == 0
    records = _records(capsys)
    assert records == [
        {
            "protocol_version": "1",
            "type": "result",
            "command": "doctor",
            "ok": True,
            "data": {
                "catalog_commands": 28,
                "business_commands": 27,
                "skill_files": 54,
                "owner_skills": 22,
                "command_declarations": 27,
            },
            "files": [],
        }
    ]

    assert lxeskill.main(["list"]) == 0
    records = _records(capsys)
    assert all(item["command"] != "doctor" for item in records[-1]["data"]["commands"])


def test_doctor_failure_is_an_environment_error_with_one_terminal(monkeypatch, capsys) -> None:
    from py_tools import lxeskill_contract

    report = lxeskill_contract.SkillContractReport(
        catalog_commands=1,
        business_commands=1,
        skill_files=1,
        owner_skills=1,
        command_declarations=0,
        violations=(
            lxeskill_contract.SkillContractViolation(
                "skill_command_missing",
                "skills/demo/SKILL.md",
                "Canonical owner does not declare catalog command: lxeskill demo run",
            ),
        ),
    )
    monkeypatch.setattr(lxeskill_contract, "validate_skill_command_contract", lambda catalog, *, project_root: report)

    assert lxeskill.main(["doctor"]) == lxeskill.EXIT_ENVIRONMENT
    records = _records(capsys)
    assert len(records) == 1
    assert records[0]["ok"] is False
    assert records[0]["error"] == {
        "code": "skill_contract_invalid",
        "message": "Skill command contract has 1 violation(s)",
    }
    assert records[0]["data"]["violations"] == [
        {
            "code": "skill_command_missing",
            "path": "skills/demo/SKILL.md",
            "message": "Canonical owner does not declare catalog command: lxeskill demo run",
        }
    ]


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


def test_external_workspace_is_private_and_does_not_modify_caller_gitignore(tmp_path) -> None:
    caller_gitignore = tmp_path / ".gitignore"
    caller_gitignore.write_text("keep-me\n", encoding="utf-8")
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    before_status = subprocess.run(
        ["git", "status", "--porcelain=v1", "--untracked-files=all"],
        cwd=tmp_path,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    try:
        assert activate_external_workspace(tmp_path) == (tmp_path / ".lxeskill").resolve()
        assert workspace_root() == tmp_path.resolve()
        assert internal_root() == (tmp_path / ".lxeskill").resolve()
        assert artifact_root() == (tmp_path / ".lxeskill" / "artifacts").resolve()
        assert (tmp_path / ".lxeskill" / ".gitignore").read_text(encoding="utf-8") == "*\n"
        assert caller_gitignore.read_text(encoding="utf-8") == "keep-me\n"
        after_status = subprocess.run(
            ["git", "status", "--porcelain=v1", "--untracked-files=all"],
            cwd=tmp_path,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        assert after_status == before_status
    finally:
        activate_project_workspace()
