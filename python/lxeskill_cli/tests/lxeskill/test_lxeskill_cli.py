from __future__ import annotations

import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

from lxeskill import cli as lxeskill
from lxeskill.business import ArtifactPathError, allowed_output_file, collect_declared_artifacts, load_catalog
from shared.repository import repository_root
from shared.workspace import activate_external_workspace, activate_project_workspace, artifact_root, internal_root, workspace_root


def _records(capsys) -> list[dict]:
    lines = [line for line in capsys.readouterr().out.splitlines() if line.strip()]
    return [json.loads(line) for line in lines]


def test_catalog_defines_every_cli_command_and_hidden_alias() -> None:
    catalog = load_catalog()

    assert len(catalog) == 26
    assert sum(bool(entry.get("module")) for entry in catalog.values()) == 23
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
    assert len(records[0]["data"]["commands"]) == 26

    assert lxeskill.main(["fba", "customs", "fill", "--help"]) == 0
    records = _records(capsys)
    assert len(records) == 1
    assert records[0]["data"]["command"] == "fba customs fill"
    assert records[0]["data"]["input_schema"]["required"] == ["input_xlsx", "template_xlsx"]


def test_normal_commands_do_not_load_skill_contract_or_yaml(tmp_path, monkeypatch, capsys) -> None:
    broken_skill = tmp_path / "skills" / "unrelated" / "SKILL.md"
    broken_skill.parent.mkdir(parents=True)
    broken_skill.write_text("---\ncommands: [\n---\n", encoding="utf-8")
    monkeypatch.setenv("LXE_SKILLS_ROOT", str(tmp_path / "skills"))

    assert lxeskill.main(["list"]) == 0
    records = _records(capsys)
    assert records[-1]["ok"] is True

    probe = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys; import lxeskill; "
                "assert 'lxeskill.contract' not in sys.modules; "
                "assert 'yaml' not in sys.modules"
            ),
        ],
        cwd=repository_root(),
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
                "catalog_commands": 26,
                "business_commands": 25,
                "skill_files": 53,
                "owner_skills": 21,
                "command_declarations": 25,
            },
            "files": [],
        }
    ]

    assert lxeskill.main(["list"]) == 0
    records = _records(capsys)
    assert all(item["command"] != "doctor" for item in records[-1]["data"]["commands"])


@pytest.mark.parametrize(
    "arguments",
    [
        ["fba", "logistics", "quote"],
        ["fba", "logistics", "rates-import"],
        ["amazon_logistic_quote"],
        ["logistics_rate_import"],
    ],
)
def test_retired_logistics_commands_are_unknown(arguments, capsys) -> None:
    assert lxeskill.main(arguments) == lxeskill.EXIT_USAGE
    record = _records(capsys)[0]
    assert record["error"]["code"] == "unknown_command"


def test_doctor_failure_is_an_environment_error_with_one_terminal(monkeypatch, capsys) -> None:
    from lxeskill import contract as lxeskill_contract

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
    monkeypatch.setattr(lxeskill_contract, "validate_skill_command_contract", lambda catalog, *, skills_root: report)

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
    monkeypatch.setattr(sys, "stdin", io.StringIO('{"delivery_no":"SP123","products_path":"C:/uploads/products.xlsx"}'))

    assert lxeskill.main(["fba", "export-tax", "delivery-summary", "--stdin-json"]) == 0
    captured = capsys.readouterr()
    records = [json.loads(line) for line in captured.out.splitlines()]
    assert [record["type"] for record in records] == ["progress", "result"]
    assert sum(record["type"] == "result" for record in records) == 1
    assert records[-1]["data"] == {"success": True, "value": 7}
    assert "legacy progress text" in captured.err
    assert calls[0][1] == {"delivery_no": "SP123", "products_path": "C:/uploads/products.xlsx"}


@pytest.mark.parametrize(
    ("arguments", "field"),
    [
        (["fba", "customs", "fill", "--input-xlsx", "C:/uploads/order.xlsx"], "template_xlsx"),
        (["fba", "customs", "fill", "--template-xlsx", "C:/uploads/template.xlsx"], "input_xlsx"),
        (["fba", "invoice", "fill", "--input-xlsx", "C:/uploads/order.xlsx"], "template_xlsx"),
        (["fba", "export-tax", "delivery-summary", "--delivery-no", "SP260508022"], "products_path"),
        (["fba", "export-tax", "products-import", "--sku", "SKU-1"], "products_path"),
    ],
)
def test_missing_user_workbook_returns_structured_input_required(arguments, field, monkeypatch, capsys) -> None:
    monkeypatch.setattr(
        lxeskill,
        "execute_module_json",
        lambda *_args, **_kwargs: pytest.fail("business module must not run without the uploaded workbook"),
    )

    assert lxeskill.main(arguments) == lxeskill.EXIT_USAGE
    record = _records(capsys)[0]
    assert record["error"] == {
        "code": "input_required",
        "message": f"Required uploaded file is missing: {field}",
    }
    assert record["recovery"]["next_action"] == "ask_user_to_upload_file"
    assert record["recovery"]["field"] == field
    assert record["recovery"]["accepted_extensions"] == [".xlsx"]
    assert "上传" in record["recovery"]["instruction"]


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


def test_invalid_declared_artifact_is_a_structured_business_error(monkeypatch, capsys) -> None:
    monkeypatch.setattr(
        lxeskill,
        "execute_module_json",
        lambda *args, **kwargs: (_ for _ in ()).throw(ArtifactPathError("missing output.xlsx")),
    )

    assert lxeskill.main(["fba", "restock", "workbook-create", "--delivery-no", "SP1", "--master-xlsx", "m.xlsx", "--gross-margin", "0.2"]) == lxeskill.EXIT_BUSINESS
    record = _records(capsys)[0]
    assert record["error"] == {
        "code": "invalid_artifact_path",
        "message": "missing output.xlsx",
    }


