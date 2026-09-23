from __future__ import annotations

import math
from typing import Any, Iterable


def reject_unknown_arguments(arguments: dict[str, Any], allowed: Iterable[str]) -> None:
    allowed_set = {str(name) for name in allowed}
    unknown = sorted(str(name) for name in arguments if name not in allowed_set)
    if unknown:
        raise ValueError(f"不允许的雅仓参数: {', '.join(unknown)}")


def bounded_number(
    value: Any,
    *,
    name: str,
    default: float,
    minimum: float,
    maximum: float,
) -> float:
    number = float(default if value is None else value)
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise ValueError(f"{name} 必须在 {minimum:g} 到 {maximum:g} 之间且为有限数字")
    return number


__all__ = ["bounded_number", "reject_unknown_arguments"]
