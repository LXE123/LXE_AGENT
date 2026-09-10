"""Identify local SKUs using product catalogs, without reading store Listings."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from services.mabang.official_api import invalid, post_json
from .combo_sku import (
    COMBO_WORKERS, ComboComponent, ComboSku, _fetch_combo, _parse_combo, _progress,
    clean_text, normalize_sku_key, resolve_official_shop,
)

STOCK_BATCH_SIZE = 50
STOCK_PAGE_SIZE = 1000
VERIFICATION_METHOD = "stock_then_combo"
NOT_FOUND_REASON = "本地 SKU 未在库存或组合接口中查到，SKU 类型未核验，本轮不计算备货"


@dataclass(frozen=True)
class LocalSkuDefinition:
    local_sku: str
    stock_type: int | None
    components: tuple[ComboComponent, ...] = ()

    def to_record(self) -> dict[str, Any]:
        return {
            "local_sku": self.local_sku, "stock_type": self.stock_type,
            "components": [{"stockSku": c.stock_sku, "quantity": str(c.quantity)} for c in self.components],
        }

    @classmethod
    def from_record(cls, row: dict[str, Any]) -> LocalSkuDefinition:
        context = "本地 SKU 类型快照"
        if not isinstance(row, dict) or set(row) != {"local_sku", "stock_type", "components"}:
            invalid(context, "类型记录结构无效", row)
        sku, kind, components = row["local_sku"], row["stock_type"], row["components"]
        if not isinstance(sku, str) or not normalize_sku_key(sku) or not (
            kind is None or type(kind) is int and kind in (1, 2)
        ) or not isinstance(components, list):
            invalid(context, "SKU/类型/组件结构无效", row)
        if kind == 2:
            combo = _parse_combo({"comboSku": sku, "comboProductDetail": components}, context)
            return cls(sku, kind, combo.components)
        if components:
            invalid(context, "非组合 SKU 不应包含组件", row)
        return cls(sku, kind)


@dataclass(frozen=True)
class SkuCatalogSnapshot:
    store_name: str
    shop_id: str
    site: str
    skus: tuple[LocalSkuDefinition, ...]


def definition_map(skus: tuple[LocalSkuDefinition, ...]) -> dict[str, LocalSkuDefinition]:
    result = {}
    for item in skus:
        LocalSkuDefinition.from_record(item.to_record())
        key = normalize_sku_key(item.local_sku)
        if key in result:
            invalid("本地 SKU 类型快照", "重复的本地 SKU", item.to_record())
        result[key] = item
    return result


def combo_map(skus: tuple[LocalSkuDefinition, ...]) -> dict[str, ComboSku]:
    return {key: ComboSku(item.local_sku, item.components)
            for key, item in definition_map(skus).items() if item.stock_type == 2}


async def _stock_batch(skus: list[str]) -> set[str]:
    expected = {normalize_sku_key(sku) for sku in skus}
    found: set[str] = set()
    cursors: set[str] = set()
    body: dict[str, Any] = {"stockSkuList": ",".join(skus), "maxRows": STOCK_PAGE_SIZE, "way": 2}
    page = 1
    while True:
        context = f"库存SKU批量={skus!r} page={page}"
        payload = await post_json("stock-skus/search", body, context=context)
        data = payload.get("data")
        if not isinstance(data, dict) or "data" not in data or not isinstance(data.get("nextCursor"), str):
            invalid(context, "缺少 data.data 或 nextCursor 结构异常", payload)
        records, cursor = data["data"], data["nextCursor"]
        # Verified live: no matches and the final empty cursor page use null, not [].
        if records is None and cursor == "":
            records = []
        if not isinstance(records, list) or len(records) > STOCK_PAGE_SIZE:
            invalid(context, "库存 SKU 结果结构或分页数量异常", payload)
        for row in records:
            if not isinstance(row, dict) or not isinstance(row.get("stockSku"), str):
                invalid(context, "库存 SKU 记录缺少 stockSku", row)
            key = normalize_sku_key(row["stockSku"])
            if not key or key not in expected or key in found:
                invalid(context, "库存 SKU 结果超出请求范围或重复", row)
            found.add(key)
        if cursor == "":
            return found
        if not records or not cursor.strip() or cursor in cursors:
            invalid(context, "空分页或重复游标", payload)
        cursors.add(cursor)
        body["cursor"] = cursor
        page += 1


async def fetch_local_sku_definitions(local_skus: list[str]) -> tuple[LocalSkuDefinition, ...]:
    unique = {normalize_sku_key(sku): clean_text(sku) for sku in local_skus if normalize_sku_key(sku)}
    if not unique:
        return ()
    if any("," in sku for sku in unique.values()):
        invalid("本地 SKU 类型核验", "本地 SKU 含逗号，无法安全使用批量查询", list(unique.values()))
    found: set[str] = set()
    values = list(unique.values())
    for offset in range(0, len(values), STOCK_BATCH_SIZE):
        found.update(await _stock_batch(values[offset:offset + STOCK_BATCH_SIZE]))
        _progress(f"库存 SKU 类型核验 {min(offset + STOCK_BATCH_SIZE, len(values))}/{len(values)}，命中={len(found)}")
    results = {key: LocalSkuDefinition(unique[key], 1) for key in found}
    missing = iter((key, sku) for key, sku in unique.items() if key not in found)

    async def worker() -> None:
        for key, sku in missing:
            combo = await _fetch_combo(sku, allow_missing=True)
            results[key] = LocalSkuDefinition(sku, None) if combo is None else LocalSkuDefinition(sku, 2, combo.components)
            _progress(f"商品类型核验 {len(results)}/{len(unique)}")

    tasks = [asyncio.create_task(worker()) for _ in range(min(COMBO_WORKERS, len(unique) - len(found)))]
    try:
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    ordered = tuple(results[key] for key in unique)
    definition_map(ordered)
    _progress(f"商品类型核验完成: 普通={len(found)}，组合={sum(s.stock_type == 2 for s in ordered)}，未命中={sum(s.stock_type is None for s in ordered)}")
    return ordered


async def fetch_sku_catalog_snapshot(store_name: str, local_skus: list[str]) -> SkuCatalogSnapshot:
    name, shop_id, site = await resolve_official_shop(store_name)
    return SkuCatalogSnapshot(name, shop_id, site, await fetch_local_sku_definitions(local_skus))