def test_output_file_must_be_under_artifacts_or_skill_assets(tmp_path) -> None:
    artifact = artifact_root() / "lxeskill-test.txt"
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


def test_desktop_project_workspace_uses_private_writable_roots(tmp_path, monkeypatch) -> None:
    workspace = tmp_path / "工作区"
    data_root = tmp_path / "应用数据"
    workspace.mkdir()
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(workspace))
    monkeypatch.setenv("LXE_DATA_ROOT", str(data_root))
    try:
        assert activate_project_workspace() == workspace.resolve()
        assert workspace_root() == workspace.resolve()
        assert internal_root() == data_root.resolve() / "lxeskill"
        assert artifact_root() == data_root.resolve() / "artifacts"
    finally:
        monkeypatch.delenv("LXE_WORKSPACE_ROOT")
        monkeypatch.delenv("LXE_DATA_ROOT")
        activate_project_workspace()


def test_workspace_override_alone_uses_repository_var_for_managed_state(tmp_path, monkeypatch) -> None:
    workspace = tmp_path / "工作区"
    workspace.mkdir()
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(workspace))
    monkeypatch.delenv("LXE_DATA_ROOT", raising=False)
    try:
        assert activate_project_workspace() == workspace.resolve()
        assert workspace_root() == workspace.resolve()
        assert internal_root() == repository_root() / "var" / "lxeskill"
        assert artifact_root() == repository_root() / "var" / "artifacts"
        assert internal_root().is_dir()
        assert artifact_root().is_dir()
    finally:
        monkeypatch.delenv("LXE_WORKSPACE_ROOT")
        activate_project_workspace()


def test_declared_artifacts_filter_roles_nested_fields_and_duplicates(tmp_path, monkeypatch) -> None:
    try:
        activate_external_workspace(tmp_path)
        first = artifact_root() / "out" / "Report.XLSX"
        duplicate = artifact_root() / "out" / "report.xlsx"
        second = artifact_root() / "out" / "diagnostic.json"
        first.parent.mkdir(parents=True)
        first.write_text("report", encoding="utf-8")
        duplicate.write_text("report", encoding="utf-8")
        second.write_text("debug", encoding="utf-8")
        entry = {
            "owner_skills": ["demo"],
            "artifact_paths": [
                {"field": "output_files[].path", "role": "deliverable"},
                {"field": "diagnostic_path", "role": "diagnostic"},
            ],
        }
        monkeypatch.setattr("lxeskill.business.os.path.normcase", lambda value: value.lower())

        assert collect_declared_artifacts(
            entry,
            {
                "output_files": [{"path": str(first)}, {"path": str(duplicate)}],
                "diagnostic_path": str(second),
            },
        ) == [str(first.resolve())]
    finally:
        activate_project_workspace()


def test_declared_artifact_rejects_missing_and_symlink_escape(tmp_path) -> None:
    try:
        activate_external_workspace(tmp_path)
        entry = {"artifact_paths": [{"field": "output", "role": "deliverable"}]}
        with pytest.raises(ArtifactPathError, match="missing file"):
            collect_declared_artifacts(entry, {"output": str(artifact_root() / "missing.xlsx")})

        outside = tmp_path / "outside.xlsx"
        outside.write_text("outside", encoding="utf-8")
        link = artifact_root() / "escaped.xlsx"
        link.parent.mkdir(parents=True)
        link.symlink_to(outside)
        with pytest.raises(ArtifactPathError, match="outside allowed artifact roots"):
            collect_declared_artifacts(entry, {"output": str(link)})
    finally:
        activate_project_workspace()


def test_skill_scope_filters_list_and_blocks_out_of_scope_commands(monkeypatch, capsys) -> None:
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "replenishment-store-resolve")
    assert lxeskill.main(["list"]) == 0
    (record,) = _records(capsys)
    commands = {item["command"] for item in record["data"]["commands"]}
    assert "replenish store resolve" in commands
    # Infrastructure commands stay reachable so auth-failure recovery hints
    # keep working for every business bot.
    assert "auth refresh" in commands
    assert all(not command.startswith("fba ") for command in commands)

    assert lxeskill.main(["describe", "fba", "customs", "fill"]) == lxeskill.EXIT_ENVIRONMENT
    (denied,) = _records(capsys)
    assert denied["ok"] is False
    assert denied["error"]["code"] == "skill_not_in_scope"

    assert lxeskill.main(["fba", "customs", "fill"]) == lxeskill.EXIT_ENVIRONMENT
    (blocked,) = _records(capsys)
    assert blocked["error"]["code"] == "skill_not_in_scope"


def test_empty_skill_scope_denies_business_commands_but_keeps_infrastructure(monkeypatch, capsys) -> None:
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "")
    assert lxeskill.main(["list"]) == 0
    (record,) = _records(capsys)
    commands = {item["command"] for item in record["data"]["commands"]}
    assert commands == {"auth refresh"}


def test_absent_skill_scope_is_unrestricted(monkeypatch, capsys) -> None:
    monkeypatch.delenv("LXESKILL_SKILL_SCOPE", raising=False)
    assert lxeskill.main(["list"]) == 0
    (record,) = _records(capsys)
    catalog = load_catalog()
    visible = [entry for entry in catalog.values() if str(entry.get("visibility") or "") != "internal"]
    assert len(record["data"]["commands"]) == len(visible)
