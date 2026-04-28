"""FBA 物流应用层公共辅助函数。"""

from __future__ import annotations

import json
from typing import Any

from shared.config import config
from shared.db.fba_pricing_state_client import ensure_schema, load_candidates, load_surcharge_rules
from shared.logging import logger

from ..models import PricingRequest
from ..pricing_engine import infer_target_country, parse_boxes_json
from ..transport.selector import TransportSelection, filter_candidates_for_requested_transport_mode

HARDCODED_TEST_CASES: dict[str, dict[str, Any]] = {
    "DE_WRO5": {
        "name": "DE WRO5 默认参数",
        "transport_mode": "air",
        "cargo_nature": "battery",
        "tax_included": "any",
        "top_n": 3,
        "allow_any_destination": True,
        "verbose_rejected": False,
        "max_rejected_details": 3,
    },
    "US_BNA6": {
        "name": "US BNA6 默认参数",
        "transport_mode": "air",
        "cargo_nature": "general",
        "tax_included": "any",
        "top_n": 3,
        "allow_any_destination": True,
        "verbose_rejected": False,
        "max_rejected_details": 3,
    },
}


def parse_bool(value: Any, default: bool = False) -> bool:
    """解析宽松布尔值。"""
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "y", "on", "开", "开启"}:
        return True
    if text in {"0", "false", "no", "n", "off", "关", "关闭"}:
        return False
    return default


def parse_int(value: Any, default: int) -> int:
    """解析整数值。"""
    try:
        return int(value)
    except Exception:
        return int(default)


def normalize_case_key(value: str | None) -> str:
    """标准化测试用例键。"""
    return str(value or "").strip().upper()


def resolve_fixed_cargo_nature(default_payload: dict[str, Any] | None = None) -> str:
    """解析固定货物属性配置。"""
    explicit = str(getattr(config, "FBA_LOGISTICS_FIXED_CARGO_NATURE", "") or "").strip().lower()
    if explicit:
        return explicit
    if default_payload:
        fallback_from_case = str(default_payload.get("cargo_nature") or "").strip().lower()
        if fallback_from_case:
            return fallback_from_case
    defaults = getattr(config, "FBA_LOGISTICS_DEFAULTS", {}) or {}
    return str(defaults.get("cargo_nature") or "general").strip().lower() or "general"


def list_hardcoded_test_cases() -> list[str]:
    """列出可用测试用例。"""
    return sorted(HARDCODED_TEST_CASES.keys())


def resolve_test_case(requested_case_key: str | None = None) -> tuple[str, dict[str, Any]]:
    """解析当前生效的默认参数集。"""
    default_key = normalize_case_key(getattr(config, "FBA_LOGISTICS_ACTIVE_TEST_CASE", "DE_WRO5"))
    selected = normalize_case_key(requested_case_key) or default_key
    if selected not in HARDCODED_TEST_CASES:
        raise ValueError(f"未知测试用例: {selected}. 可用用例: {', '.join(list_hardcoded_test_cases())}")
    return selected, dict(HARDCODED_TEST_CASES[selected])


def build_request_from_runtime_inputs(
    *,
    default_payload: dict[str, Any],
    destination_address: str,
    boxes_payload: list[dict[str, str]],
    transport_mode: str,
) -> PricingRequest:
    """根据业务输入构造单票计价请求。"""
    address = str(destination_address or "").strip()
    if not address:
        raise ValueError("destination_address 参数不能为空")

    target_country = infer_target_country(address)
    if not target_country:
        raise ValueError("无法从收货地址识别目标国家，请提供包含国家或站点信息的完整收货地址")

    normalized_transport_mode = str(transport_mode or default_payload.get("transport_mode") or "air").strip().lower()
    tax_included = str(default_payload.get("tax_included") or "any").strip().lower()
    if normalized_transport_mode not in {"air", "sea"}:
        raise ValueError("transport_mode 必须为 air 或 sea")
    if tax_included not in {"any", "required", "not_required"}:
        raise ValueError("tax_included 必须为 any / required / not_required")
    if not boxes_payload:
        raise ValueError("boxes_payload 不能为空")

    boxes = parse_boxes_json(json.dumps(boxes_payload, ensure_ascii=False))
    top_n = max(1, parse_int(default_payload.get("top_n", 3), 3))
    allow_any_destination = parse_bool(default_payload.get("allow_any_destination"), False)
    verbose_rejected = parse_bool(default_payload.get("verbose_rejected"), False)
    max_rejected_details = max(0, parse_int(default_payload.get("max_rejected_details", 3), 3))

    return PricingRequest(
        warehouse="",
        address=address,
        transport_mode=normalized_transport_mode,
        cargo_nature=resolve_fixed_cargo_nature(default_payload),
        boxes=boxes,
        tax_included=tax_included,
        target_country=target_country,
        top_n=top_n,
        allow_any_destination=allow_any_destination,
        verbose_rejected=verbose_rejected,
        max_rejected_details=max_rejected_details,
        has_textile=False,
    )


async def load_candidate_rows_for_transport_selection(selection: TransportSelection) -> tuple[list[dict[str, Any]], TransportSelection]:
    """按运输方式加载渠道并应用子模式筛选。"""
    base_rows = await load_candidates(selection.base_transport_mode)
    return filter_candidates_for_requested_transport_mode(base_rows, selection)


async def load_surcharge_rules_for_rows(rows: list[dict[str, Any]], *, enabled: bool = True) -> dict[int, list[dict[str, Any]]]:
    """按渠道集合批量加载附加费规则。"""
    if not enabled:
        return {}
    channel_ids = [int(row["id"]) for row in rows if row.get("id") is not None]
    if not channel_ids:
        return {}
    return await load_surcharge_rules(channel_ids)


async def ensure_schema_if_needed(force: bool = False) -> bool:
    """按配置决定是否初始化 pricing schema。"""
    auto_flag = parse_bool(getattr(config, "FBA_LOGISTICS_AUTO_ENSURE_SCHEMA", False), False)
    if not force and not auto_flag:
        return False
    await ensure_schema(include_indexes=True)
    logger.info("✅ [FBA Logistics] pricing schema 已初始化")
    return True
