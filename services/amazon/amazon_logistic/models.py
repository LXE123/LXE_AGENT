from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Optional


@dataclass
class BoxInput:
    """单箱输入参数。"""

    gross_weight: Decimal
    length: Decimal
    width: Decimal
    height: Decimal


@dataclass
class PricingRequest:
    """物流渠道推荐请求参数。"""

    warehouse: str
    address: str
    transport_mode: str
    cargo_nature: str
    boxes: list[BoxInput]
    tax_included: str = "any"
    target_country: Optional[str] = None
    top_n: int = 3
    allow_any_destination: bool = False
    verbose_rejected: bool = False
    max_rejected_details: int = 3
    has_textile: bool = False

    @property
    def destination(self) -> str:
        return f"{self.warehouse} {self.address}".strip()
