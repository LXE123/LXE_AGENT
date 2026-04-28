from __future__ import annotations

from typing import Any


def _channel_line(item: dict[str, Any]) -> str:
    channel_name = str(item.get("channel_name") or item.get("channel_code") or "-").strip()
    status = str(item.get("status") or "").strip().lower()
    if status != "priced":
        reason = str(item.get("reason") or "rejected").strip()
        return f"- {channel_name}: rejected ({reason})"
    total_price = str(item.get("total_price") or "").strip() or "-"
    currency = str(item.get("currency") or "CNY").strip()
    calc_note = str(item.get("calc_note") or "").strip()
    tail = f" | {calc_note}" if calc_note else ""
    return f"- {channel_name}: {total_price} {currency}{tail}"


def _channel_lines(
    pricing_snapshots: list[dict[str, Any]] | None,
    *,
    limit: int,
) -> list[str]:
    return [
        _channel_line(dict(item or {}))
        for item in list(pricing_snapshots or [])[: max(1, int(limit or 0))]
    ]


def build_single_channel_pricing_markdown(
    pricing_snapshots: list[dict[str, Any]] | None,
    *,
    shipment_no: str,
    consignment_no: str,
    destination_address: str,
    limit: int = 50,
) -> str:
    lines = [
        "# 物流优选结果",
        "",
        f"- 货件编号: {str(shipment_no or '').strip() or '-'}",
        f"- 装箱数据单号: {str(consignment_no or '').strip() or '-'}",
        f"- 收货地址: {str(destination_address or '').strip() or '-'}",
        f"- 渠道快照数量: {len(list(pricing_snapshots or []))}",
        "",
        "## 渠道报价",
    ]
    lines.extend(_channel_lines(pricing_snapshots, limit=limit))
    return "\n".join(lines).strip() + "\n"


def build_multi_channel_pricing_markdown(
    shipment_results: list[dict[str, Any]],
    *,
    consignment_no: str,
    limit: int = 50,
) -> str:
    lines = [
        "# 物流优选结果",
        "",
        f"- 装箱数据单号: {str(consignment_no or '').strip() or '-'}",
        f"- 货件数量: {len(list(shipment_results or []))}",
        "",
        "## 货件列表",
    ]
    for index, result in enumerate(list(shipment_results or []), start=1):
        shipment_no = str(dict(result or {}).get("shipment_no") or "").strip() or "-"
        destination_address = str(dict(result or {}).get("destination_address") or "").strip() or "-"
        pricing_snapshots = list(dict(result or {}).get("pricing_snapshots") or [])
        lines.extend(
            [
                "",
                f"### {index}. {shipment_no}",
                f"- 收货地址: {destination_address}",
                f"- 渠道快照数量: {len(pricing_snapshots)}",
                "",
                "#### 渠道报价",
            ]
        )
        lines.extend(_channel_lines(pricing_snapshots, limit=limit))
    return "\n".join(lines).strip() + "\n"


__all__ = [
    "build_multi_channel_pricing_markdown",
    "build_single_channel_pricing_markdown",
]
