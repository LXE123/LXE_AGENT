"""Exercise template management through the public CLI and real persisted files."""
from pathlib import Path

import pytest
from openpyxl import load_workbook

from replenishment_cases import cli
from services.mabang.amazon.fba.replenishment_template import calculate_weighted_daily_sales


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path / "state"))
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LXESKILL_SKILL_SCOPE", "amazon-replenishment")
    monkeypatch.delenv("LXE_AGENT_SESSION_ID", raising=False)


def template(*arguments, expected=0):
    result = cli("replenish", "template", *arguments, expected=expected)
    assert result["ok"] == (expected == 0)
    return result


def edit_weights(path, weights):
    book = load_workbook(path)
    try:
        for row, weight in enumerate(weights, start=2):
            book["日销计算"].cell(row, 2, weight)
        book.save(path)
    finally:
        book.close()


def daily_sales(name):
    saved = template("show", "--template", name)
    assert saved["files"] == []
    return calculate_weighted_daily_sales(
        sales_7d=70, sales_14d=28, sales_30d=30,
        params=saved["data"]["template"]["params"],
    )


def test_listed_templates_can_be_shown_and_parameters_described():
    listed = template("list")
    assert listed["files"] == [] and listed["data"]["templates"]
    for item in listed["data"]["templates"]:
        shown = template("show", "--template", item["name"])
        assert shown["data"]["template"]["name"] == item["name"]
        assert shown["data"]["template"]["params"]
    groups = template("list-params")
    assert groups["files"] == []
    assert any(param["key"] == "weighted_sales.7d_weight"
               for group in groups["data"]["groups"] for param in group["params"])


def test_export_edit_import_replace_and_rename_persist_across_cli_processes(tmp_path):
    exported = template("export", "--template", "默认")
    path = Path(exported["data"]["xlsx_path"])
    assert exported["files"] == [str(path)] and path.is_relative_to(tmp_path)
    edit_weights(path, (1, 0, 0))
    assert template("validate-file", "--xlsx", path)["data"]["template_name"] == "默认"
    template("import", "--xlsx", path, "--name", "每周方案")
    assert daily_sales("每周方案") == 10

    edit_weights(path, (0, 1, 0))
    replaced = template("replace", "--xlsx", path, "--template", "每周方案")["data"]
    assert replaced["new_version"] == replaced["old_version"] + 1
    assert daily_sales("每周方案") == 2
    template("rename", "--template", "每周方案", "--name", "双周方案")
    assert daily_sales("双周方案") == 2
    names = {item["name"] for item in template("list")["data"]["templates"]}
    assert "双周方案" in names and "每周方案" not in names
    assert daily_sales("默认") == pytest.approx(6.7)

    edit_weights(path, (-1, 1, 1))
    for action, extra in (("validate-file", ()), ("replace", ("--template", "双周方案"))):
        failed = template(action, "--xlsx", path, *extra, expected=4)
        assert failed["files"] == [] and failed["data"]["action"] == action
        assert "加权日销权重必须是非负数: 7d_weight" in failed["error"]["message"]
    assert daily_sales("双周方案") == 2


@pytest.mark.parametrize("action,options,reason", [
    ("show", ("--template", "不存在的方案"), "未知备货算法参数方案: 不存在的方案"),
    ("rename", ("--template", "默认", "--name", "新名称"), "系统参数方案不允许重命名: 默认"),
    ("import", ("--xlsx", "missing.xlsx"), "missing.xlsx"),
])
def test_cli_preserves_operation_and_actual_failure(action, options, reason):
    failed = template(action, *options, expected=4)
    assert failed["files"] == [] and failed["data"]["action"] == action
    assert reason in failed["error"]["message"]
