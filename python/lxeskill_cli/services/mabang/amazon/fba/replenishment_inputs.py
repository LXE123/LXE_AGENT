"""Explicit, verified offline inputs shared by both replenishment versions."""
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
import re

from .source_verification import VerifiedSource, load_verified_source, read_report_metadata
from .store_msku_actual_inventory import SOURCE_FILE_RE
from .unlinked_shipments import load_unlinked_shipment_quantities


@dataclass(frozen=True)
class ReplenishmentInputs:
    store_name: str
    source_path: Path
    inventory_path: Path
    snapshot_path: Path
    source_data_time: str
    source: VerifiedSource
    shipments: dict[str, float]

    def to_payload(self) -> dict:
        return {
            "store_name": self.store_name,
            "source_data_time": self.source_data_time,
            "msku_source_xlsx_path": str(self.source_path),
            "shenzhen_inventory_report_xlsx_path": str(self.inventory_path),
            "unlinked_shipments_snapshot_path": str(self.snapshot_path),
        }


def load_replenishment_inputs(
    store_name: str, *, msku_source_xlsx_path: str | Path,
    shenzhen_inventory_report_xlsx_path: str | Path,
    unlinked_shipments_snapshot_path: str | Path,
) -> ReplenishmentInputs:
    store_name = store_name.strip()
    if not store_name:
        raise ValueError("store_name 不能为空")
    paths = []
    for label, value in (("MSKU 源文件", msku_source_xlsx_path),
                         ("深圳库存报告", shenzhen_inventory_report_xlsx_path),
                         ("未关联货件快照", unlinked_shipments_snapshot_path)):
        if not str(value).strip():
            raise ValueError(f"{label}路径不能为空")
        path = Path(value).expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(f"{label}不存在: {path}")
        paths.append(path)
    source_path, inventory_path, snapshot_path = paths
    match = SOURCE_FILE_RE.match(source_path.name)
    if not match:
        raise ValueError(f"MSKU 源文件名无法识别源数据时间: {source_path.name}")
    source_time = match.group("source_time")
    datetime.strptime(source_time, "%Y%m%d%H%M")
    source = load_verified_source(source_path, store_name=store_name)
    if read_report_metadata(inventory_path) != source.metadata:
        raise ValueError("深圳库存报告与本次 MSKU 源文件核验批次不一致；请使用同一源文件重新导出")
    snapshot_match = re.fullmatch(r"(\d{12})-.+_(?:未关联货件快照|unlinked_shipments_snapshot)\.xlsx", snapshot_path.name, re.IGNORECASE)
    if not snapshot_match:
        raise ValueError(f"未关联货件快照文件名无法识别日期: {snapshot_path}")
    snapshot_time = snapshot_match.group(1)
    datetime.strptime(snapshot_time, "%Y%m%d%H%M")
    if snapshot_time[:8] != source_time[:8]:
        raise ValueError(f"未关联货件快照日期与备货数据日期不一致: source_date={source_time[:8]}, snapshot_date={snapshot_time[:8]}, path={snapshot_path}")
    shipments = load_unlinked_shipment_quantities(snapshot_path, store_name=store_name)
    return ReplenishmentInputs(store_name, source_path, inventory_path, snapshot_path, source_time, source, shipments)
