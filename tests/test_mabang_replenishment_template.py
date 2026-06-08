from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_runtime.skill_index import load_skill_index
from services.agent_cli.mabang import replenishment_template as cli
from services.mabang.amazon.fba import replenishment_template as tmpl


def _read_payload(capsys) -> dict:
    output = capsys.readouterr().out.strip().splitlines()
    assert output
    return json.loads(output[-1])


def _cell_value(path: Path, sheet_name: str, row: int, column: int):
    from openpyxl import load_workbook

    workbook = load_workbook(path, data_only=True)
    try:
        return workbook[sheet_name].cell(row=row, column=column).value
    finally:
        workbook.close()


def test_default_template_loads_current_algorithm() -> None:
    template = tmpl.load_default_template()

    assert template.name == "默认模板"
    assert template.version == 1
    assert template.params["weighted_sales"] == {
        "7d_weight": 0.6,
        "14d_weight": 0.3,
        "30d_weight": 0.1,
    }
    assert tmpl.replenishment_days_from_template(6, "平稳", template.params) == 75
    assert tmpl.sea_day_candidates_from_template(55, template.params) == [100, 110]
    assert tmpl.validate_template(template).warnings == ()


def test_export_validate_and_import_template_xlsx(tmp_path) -> None:
    exported_path = tmpl.export_template_xlsx("默认模板", output_dir=tmp_path / "editable")

    assert exported_path.is_file()
    assert _cell_value(exported_path, "模板信息", 2, 2) == "默认模板"
    assert _cell_value(exported_path, "加权日销", 2, 2) == 0.6

    result = tmpl.validate_template_xlsx(exported_path)
    assert result.template.name == "默认模板"
    assert result.template.params["shipping"]["air_urgent_sales_days_lte"] == 40

    imported = tmpl.import_template_xlsx(exported_path, store_path=tmp_path / "templates.json")
    assert imported.template.name == "自定义模板1"

    second_imported = tmpl.import_template_xlsx(exported_path, store_path=tmp_path / "templates.json")
    assert second_imported.template.name == "自定义模板2"

    templates = tmpl.list_templates(store_path=tmp_path / "templates.json")
    assert [template.name for template in templates] == ["默认模板", "自定义模板1", "自定义模板2"]


def test_import_rejects_duplicate_and_default_names(tmp_path) -> None:
    exported_path = tmpl.export_template_xlsx("默认模板", output_dir=tmp_path / "editable")
    tmpl.import_template_xlsx(exported_path, name="老王模板", store_path=tmp_path / "templates.json")

    with pytest.raises(tmpl.ReplenishmentTemplateError, match="模板名已存在"):
        tmpl.import_template_xlsx(exported_path, name="老王模板", store_path=tmp_path / "templates.json")

    with pytest.raises(tmpl.ReplenishmentTemplateError, match="不允许导入覆盖"):
        tmpl.import_template_xlsx(exported_path, name="默认模板", store_path=tmp_path / "templates.json")


def test_replace_template_updates_existing_custom_template(tmp_path) -> None:
    exported_path = tmpl.export_template_xlsx("默认模板", output_dir=tmp_path / "editable")
    imported = tmpl.import_template_xlsx(exported_path, name="老王模板", store_path=tmp_path / "templates.json")
    assert imported.template.version == 1

    from openpyxl import load_workbook

    workbook = load_workbook(exported_path)
    try:
        workbook["模板信息"].cell(row=2, column=2).value = "xlsx里的新名字"
        workbook["模板信息"].cell(row=4, column=2).value = "替换后的说明"
        workbook["运输方式"].cell(row=2, column=2).value = 35
        workbook.save(exported_path)
    finally:
        workbook.close()

    replaced, old_version = tmpl.replace_template_xlsx(
        exported_path,
        template_name="老王模板",
        store_path=tmp_path / "templates.json",
    )

    assert old_version == 1
    assert replaced.template.name == "老王模板"
    assert replaced.template.version == 2
    assert replaced.template.description == "替换后的说明"
    assert replaced.template.params["shipping"]["air_urgent_sales_days_lte"] == 35


def test_replace_rejects_default_and_missing_template(tmp_path) -> None:
    exported_path = tmpl.export_template_xlsx("默认模板", output_dir=tmp_path / "editable")

    with pytest.raises(tmpl.ReplenishmentTemplateError, match="不允许替换"):
        tmpl.replace_template_xlsx(exported_path, template_name="默认模板", store_path=tmp_path / "templates.json")

    with pytest.raises(tmpl.ReplenishmentTemplateError, match="只能替换已存在"):
        tmpl.replace_template_xlsx(exported_path, template_name="不存在", store_path=tmp_path / "templates.json")


