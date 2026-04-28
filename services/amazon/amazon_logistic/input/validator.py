"""Normalization and validation helpers for FBA logistics."""

from __future__ import annotations

import re
from typing import Any

VALID_SHIPMENT_PATTERN = re.compile(r"^FBA[A-Z0-9]{4,}$")


def normalize_shipment_no(value: Any) -> str:
    return str(value or "").strip().upper()


def normalize_consignment_no(value: Any) -> str:
    return str(value or "").strip().upper()
