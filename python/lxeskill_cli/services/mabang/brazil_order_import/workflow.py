from __future__ import annotations

from datetime import datetime
from pathlib import Path
from uuid import uuid4
from zoneinfo import ZoneInfo

from shared.datasets import dataset_dir
from .workbook import generate_order_workbook


def run(*, input_xlsx: str, shipping_column: str | None = None) -> dict:
    today = datetime.now(ZoneInfo("Asia/Shanghai")).date()
    order_id = f"BR{today:%y%m%d}-H"
    output = dataset_dir("mabang_brazil_order_import", uuid4().hex) / f"巴西马帮订单导入模板-{order_id}.xlsx"
    result = generate_order_workbook(
        input_xlsx,
        output,
        today=today,
        shipping_column=shipping_column,
    )
    if not Path(result["output_xlsx"]).is_file() or Path(result["output_xlsx"]).stat().st_size == 0:
        raise RuntimeError("生成结果文件不存在或为空")
    return result