def test_rename_template_updates_name_without_version_change(tmp_path) -> None:
    exported_path = tmpl.export_template_xlsx("默认模板", output_dir=tmp_path / "editable")
    tmpl.import_template_xlsx(exported_path, name="自定义模板A", store_path=tmp_path / "templates.json")

    renamed = tmpl.rename_template("自定义模板A", new_name="夏季备货模板", store_path=tmp_path / "templates.json")

    assert renamed.name == "夏季备货模板"
    assert renamed.version == 1
    templates = tmpl.list_templates(store_path=tmp_path / "templates.json")
    assert [template.name for template in templates] == ["默认模板", "夏季备货模板"]


def test_rename_rejects_default_duplicate_and_missing_template(tmp_path) -> None:
    exported_path = tmpl.export_template_xlsx("默认模板", output_dir=tmp_path / "editable")
    tmpl.import_template_xlsx(exported_path, name="模板A", store_path=tmp_path / "templates.json")
    tmpl.import_template_xlsx(exported_path, name="模板B", store_path=tmp_path / "templates.json")

    with pytest.raises(tmpl.ReplenishmentTemplateError, match="不允许重命名"):
        tmpl.rename_template("默认模板", new_name="新默认", store_path=tmp_path / "templates.json")

    with pytest.raises(tmpl.ReplenishmentTemplateError, match="模板名已存在"):
        tmpl.rename_template("模板A", new_name="模板B", store_path=tmp_path / "templates.json")

    with pytest.raises(tmpl.ReplenishmentTemplateError, match="只能重命名已存在"):
        tmpl.rename_template("不存在", new_name="模板C", store_path=tmp_path / "templates.json")


def test_validate_template_detects_invalid_threshold() -> None:
    template = tmpl.load_default_template()
    broken = tmpl.ReplenishmentTemplate(
        name="坏模板",
        version=1,
        description="",
        params={
            **template.params,
            "shipping": {
                "air_urgent_sales_days_lte": 80,
                "air_sales_days_lte": 70,
            },
        },
    )

    with pytest.raises(tmpl.ReplenishmentTemplateError, match="空运急发阈值"):
        tmpl.validate_template(broken)


def test_special_rule_applies_msku_overrides() -> None:
    template = tmpl.load_default_template()
    custom = tmpl.ReplenishmentTemplate(
        name="特殊模板",
        version=1,
        description="",
        params={
            **template.params,
            "special_rules": [
                {
                    "rule_name": "大件规则",
                    "msku_list": ["MSKU-A"],
                    "overrides": {
                        "sea": {"min_weight_kg": 100},
                        "shipping": {"air_urgent_sales_days_lte": 35},
                    },
                }
            ],
        },
    )

    params, rule_name = tmpl.effective_params_for_msku(custom, "MSKU-A")
    assert rule_name == "大件规则"
    assert params["sea"]["min_weight_kg"] == 100
    assert params["shipping"]["air_urgent_sales_days_lte"] == 35

    params, rule_name = tmpl.effective_params_for_msku(custom, "MSKU-B")
    assert rule_name == ""
    assert params["sea"]["min_weight_kg"] == 60


def test_cli_list_and_list_params(capsys) -> None:
    assert cli.main(["list"]) == 0
    payload = _read_payload(capsys)
    assert payload["templates"][0]["name"] == "默认模板"

    assert cli.main(["list-params"]) == 0
    payload = _read_payload(capsys)
    assert payload["groups"][0]["group"] == "加权日销"


def test_cli_show_export_validate_and_import(monkeypatch, tmp_path, capsys) -> None:
    monkeypatch.chdir(tmp_path)

    assert cli.main(["show", "--template", "默认模板"]) == 0
    payload = _read_payload(capsys)
    assert payload["template"]["name"] == "默认模板"

    assert cli.main(["export", "--template", "默认模板"]) == 0
    payload = _read_payload(capsys)
    exported_path = Path(payload["xlsx_path"])
    assert exported_path.is_file()

    assert cli.main(["validate-file", "--xlsx", str(exported_path)]) == 0
    payload = _read_payload(capsys)
    assert payload["template_name"] == "默认模板"

    assert cli.main(["import", "--xlsx", str(exported_path), "--name", "CLI模板"]) == 0
    payload = _read_payload(capsys)
    assert payload["template_name"] == "CLI模板"

    assert cli.main(["replace", "--template", "CLI模板", "--xlsx", str(exported_path)]) == 0
    payload = _read_payload(capsys)
    assert payload["template_name"] == "CLI模板"
    assert payload["old_version"] == 1
    assert payload["new_version"] == 2

    assert cli.main(["rename", "--template", "CLI模板", "--name", "CLI重命名模板"]) == 0
    payload = _read_payload(capsys)
    assert payload["old_name"] == "CLI模板"
    assert payload["new_name"] == "CLI重命名模板"
    assert payload["template_version"] == 2


def test_skill_index_loads_replenishment_template_manage() -> None:
    manifest = load_skill_index(force_reload=True).get("mabang-fba-replenishment-template-manage")

    assert manifest is not None
    assert manifest.name == "mabang-fba-replenishment-template-manage"
    assert manifest.type == "amazon_replenish"
