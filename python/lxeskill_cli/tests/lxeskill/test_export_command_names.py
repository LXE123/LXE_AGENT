from __future__ import annotations

import json
from copy import deepcopy

import pytest

from lxeskill import cli
from lxeskill.business import load_catalog
from services.agent_cli._shared.report_names import BRAZIL_REPORTS, YACANG_REPORTS, public_reports
from services.agent_cli.yacang import export_run as yacang
from services.agent_cli.mabang import brazil_overseas_export as brazil

CASES = [('yacang_export_run',
  'yacang export run',
  'yacang reports export',
  [],
  ['--report', 'inventory-sales', '--report', 'inventory', '--report', 'products', '--warehouse', 'VN8806']),
 ('shangman_goods_export', 'shangman export run', 'shangman products export', [], []),
 ('mabang_tms_export_run', 'mabang-tms export run', 'mabang-tms products export', [], []),
 ('mabang_brazil_overseas_export',
  'mabang brazil-overseas export run',
  'mabang brazil reports export',
  [],
  ['--report', 'inventory-sales']),
 ('mabang_download_store_msku_excel',
  'replenish msku download',
  'mabang store msku export',
  ['mabang_download_store_msku_excel'],
  ['--store-id', '123', '--id-type', 'shopId', '--store-name', '店铺 A']),
 ('mabang_export_store_msku_actual_inventory',
  'replenish inventory actual-export',
  'mabang store shenzhen-inventory export',
  ['mabang_export_store_msku_actual_inventory'],
  ['--store-name', '店铺 A']),
 ('mabang_download_store_unlinked_shipments',
  'replenish shipments unlinked-download',
  'mabang store unlinked-shipments export',
  ['mabang_download_store_unlinked_shipments'],
  ['--store-name', '店铺 A', '--timeout-seconds', '180', '--poll-interval-seconds', '10']),
 ('mabang_download_msku_detail_excel',
  'fba msku detail-download',
  'mabang delivery msku export',
  ['mabang_download_msku_detail_excel'],
  ['--delivery-no', 'SP123']),
 ('mabang_download_fba_delivery_csv',
  'fba shipment delivery-csv-download',
  'mabang delivery export',
  ['mabang_download_fba_delivery_csv'],
  ['--delivery-no', 'SP123']),
 ('mabang_download_wms_consignment_excel',
  'fba shipment wms-box-download',
  'mabang delivery packing-list export',
  ['mabang_download_wms_consignment_excel'],
  ['--delivery-no', 'SP123']),
 ('mabang_download_stock_sku_excel',
  'fba stock-sku download',
  'mabang delivery inventory-sku export',
  ['mabang_download_stock_sku_excel'],
  ['--delivery-no', 'SP123']),
 ('vietnam_replenishment_generate',
  'vietnam stock recommend',
  'vietnam replenishment calculate',
  [],
  ['--sales-file',
   'C:/数据 源/销量.xlsx',
   '--inventory-file',
   'C:/数据 源/库存.xlsx',
   '--products-file',
   'C:/数据 源/产品.xlsx',
   '--sku-map-file',
   'C:/数据 源/映射.xlsx'])]


@pytest.mark.parametrize("name,old,new,aliases,options", CASES)
def test_new_commands_dispatch_with_flags_only(name, old, new, aliases, options, monkeypatch, capsys):
    calls = []
    monkeypatch.delenv("LXESKILL_SKILL_SCOPE", raising=False)
    def execute(entry, arguments, session, **kwargs):
        calls.append((entry["name"], arguments))
        return True, [{"text": "{}"}], [], None
    monkeypatch.setattr(cli, "execute_module_json", execute)
    assert cli.main([*new.split(), *options]) == 0
    assert calls and calls[0][0] == name
    if "--sales-file" in options:
        assert calls[0][1]["sales_file"] == "C:/数据 源/销量.xlsx"
    assert json.loads(capsys.readouterr().out)["command"] == new
    entry = load_catalog()[name]
    assert entry["input_modes"] == ["flags"]
    assert not entry.get("legacy_aliases")
    assert entry["owner_skills"] == ["vietnam-replenishment" if new.startswith("vietnam") else new.replace(" ", "-")]
    assert cli.main([*new.split(), "--help"]) == 0
    assert json.loads(capsys.readouterr().out)["data"]["input_modes"] == ["flags"]


@pytest.mark.parametrize("name,old,new,aliases,options", CASES)
def test_old_commands_and_json_modes_never_execute(name, old, new, aliases, options, monkeypatch, capsys):
    def unexpected(*args, **kwargs):
        pytest.fail("invalid command must not execute business code")
    monkeypatch.setattr(cli, "execute_module_json", unexpected)
    monkeypatch.delenv("LXESKILL_SKILL_SCOPE", raising=False)
    for invocation in [old.split(), *[[alias] for alias in aliases],
                       [*new.split(), "--input-json", "/does/not/exist.json"],
                       [*new.split(), "--stdin-json"],
                       [*new.split(), "--input-json=/does/not/exist.json"]]:
        assert cli.main(invocation) == cli.EXIT_USAGE
        assert json.loads(capsys.readouterr().out)["ok"] is False


