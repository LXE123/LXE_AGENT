"""Generate one Vietnam recommendation from current inputs only."""

from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
from typing import Iterator
from uuid import uuid4

from shared.datasets import dataset_dir
from shared.input_assets import current_asset

from .asset_contract import AssetContractError, load_sku_parameters
from .recalculation import generate_vietnam_workbook
from .workbook import RecommendationConfig
from .yacang_sources import export_vietnam_sources


class VietnamWorkflowError(RuntimeError):
    """A current input or final output prerequisite failed."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class VietnamRecommendationRun:
    output_xlsx: Path
    sku_count: int


@contextmanager
def current_sku_map_snapshot() -> Iterator[Path]:
    """Validate a private copy of the current map before any Yacang export."""
    version = current_asset("vietnam_sku_parameter_map")
    if version is None:
        raise VietnamWorkflowError(
            "sku_parameter_map_required", "请先上传越南 SKU 参数映射表"
        )

    with TemporaryDirectory(prefix="vietnam-sku-map-") as directory:
        snapshot = Path(directory) / f"current{version.path.suffix}"
        try:
            shutil.copyfile(version.path, snapshot)
        except OSError as exc:
            raise VietnamWorkflowError(
                "sku_parameter_map_unreadable",
                f"当前越南 SKU 参数映射表无法复制: {type(exc).__name__}: {exc}",
            ) from exc
        try:
            parameters = load_sku_parameters(snapshot)
        except AssetContractError as exc:
            raise VietnamWorkflowError("sku_parameter_map_invalid", str(exc)) from exc
        if not parameters:
            raise VietnamWorkflowError(
                "sku_parameter_map_empty", "当前越南 SKU 参数映射表没有 SKU，请重新上传"
            )
        for sku, values in parameters.items():
            for field, label in (
                ("cost", "成本"),
                ("cross_border_price", "跨境价"),
                ("discount_price", "折扣价"),
            ):
                if getattr(values, field) is None:
                    raise VietnamWorkflowError(
                        "sku_parameter_map_invalid",
                        f"SKU {sku} 缺少{label}，请补全当前越南 SKU 参数映射表",
                    )
        yield snapshot


def generate_current_vietnam_recommendation() -> VietnamRecommendationRun:
    """Export VN8806 once, then publish only a validated five-sheet XLSX."""
    with current_sku_map_snapshot() as map_path:
        sources = export_vietnam_sources()
        if not sources.skus:
            raise VietnamWorkflowError("current_skus_empty", "本轮 VN8806 来源没有 SKU")

        output = dataset_dir("vietnam_recommendations", uuid4().hex) / "越南备货清单.xlsx"
        try:
            completed = generate_vietnam_workbook(
                map_path, output, sources=sources, config=RecommendationConfig()
            )
            if Path(completed) != output or not output.is_file() or output.stat().st_size == 0:
                raise VietnamWorkflowError("output_missing", "本轮没有生成最终 XLSX")
        except Exception:
            output.unlink(missing_ok=True)
            raise
        return VietnamRecommendationRun(output_xlsx=output, sku_count=len(sources.skus))


__all__ = [
    "VietnamRecommendationRun",
    "VietnamWorkflowError",
    "current_sku_map_snapshot",
    "generate_current_vietnam_recommendation",
]
