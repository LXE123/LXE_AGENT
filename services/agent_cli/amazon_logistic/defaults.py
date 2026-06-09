from __future__ import annotations

DEFAULT_TRANSPORT_MODE = "air"
DEFAULT_CARGO_NATURE = "general"
DEFAULT_TAX_INCLUDED = "any"
DEFAULT_QUOTE_BOXES = [
    {"gross_weight": 12, "length": 40, "width": 30, "height": 20},
]


__all__ = [
    "DEFAULT_CARGO_NATURE",
    "DEFAULT_QUOTE_BOXES",
    "DEFAULT_TAX_INCLUDED",
    "DEFAULT_TRANSPORT_MODE",
]
