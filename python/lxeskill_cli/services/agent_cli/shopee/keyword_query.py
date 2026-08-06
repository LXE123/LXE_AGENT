"""`lxeskill shopee keywords query` — 查询已生成的搜索量 Excel，不重新抓取。"""
from __future__ import annotations

from typing import Any

from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.agent_cli.shopee.report import (
    REPORT_FILE_NAME,
    list_countries,
    query_report,
)
from shared.datasets import dataset_dir


def _report_path() -> Any:
    return dataset_dir("shopee_keyword_search", REPORT_FILE_NAME)


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    try:
        report_path = _report_path()
        if not report_path.is_file():
            return {
                "success": False,
                "error_kind": "report_missing",
                "exception": (
                    f"Excel 不存在：{report_path}。"
                    "请先运行 lxeskill shopee keywords export 抓取数据"
                ),
            }
        if bool(arguments.get("list_countries")):
            return {"success": True, "file": str(report_path), "countries": list_countries(report_path)}
        top = int(arguments.get("top") or 10)
        if top <= 0 or top > 100:
            raise ValueError("top 必须在 1 到 100 之间")
        result = query_report(
            report_path,
            str(arguments.get("country") or "").strip() or None,
            str(arguments.get("keyword") or "").strip() or None,
            top,
        )
        return {"success": True, **result}
    except Exception as exc:  # noqa: BLE001 — failure context belongs in the payload
        return {"success": False, "exception": f"{type(exc).__name__}: {_exception_text(exc)}"}
