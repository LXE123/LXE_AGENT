"""Calculate one Vietnam recommendation from explicitly supplied local reports."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import shutil
from tempfile import TemporaryDirectory
from uuid import uuid4

from shared.datasets import dataset_dir
from shared.filesystem import display_path
from shared.workspace import resolve_workspace_input

from .asset_contract import load_template_sku_parameters
from .full_workbook import REQUIRED_ORDER
from .settings import run_inputs
from .recalculation import generate_vietnam_workbook
from .workbook import RecommendationConfig
from .yacang_sources import VietnamSources, load_vietnam_files


class VietnamWorkflowError(RuntimeError):
    """A current input or final output prerequisite failed."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class VietnamRecommendationRun:
    output_xlsx: Path
    sku_count: int
    config: RecommendationConfig
    config_source: str
    template_source: str
    source_files: tuple[dict, ...]
    validation: dict


def generate_current_vietnam_recommendation(
    *, sales: str, inventory: str, products: str, template: str | None = None,
) -> VietnamRecommendationRun:
    """Read the supplied reports and saved settings; never start an ERP export."""
    if template is None:
        raise VietnamWorkflowError("template_missing", "未提供越南备货九表模板；请在设置页上传当前模板，或为本轮指定 --template-file")
    with run_inputs() as (config, config_source):
        sources = load_vietnam_files(sales=sales, inventory=inventory, products=products)
        return _generate_from_sources(sources, config, config_source, template)


def _generate_from_sources(
    sources: VietnamSources, config: RecommendationConfig,
    config_source: str, template: str,
) -> VietnamRecommendationRun:
    if not sources.skus:
        raise VietnamWorkflowError("current_skus_empty", "本轮 VN8806 来源没有 SKU")

    with TemporaryDirectory(prefix="vietnam-template-") as directory:
        template_source = resolve_workspace_input(template)
        template_snapshot = Path(directory) / "business-template.xlsx"
        shutil.copyfile(template_source, template_snapshot)
        parameters = load_template_sku_parameters(template_snapshot, set(sources.skus))
        output = dataset_dir("vietnam_recommendations", uuid4().hex) / "越南备货清单.xlsx"
        try:
            completed = generate_vietnam_workbook(
                output, sources=sources, config=config,
                template=template_snapshot, parameters=parameters,
            )
            if Path(completed) != output or not output.is_file() or output.stat().st_size == 0:
                raise VietnamWorkflowError("output_missing", "本轮没有生成最终 XLSX")
        except Exception:
            output.unlink(missing_ok=True)
            raise
    return VietnamRecommendationRun(
        output_xlsx=output, sku_count=len(sources.skus),
        config=config, config_source=config_source, template_source=str(display_path(template_source)),
        source_files=tuple({
            "report": report, "path": str(display_path(path)),
            "sha256": sources.file_hashes[report],
        } for report, path in sources.artifacts.items()),
        validation={
            "status": "passed", "sku_count": len(sources.skus),
            "sheets": list(REQUIRED_ORDER),
            "checks": ["source_schema", "sku_coverage", "source_values", "formulas", "recalculated_results", "parameters"],
            "missing_mapping_count": sum(sku not in parameters for sku in sources.skus),
            "in_transit_mismatch_count": len(sources.in_transit_mismatch),
        },
    )


__all__ = [
    "VietnamRecommendationRun",
    "VietnamWorkflowError",
    "generate_current_vietnam_recommendation",
]
