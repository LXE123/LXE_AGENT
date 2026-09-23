from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable


@dataclass(frozen=True)
class Warehouse:
    code: str
    warehouse_id: int
    display_name: str
    aliases: tuple[str, ...] = ()


WAREHOUSES: tuple[Warehouse, ...] = (
    Warehouse("MY8801", 26, "马来西亚仓", ("马来西亚仓", "马来西亚", "马来仓", "马来", "MY")),
    Warehouse("PH8805", 46, "菲律宾仓", ("菲律宾仓", "菲律宾", "菲仓", "PH")),
    Warehouse("TH8802", 47, "泰国仓", ("泰国仓", "泰国", "泰仓", "TH")),
    Warehouse("VN8806", 80, "越南仓", ("越南仓", "越南", "越仓", "VN")),
)
WAREHOUSE_IDS = {warehouse.code: warehouse.warehouse_id for warehouse in WAREHOUSES}
WAREHOUSE_ALIAS_TO_CODE = {
    key: warehouse.code
    for warehouse in WAREHOUSES
    for alias in (*warehouse.aliases, warehouse.code)
    for key in (
        (alias.upper(), alias.lower())
        if alias.isascii()
        else (alias,)
    )
}


def normalize_warehouse_alias(value: str) -> str:
    """Normalize a supported warehouse alias to its canonical code."""

    text = value.strip()
    key = text.upper() if text.isascii() else text
    return WAREHOUSE_ALIAS_TO_CODE.get(key, key)


def match_warehouse_aliases(text: str) -> tuple[str, ...]:
    """Return canonical codes for warehouse aliases mentioned in user text."""

    return tuple(
        warehouse.code
        for warehouse in WAREHOUSES
        if any(_alias_in_text(text, alias) for alias in warehouse.aliases)
    )


def _alias_in_text(text: str, alias: str) -> bool:
    if alias.isascii() and alias.isalnum():
        return re.search(
            rf"(?<![A-Z0-9]){re.escape(alias)}(?![A-Z0-9])",
            text,
            re.IGNORECASE,
        ) is not None
    return alias in text


def warehouse_display_name(code: str) -> str:
    """Return the user-facing name for one canonical warehouse code."""

    return select_warehouses(code)[0].display_name


def select_warehouses(value: Any = None) -> tuple[Warehouse, ...]:
    if value is None or value == "":
        return WAREHOUSES
    raw_values: Iterable[Any]
    if isinstance(value, str):
        raw_values = (value,)
    elif isinstance(value, (list, tuple, set, frozenset)):
        raw_values = value
    else:
        raise ValueError("warehouses 必须是仓库代码或仓库代码列表")
    requested = [str(item).strip().upper() for item in raw_values]
    if not requested:
        return WAREHOUSES
    unknown = sorted(set(requested).difference(WAREHOUSE_IDS))
    if unknown:
        raise ValueError(
            "warehouse 必须是以下仓库之一: "
            + ", ".join(WAREHOUSE_IDS)
            + "；收到 "
            + ", ".join(unknown)
        )
    requested_set = set(requested)
    return tuple(warehouse for warehouse in WAREHOUSES if warehouse.code in requested_set)


__all__ = [
    "WAREHOUSES",
    "WAREHOUSE_IDS",
    "WAREHOUSE_ALIAS_TO_CODE",
    "Warehouse",
    "match_warehouse_aliases",
    "normalize_warehouse_alias",
    "select_warehouses",
    "warehouse_display_name",
]
