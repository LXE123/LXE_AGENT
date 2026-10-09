"""Generate one Vietnam recommendation from current inputs only."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import os
from pathlib import Path
from typing import Literal, Mapping
from uuid import uuid4

from shared.datasets import dataset_dir

from .sku_map_store import SkuMapStoreError, current_sku_map_snapshot as trusted_map_snapshot
from .recalculation import generate_vietnam_workbook
from .workbook import (
    RecommendationConfig,
    WorkbookInputError,
    validate_recommendation_config,
)
from .yacang_sources import export_vietnam_sources


class VietnamWorkflowError(RuntimeError):
    """A current input or final output prerequisite failed."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


ConfigSource = Literal["environment", "default"]
ENV_NAMES = (
    "LXE_VIETNAM_WEIGHT_30D",
    "LXE_VIETNAM_WEIGHT_15D",
    "LXE_VIETNAM_WEIGHT_7D",
    "LXE_VIETNAM_EXCHANGE_RATE",
)


@dataclass(frozen=True)
class VietnamRecommendationRun:
    output_xlsx: Path
    sku_count: int
    config: RecommendationConfig
    config_source: ConfigSource


def resolve_recommendation_config(
    environ: Mapping[str, str],
) -> tuple[RecommendationConfig, ConfigSource]:
    """Use defaults only when the four variables are all absent."""
    if all(name not in environ for name in ENV_NAMES):
        return RecommendationConfig(), "default"

    values: list[Decimal] = []
    for name in ENV_NAMES:
        raw = environ.get(name)
        if raw is None or not isinstance(raw, str) or not raw.strip():
            raise VietnamWorkflowError("recommendation_config_invalid", f"{name} 缺失或为空")
        try:
            values.append(Decimal(raw.strip()))
        except (InvalidOperation, TypeError, ValueError) as exc:
            raise VietnamWorkflowError(
                "recommendation_config_invalid",
                f"{name} 不是十进制数: {type(exc).__name__}: {exc}",
            ) from exc

    config = RecommendationConfig(*values)
    try:
        validate_recommendation_config(config)
    except (WorkbookInputError, ArithmeticError, ValueError) as exc:
        raise VietnamWorkflowError(
            "recommendation_config_invalid", f"{type(exc).__name__}: {exc}"
        ) from exc
    return config, "environment"


def current_sku_map_snapshot():
    """Provide a trusted private map snapshot before any Yacang export."""
    return trusted_map_snapshot()


def generate_current_vietnam_recommendation() -> VietnamRecommendationRun:
    """Export VN8806 once, then publish only a validated five-sheet XLSX."""
    try:
        snapshot = current_sku_map_snapshot()
        with snapshot as map_path:
            return _generate_from_map(map_path)
    except SkuMapStoreError as exc:
        code = (
            "sku_parameter_map_required" if "请先上传" in str(exc)
            else "sku_parameter_map_empty" if "没有 SKU" in str(exc)
            else "sku_parameter_map_invalid"
        )
        raise VietnamWorkflowError(code, str(exc)) from exc


def _generate_from_map(map_path: Path) -> VietnamRecommendationRun:
    config, config_source = resolve_recommendation_config(os.environ)
    sources = export_vietnam_sources()
    if not sources.skus:
        raise VietnamWorkflowError("current_skus_empty", "本轮 VN8806 来源没有 SKU")

    output = dataset_dir("vietnam_recommendations", uuid4().hex) / "越南备货清单.xlsx"
    try:
        completed = generate_vietnam_workbook(
            map_path, output, sources=sources, config=config
        )
        if Path(completed) != output or not output.is_file() or output.stat().st_size == 0:
            raise VietnamWorkflowError("output_missing", "本轮没有生成最终 XLSX")
    except Exception:
        output.unlink(missing_ok=True)
        raise
    return VietnamRecommendationRun(
        output_xlsx=output, sku_count=len(sources.skus),
        config=config, config_source=config_source,
    )


__all__ = [
    "VietnamRecommendationRun",
    "VietnamWorkflowError",
    "current_sku_map_snapshot",
    "generate_current_vietnam_recommendation",
    "resolve_recommendation_config",
]
