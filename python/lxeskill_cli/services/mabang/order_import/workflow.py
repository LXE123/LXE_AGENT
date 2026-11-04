from __future__ import annotations

from datetime import datetime
from importlib.resources import as_file, files
from pathlib import Path
import shutil
from uuid import uuid4
from zoneinfo import ZoneInfo

from shared.datasets import dataset_dir
from . import brazil, malaysia, vietnam
from .workbook import OrderImportWorkbookError


COUNTRIES = ("brazil", "malaysia", "vietnam")


def run(*, country: str, input_xlsx: str, shipping_column: str | None = None) -> dict:
    if country not in COUNTRIES:
        raise OrderImportWorkbookError(f"country 仅支持: {', '.join(COUNTRIES)}")
    if country == "malaysia" and shipping_column is not None:
        raise OrderImportWorkbookError("shipping_column 仅用于巴西或越南备货清单")

    today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    resource = files("services.mabang.order_import").joinpath("resources", "template.xlsx")
    with as_file(resource) as template_path:
        if country == "brazil":
            order_id = f"BR{today:%y%m%d}-H"
            output_dir = dataset_dir("mabang_brazil_order_import", uuid4().hex)
            output = output_dir / f"巴西马帮订单导入模板-{order_id}.xlsx"
            result = brazil.generate_order_workbook(
                input_xlsx,
                output,
                today=today,
                shipping_column=shipping_column,
                template_path=template_path,
            )
            artifacts = [{"path": result.pop("output_xlsx"), **result}]
        elif country == "malaysia":
            run_dir = uuid4().hex
            output_dir = dataset_dir("mabang_malaysia_order_import", run_dir)
            try:
                artifacts = malaysia.generate_order_workbooks(
                    input_xlsx,
                    output_dir,
                    today=today,
                    template_path=template_path,
                )
            except Exception:
                shutil.rmtree(output_dir, ignore_errors=True)
                raise
            artifacts = [{"path": item.pop("output_xlsx"), **item} for item in artifacts]
        else:
            output_dir = dataset_dir("mabang_vietnam_order_import", uuid4().hex)
            output = output_dir / "generated.xlsx"
            try:
                result = vietnam.generate_order_workbook(
                    input_xlsx,
                    output,
                    today=today,
                    shipping_column=shipping_column,
                    template_path=template_path,
                )
                final_output = output_dir / f"越南马帮订单导入模板-{result['order_id']}.xlsx"
                Path(result["output_xlsx"]).replace(final_output)
                result["output_xlsx"] = final_output
            except Exception:
                shutil.rmtree(output_dir, ignore_errors=True)
                raise
            artifacts = [{"path": result.pop("output_xlsx"), **result}]

    for artifact in artifacts:
        output = Path(artifact["path"])
        if not output.is_file() or output.stat().st_size == 0:
            raise RuntimeError("生成结果文件不存在或为空")
    return {
        "country": country,
        "artifacts": artifacts,
        "sku_count": artifacts[0]["sku_count"],
        "order_ids": [artifact["order_id"] for artifact in artifacts],
    }
