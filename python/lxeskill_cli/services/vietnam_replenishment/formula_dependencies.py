"""Mapping inputs needed by each Vietnam replenishment result formula."""

from __future__ import annotations

from typing import Mapping


MAPPING_FORMULA_INPUTS: Mapping[str, tuple[str, ...]] = {
    "H": ("B",),
    "AC": ("B",),
    "AF": ("AE",),
    "AG": ("AE", "G"),
    "AH": ("AE", "G"),
    "AI": ("AE",),
    "AK": ("AJ",),
    "AL": ("AJ", "G"),
    "AM": ("AJ", "G"),
}


def mapping_formula_blank(column: str, literals: Mapping[str, object]) -> bool:
    """Return whether a result depends on an absent direct mapping value."""
    return any(literals[name] is None for name in MAPPING_FORMULA_INPUTS.get(column, ()))


def guarded_mapping_formula(
    formula: str, column: str, row_number: int, literals: Mapping[str, object],
) -> str:
    """Make only missing-input results recalculate to an empty string."""
    if not mapping_formula_blank(column, literals):
        return formula
    if not formula.startswith("="):
        raise ValueError(f"{column}{row_number} is not a formula")
    tests = [f"ISBLANK({name}{row_number})" for name in MAPPING_FORMULA_INPUTS[column]]
    condition = tests[0] if len(tests) == 1 else f"OR({','.join(tests)})"
    return f'=IF({condition},"",{formula[1:]})'


__all__ = ["MAPPING_FORMULA_INPUTS", "mapping_formula_blank", "guarded_mapping_formula"]
