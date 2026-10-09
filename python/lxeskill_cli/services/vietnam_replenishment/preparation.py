"""Compose one current Vietnam run into an operations SKU upload workbook."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from .asset_contract import load_sku_parameters, validate_template
from .operator_map import write_operator_sku_map
from .sku_parameters import ResolvedSkuParameters, load_template_sku_parameters, resolve_sku_parameters
from .yacang_sources import VietnamSources, export_vietnam_sources


@dataclass(frozen=True)
class OperatorMapPreparation:
    path: Path
    sources: VietnamSources
    resolved: Mapping[str, ResolvedSkuParameters]


def prepare_operator_sku_map(
    template_path: str | Path,
    output_path: str | Path,
    current_map_path: str | Path | None = None,
    *,
    sources: VietnamSources | None = None,
) -> OperatorMapPreparation:
    """Prepare upload inputs from one current VN run without writing a recommendation.

    The caller supplies copied local assets. If ``sources`` is absent, the
    existing 雅仓 workflow performs exactly one three-report export run.
    """
    output = Path(output_path)
    if output.exists():
        raise FileExistsError(output)
    validate_template(template_path)
    explicit = load_sku_parameters(current_map_path) if current_map_path is not None else {}
    current = sources if sources is not None else export_vietnam_sources()
    history = load_template_sku_parameters(template_path, current.skus)
    resolved = resolve_sku_parameters(current.skus, explicit, history)
    path = write_operator_sku_map(output, current, explicit, history)
    return OperatorMapPreparation(path=path, sources=current, resolved=resolved)


__all__ = ["OperatorMapPreparation", "prepare_operator_sku_map"]
