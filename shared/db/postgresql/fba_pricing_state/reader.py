from __future__ import annotations

from typing import Any

from sqlalchemy import bindparam, text

from shared.logging import logger

from .engine import session_scope


def load_candidates(transport_mode: str) -> list[dict[str, Any]]:
    sql = text(
        """
        SELECT
          c.id,
          c.channel_code,
          c.channel_name,
          c.transport_mode,
          c.cargo_natures,
          c.destination_country,
          c.destination_scope,
          c.tax_included,
          c.destination_keyword,
          c.source_workbook,
          c.source_company,
          c.transit_days_min,
          c.transit_days_max,
          c.note,
          t.id AS tier_id,
          t.min_weight,
          t.max_weight,
          t.unit_price,
          t.currency,
          t.volumetric_divisor,
          t.min_charge,
          co.max_gross_weight,
          co.max_length,
          co.max_width,
          co.max_height,
          co.max_l_plus_w_plus_h,
          co.note AS constraint_note
        FROM pricing_channels c
        JOIN pricing_rate_tiers t ON t.channel_id = c.id AND t.active = TRUE
        LEFT JOIN pricing_constraints co ON co.channel_id = c.id
        WHERE c.active = TRUE AND c.transport_mode = :transport_mode
        ORDER BY c.id, t.min_weight ASC
        """
    )

    with session_scope() as session:
        try:
            rows = session.execute(sql, {"transport_mode": transport_mode}).mappings().all()
            return [dict(row) for row in rows]
        except Exception as error:
            logger.error(f"❌ [FBA Logistics] 查询候选渠道失败: {error}")
            return []


def load_surcharge_rules(channel_ids: list[int] | tuple[int, ...] | set[int]) -> dict[int, list[dict[str, Any]]]:
    normalized_ids = sorted({int(value) for value in channel_ids if value is not None})
    if not normalized_ids:
        return {}

    sql = text(
        """
        SELECT
          id,
          channel_id,
          rule_name,
          trigger_type,
          trigger_value,
          calc_method,
          amount,
          currency,
          weight_basis,
          min_charge,
          max_charge,
          stack_mode,
          priority,
          active,
          note,
          source_excerpt
        FROM pricing_surcharge_rules
        WHERE channel_id IN :channel_ids
          AND active = TRUE
        ORDER BY channel_id ASC, priority ASC, id ASC
        """
    ).bindparams(bindparam("channel_ids", expanding=True))

    with session_scope() as session:
        try:
            rows = session.execute(sql, {"channel_ids": normalized_ids}).mappings().all()
            grouped: dict[int, list[dict[str, Any]]] = {}
            for row in rows:
                item = dict(row)
                channel_id = int(item["channel_id"])
                grouped.setdefault(channel_id, []).append(item)
            return grouped
        except Exception as error:
            logger.warning(f"⚠️ [FBA Logistics] 查询附加费规则失败，按无附加费处理: {error}")
            return {}
