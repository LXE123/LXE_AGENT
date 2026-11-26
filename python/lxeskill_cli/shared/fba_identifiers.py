"""FBA shipment and box identifiers shared by Amazon and logistics queries."""
from __future__ import annotations

import re
from typing import Any

FBA_PATTERN = re.compile(r"FBA[A-Z0-9]{7,}")
BOX_PATTERN = re.compile(r"(FBA[A-Z0-9]{7,})(U[0-9]{6})")


def validate_fba(value: str) -> None:
    if len(value) > 64 or not FBA_PATTERN.fullmatch(value):
        raise ValueError("fba must be one complete uppercase FBA identifier (including any box suffix)")


def normalize_identifier(raw: str, kind: str = "auto") -> dict[str, Any]:
    """Strip only the captured terminal box layout; preserve the original input."""
    if not isinstance(raw, str):
        raise ValueError("fba must be a string")
    value = raw.strip()
    validate_fba(value)
    if kind not in ("auto", "shipment", "box"):
        raise ValueError("identifier_kind must be auto, shipment or box")
    box = BOX_PATTERN.fullmatch(value) if kind != "shipment" else None
    if kind == "box" and box is None:
        raise ValueError("box identifier must end in the observed U + six digits layout")
    return {
        "input_fba": raw,
        "fba": box[1] if box else value,
        "box_suffix": box[2] if box else None,
        "identifier_kind": kind,
        "normalization_rule": "terminal_U_six_digits" if box else "unchanged",
    }
