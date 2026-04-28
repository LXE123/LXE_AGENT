"""Transport-mode selection and sea submode filtering."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

from .classifier import is_matson_channel_name
from .modes import normalize_transport_mode, resolve_base_transport_mode, transport_mode_label


@dataclass
class TransportSelection:
    requested_transport_mode: str
    requested_transport_mode_label: str
    base_transport_mode: str
    effective_transport_mode: str
    effective_transport_mode_label: str
    fallback_applied: bool = False
    fallback_reason: str = ""
    base_candidate_count: int = 0
    effective_candidate_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def resolve_transport_selection(transport_mode_requested: Any, default_transport_mode: str = "air") -> TransportSelection:
    requested = normalize_transport_mode(transport_mode_requested) or normalize_transport_mode(default_transport_mode) or "air"
    base_transport_mode = resolve_base_transport_mode(requested, default=default_transport_mode)
    return TransportSelection(
        requested_transport_mode=requested,
        requested_transport_mode_label=transport_mode_label(requested),
        base_transport_mode=base_transport_mode,
        effective_transport_mode=requested,
        effective_transport_mode_label=transport_mode_label(requested),
    )


def filter_candidates_for_requested_transport_mode(
    rows: list[dict[str, Any]],
    selection: TransportSelection,
) -> tuple[list[dict[str, Any]], TransportSelection]:
    selection.base_candidate_count = len(rows)
    selection.effective_candidate_count = len(rows)

    if selection.base_transport_mode != "sea" or selection.requested_transport_mode == "sea":
        return rows, selection

    if selection.requested_transport_mode == "sea_matson":
        filtered = [row for row in rows if is_matson_channel_name(row.get("channel_name"))]
        if filtered:
            selection.effective_candidate_count = len(filtered)
            return filtered, selection
        selection.effective_transport_mode = "sea"
        selection.effective_transport_mode_label = transport_mode_label("sea")
        selection.fallback_applied = True
        selection.fallback_reason = "未找到匹配“美森海运”的渠道，已回退到全部海运渠道。"
        return rows, selection

    if selection.requested_transport_mode == "sea_non_matson":
        filtered = [row for row in rows if not is_matson_channel_name(row.get("channel_name"))]
        if filtered:
            selection.effective_candidate_count = len(filtered)
            return filtered, selection
        selection.effective_transport_mode = "sea"
        selection.effective_transport_mode_label = transport_mode_label("sea")
        selection.fallback_applied = True
        selection.fallback_reason = "未找到匹配“非美森海运”的渠道，已回退到全部海运渠道。"
        return rows, selection

    return rows, selection