@pytest.mark.parametrize("command,option", [
    ("yacang reports export", "--params"),
    ("mabang brazil reports export", "--params"),
    ("vietnam replenishment calculate", "--sales"),
    ("vietnam replenishment calculate", "--sku-map"),
    ("mabang delivery msku export", "--ship-no"),
    ("mabang delivery packing-list export", "--ship-no"),
    ("mabang delivery export", "--timeout-sec"),
    ("mabang store unlinked-shipments export", "--poll-interval-sec"),
])
def test_removed_options_fail_before_business(command, option, monkeypatch, capsys):
    def unexpected(*args, **kwargs):
        pytest.fail("removed option must not execute business code")
    monkeypatch.setattr(cli, "execute_module_json", unexpected)
    assert cli.main([*command.split(), option, "old-value"]) == cli.EXIT_USAGE
    assert json.loads(capsys.readouterr().out)["error"]["code"] == "invalid_arguments"


def test_yacang_boundary_preserves_requests_and_diagnostics(monkeypatch):
    from services.yacang.contracts import normalize
    calls = []
    error = {"message": "actual inventory-current-snapshot remote failure", "code": "remote_error"}
    def export(arguments):
        calls.append(arguments)
        params = normalize(arguments["params"])
        return {"success": False, "params": params, "tasks": [{"report": "inventory-current-snapshot", "error": error, "filters": {"report": "warehouse-products"}}], "artifacts": [{"report": "warehouse-products", "path": "original.xlsx"}]}
    monkeypatch.setattr(yacang, "export_reports", export)
    result = yacang.run({"report": ["inventory-sales", "inventory", "products"], "warehouse": ["VN8806", "MY8801"], "created_from": "2026-01-01", "created_to": "2026-10-01"})
    assert calls == [{"params": {"reports": list(YACANG_REPORTS.values()), "warehouses": ["VN8806", "MY8801"], "created_date": {"start_date": "2026-01-01", "end_date": "2026-10-01"}}}]
    assert result["params"]["reports"] == list(YACANG_REPORTS)
    assert result["tasks"][0]["report"] == "inventory"
    assert result["tasks"][0]["error"] == error
    assert result["tasks"][0]["filters"] == {"report": "warehouse-products"}
    assert result["artifacts"] == [{"report": "products", "path": "original.xlsx"}]


@pytest.mark.parametrize("arguments", [{}, {"params": {}}, {"report": []}, {"report": ["warehouse-products"]}, {"report": ["inventory-sales"], "created_from": "2026-01-01"}, {"report": ["inventory-sales"], "created_to": "2026-01-01"}])
def test_invalid_yacang_inputs_do_not_start_export(arguments, monkeypatch):
    monkeypatch.setattr(yacang, "export_reports", lambda _: pytest.fail("export must not run"))
    assert yacang.run(arguments)["error"]["code"] == "invalid_arguments"


def test_brazil_boundary_keeps_original_platform_report_ids(monkeypatch):
    calls = []
    def export(arguments):
        calls.append(arguments)
        return {"success": True, "tasks": [{"report": report, "time_scope": "original scope"} for report in arguments["params"]["reports"]]}
    monkeypatch.setattr(brazil, "export_reports", export)
    result = brazil.run({"report": list(BRAZIL_REPORTS)})
    assert calls == [{"params": {"reports": list(BRAZIL_REPORTS.values())}}]
    assert [task["report"] for task in result["tasks"]] == list(BRAZIL_REPORTS)
    assert all(task["time_scope"] == "original scope" for task in result["tasks"])
    for arguments in ({}, {"params": {}}, {"report": ["allocation_pending_default_3m"]}):
        assert brazil.run(arguments)["error"]["code"] == "invalid_arguments"
    assert len(calls) == 1


def test_public_report_conversion_does_not_mutate_source_metadata():
    source = {"source_files": [{"report": "warehouse-products", "path": "warehouse-products.xlsx", "sha256": "a" * 64}], "error": {"message": "warehouse-products failed"}}
    original = deepcopy(source)
    result = public_reports(source, YACANG_REPORTS)
    assert source == original
    assert result["source_files"][0] == {**source["source_files"][0], "report": "products"}
    assert result["error"] == source["error"]


@pytest.mark.parametrize("modes", [[], "flags", ["stdin-json"], ["flags", "flags"]])
def test_catalog_rejects_invalid_input_modes(modes, monkeypatch):
    from pathlib import Path
    original = Path.read_text
    def read(path, *args, **kwargs):
        text = original(path, *args, **kwargs)
        if path.name == "catalog.json":
            document = json.loads(text)
            document["entries"][0]["input_modes"] = modes
            return json.dumps(document)
        return text
    monkeypatch.setattr(Path, "read_text", read)
    with pytest.raises(RuntimeError, match="invalid lxeskill input modes"):
        load_catalog()
