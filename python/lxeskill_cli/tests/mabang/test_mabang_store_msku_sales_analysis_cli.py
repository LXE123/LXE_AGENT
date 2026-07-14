from __future__ import annotations


from services.agent_cli.mabang import analyze_store_msku_sales as cli
from services.mabang.amazon.fba.store_msku_sales_analysis import StoreMskuSalesAnalysisResult


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

    payload = cli.run({"store_name": "Amazon-Lerxiuer-FR"})
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

    payload = cli.run({"store_name": "Amazon-Lerxiuer-FR"})
    assert payload == {
        "success": False,
        "store_name": "Amazon-Lerxiuer-FR",
        "exception": "analysis failed for Amazon-Lerxiuer-FR",
    }
