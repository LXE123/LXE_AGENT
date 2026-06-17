from __future__ import annotations

import json

from agent_runtime.skill_index import load_skill_index
from services.agent_cli.mabang import analyze_store_msku_sales as cli
from services.mabang.amazon.fba.store_msku_sales_analysis import StoreMskuSalesAnalysisResult


def _read_payload(capsys) -> dict:
    output = capsys.readouterr().out.strip().splitlines()
    assert output
    return json.loads(output[-1])


def test_missing_store_name_returns_failure_json(capsys) -> None:
    exit_code = cli.main([])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "",
        "exception": "store_name 不能为空",
    }


def test_success_returns_sales_analysis_report_path(monkeypatch, capsys) -> None:
    def fake_analyze_store_msku_sales(store_name: str):
        assert store_name == "Amazon-Lerxiuer-FR"
        return StoreMskuSalesAnalysisResult(
            store_name="Amazon-Lerxiuer-FR",
            source_xlsx_path="artifacts/mabang_store_msku/202605251530-Amazon-Lerxiuer-FR_店铺MSKU数据.xlsx",
            source_data_time="202605251530",
            data_is_stale=True,
            link_count=18,
            asin_count=72,
            msku_count=180,
            report_xlsx_path="artifacts/mabang_store_msku_analysis/202605251530-Amazon-Lerxiuer-FR_销量分析.xlsx",
        )

    monkeypatch.setattr(cli, "analyze_store_msku_sales", fake_analyze_store_msku_sales)

    exit_code = cli.main(["--store-name", "Amazon-Lerxiuer-FR"])

    payload = _read_payload(capsys)
    assert exit_code == 0
    assert payload == {
        "success": True,
        "store_name": "Amazon-Lerxiuer-FR",
        "source_xlsx_path": "artifacts/mabang_store_msku/202605251530-Amazon-Lerxiuer-FR_店铺MSKU数据.xlsx",
        "source_data_time": "202605251530",
        "data_is_stale": True,
        "link_count": 18,
        "asin_count": 72,
        "msku_count": 180,
        "report_xlsx_path": "artifacts/mabang_store_msku_analysis/202605251530-Amazon-Lerxiuer-FR_销量分析.xlsx",
        "source": "mabang_store_msku_sales_analysis",
    }


def test_analysis_error_returns_failure_json(monkeypatch, capsys) -> None:
    def fake_analyze_store_msku_sales(store_name: str):
        raise RuntimeError(f"analysis failed for {store_name}")

    monkeypatch.setattr(cli, "analyze_store_msku_sales", fake_analyze_store_msku_sales)

    exit_code = cli.main(["--store-name", "Amazon-Lerxiuer-FR"])

    payload = _read_payload(capsys)
    assert exit_code == 1
    assert payload == {
        "success": False,
        "store_name": "Amazon-Lerxiuer-FR",
        "exception": "analysis failed for Amazon-Lerxiuer-FR",
    }


def test_skill_index_loads_mabang_fba_store_msku_sales_analyze() -> None:
    manifest = load_skill_index(force_reload=True).get("replenishment-sales-analyze")

    assert manifest is not None
    assert manifest.name == "replenishment-sales-analyze"
    assert manifest.type == "amazon_replenish"
