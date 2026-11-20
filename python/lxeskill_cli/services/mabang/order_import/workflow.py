from __future__ import annotations

from datetime import datetime
from importlib.resources import as_file, files
from pathlib import Path
import shutil
from typing import Mapping
from uuid import uuid4
from zoneinfo import ZoneInfo

from shared.datasets import dataset_dir
from . import country_rules
from .workbook import OrderImportWorkbookError


COUNTRIES = country_rules.COUNTRIES


def run(
    *,
    country: str,
    input_xlsx: str,
    shipping_column: str | None = None,
    shipping_columns: Mapping[str, str] | None = None,
) -> dict:
    if country not in COUNTRIES:
        raise OrderImportWorkbookError(f"country 仅支持: {', '.join(COUNTRIES)}")
    if country not in {"brazil", "vietnam"} and shipping_column is not None:
        raise OrderImportWorkbookError("shipping_column 仅用于巴西或越南备货清单")
    if country != "philippines" and shipping_columns:
        raise OrderImportWorkbookError("按运输方式指定列仅用于菲律宾备货清单")

    today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    resource = files("services.mabang.order_import").joinpath("resources", "template.xlsx")
    with as_file(resource) as template_path:
        output_dir = dataset_dir(country_rules.DATASET_IDS[country], uuid4().hex)
        try:
            results = country_rules.generate_order_workbooks(
                country,
                input_xlsx,
                output_dir,
                today=today,
                template_path=template_path,
                shipping_column=shipping_column,
                shipping_columns=shipping_columns,
            )
            artifacts = [{"path": item.pop("output_xlsx"), **item} for item in results]
        except Exception:
            shutil.rmtree(output_dir, ignore_errors=True)
            raise

    try:
        for artifact in artifacts:
            output = Path(artifact["path"])
            if not output.is_file() or output.stat().st_size == 0:
                raise RuntimeError("生成结果文件不存在或为空")
    except Exception:
        shutil.rmtree(output_dir, ignore_errors=True)
        raise
    return {
        "country": country,
        "artifacts": artifacts,
        "sku_count": artifacts[0]["sku_count"],
        "order_ids": [artifact["order_id"] for artifact in artifacts],
    }
