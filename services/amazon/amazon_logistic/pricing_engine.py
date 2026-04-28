from __future__ import annotations

import json
import re
from collections import Counter
from decimal import Decimal, InvalidOperation, ROUND_CEILING
from typing import Any

from .models import BoxInput, PricingRequest

DEFAULT_VOLUMETRIC_DIVISOR = Decimal("6000")
BATTERY_GENERAL_SURCHARGE_RULES_CNY: tuple[tuple[str, tuple[str, ...] | None, Decimal], ...] = (
    ("九方通逊", None, Decimal("350")),
    ("云驼", None, Decimal("500")),
    ("威飒", None, Decimal("200")),
    ("天美通", ("US",), Decimal("480")),
    ("天美通", ("DE",), Decimal("200")),
)
EU_COUNTRY_CODES = {
    "AT",
    "BE",
    "BG",
    "HR",
    "CY",
    "CZ",
    "DK",
    "EE",
    "FI",
    "FR",
    "DE",
    "GR",
    "HU",
    "IE",
    "IT",
    "LV",
    "LT",
    "LU",
    "MT",
    "NL",
    "PL",
    "PT",
    "RO",
    "SK",
    "SI",
    "ES",
    "SE",
}


def infer_target_country(address_text: str) -> str | None:
    s = (address_text or "").upper()
    tokens = {token for token in re.split(r"[^A-Z]+", s) if token}
    if any(x in s for x in ("UNITED STATES", "USA", "U.S.", "AMERICA")) or "US" in tokens:
        return "US"
    if any(x in s for x in ("CANADA", "加拿大")):
        return "CA"
    if any(x in s for x in ("UNITED KINGDOM", "英国", "ENGLAND")) or "UK" in tokens or "GB" in tokens:
        return "UK"
    if any(x in s for x in ("AUSTRALIA", "澳大利亚", "澳洲")):
        return "AU"
    if any(x in s for x in ("GERMANY", "德国")) or "DE" in tokens:
        return "DE"
    if any(x in s for x in ("FRANCE", "法国")) or "FR" in tokens:
        return "FR"
    if any(x in s for x in ("ITALY", "意大利")) or "IT" in tokens:
        return "IT"
    if any(x in s for x in ("SPAIN", "西班牙")) or "ES" in tokens:
        return "ES"
    if any(x in s for x in ("NETHERLANDS", "荷兰")) or "NL" in tokens:
        return "NL"
    if any(x in s for x in ("POLAND", "波兰")) or "PL" in tokens:
        return "PL"
    if any(x in s for x in ("欧盟", "欧洲")):
        return "EU"

    # Common US city/state format like "San Bernardino, CA".
    if "," in s:
        tail = s.rsplit(",", 1)[-1].strip()
        if len(tail) == 2 and tail.isalpha():
            return "US"
    return None


def parse_decimal(value: Any, field_name: str) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError) as exc:
        raise ValueError(f"Invalid decimal for {field_name}: {value}") from exc


def parse_boxes_json(boxes_json: str) -> list[BoxInput]:
    payload = json.loads(boxes_json)
    if not isinstance(payload, list) or not payload:
        raise ValueError("boxes-json must be a non-empty JSON array")

    boxes: list[BoxInput] = []
    for idx, item in enumerate(payload, start=1):
        if not isinstance(item, dict):
            raise ValueError(f"Box {idx} must be an object")
        box = BoxInput(
            gross_weight=parse_decimal(item.get("gross_weight"), f"boxes[{idx}].gross_weight"),
            length=parse_decimal(item.get("length"), f"boxes[{idx}].length"),
            width=parse_decimal(item.get("width"), f"boxes[{idx}].width"),
            height=parse_decimal(item.get("height"), f"boxes[{idx}].height"),
        )
        boxes.append(box)
    return boxes


def matches_destination(destination: str, keyword: str | None) -> bool:
    if not keyword:
        return True
    return keyword.lower() in destination.lower()


def _normalize_country_code(value: Any) -> str:
    if value is None:
        return ""
    code = str(value).strip().upper()
    aliases = {
        "UNITED STATES": "US",
        "U.S.": "US",
        "AMERICA": "US",
        "UNITED KINGDOM": "UK",
    }
    return aliases.get(code, code)


def _country_compatible(row_country: str, target_country: str) -> bool:
    if not row_country or not target_country:
        return True
    if row_country == target_country:
        return True
    if row_country == "EU" and target_country in EU_COUNTRY_CODES:
        return True
    return False


def _should_prioritize_tax_declared_channel(target_country: str | None, tax_requirement: str) -> bool:
    """
    默认规则：
    - 当 tax_requirement=any 且目标国家不是 DE/UK 时，优先包税渠道（按有效包税语义判断）。
    - 显式 required/not_required 仍由筛选逻辑决定，不使用该默认优先级。
    """

    if str(tax_requirement or "").strip().lower() != "any":
        return False

    country = _normalize_country_code(target_country)
    if not country:
        return False

    return country not in {"DE", "UK", "GB"}


def _effective_tax_included_value(raw_tax: Any) -> bool:
    """
    业务语义：
    - true  -> 包税
    - false -> 不包税
    - null/未声明 -> 默认按包税处理
    """

    if isinstance(raw_tax, bool):
        return raw_tax
    if raw_tax is None:
        return True

    text = str(raw_tax).strip().lower()
    if text in {"false", "0", "no", "n"}:
        return False
    if text in {"true", "1", "yes", "y"}:
        return True
    return True


def _tax_included_resolution(raw_tax: Any) -> str:
    if isinstance(raw_tax, bool):
        return "explicit_true" if raw_tax else "explicit_false"
    if raw_tax is None:
        return "default_true_from_null"

    text = str(raw_tax).strip().lower()
    if text in {"false", "0", "no", "n"}:
        return "explicit_false"
    if text in {"true", "1", "yes", "y"}:
        return "explicit_true"
    return "default_true_from_unspecified"


def _parse_scope_tokens(keyword: str | None) -> list[str]:
    if not keyword:
        return []
    text = str(keyword).upper()
    for sep in ["，", ";", "；", "/", "|", "\n", "\r", "\t", " "]:
        text = text.replace(sep, ",")
    tokens: list[str] = []
    for part in text.split(","):
        token = part.strip().strip(".")
        if token and token not in tokens:
            tokens.append(token)
    return tokens


def _extract_warehouse_code(warehouse: str | None, destination: str) -> str | None:
    first = str(warehouse or "").strip().upper()
    if first:
        return first

    text = str(destination or "").upper()
    for match in re.finditer(r"\b[A-Z]{2,}[A-Z0-9]*\d[A-Z0-9]*\b", text):
        token = match.group(0).strip()
        if token:
            return token
    return None


def _extract_postal_prefix(address: str | None, destination: str) -> str | None:
    """
    提取邮编首位（用于 zip_prefix 规则）。

    关键策略：
    - 优先匹配 `州 + ZIP`（如 `CA 92337-7441`），并取最后一个；
    - 其次匹配所有 ZIP(5位/ZIP+4)，并取最后一个（避免误取街道门牌号）；
    - 最后兜底匹配 4-6 位纯数字，仍取最后一个。
    """

    text = re.sub(r"\s+", " ", f"{address or ''} {destination or ''}").strip()
    if not text:
        return None

    upper = text.upper()
    state_zip_matches = re.findall(r"\b[A-Z]{2}\s+(\d{5})(?:-\d{4})?\b", upper)
    if state_zip_matches:
        return str(state_zip_matches[-1])[0]

    zip_matches = re.findall(r"\b(\d{5})(?:-\d{4})?\b", upper)
    if zip_matches:
        return str(zip_matches[-1])[0]

    fallback_matches = re.findall(r"\b(\d{4,6})\b", upper)
    if fallback_matches:
        return str(fallback_matches[-1])[0]
    return None


def check_constraints(box: BoxInput, row: dict[str, Any]) -> list[str]:
    reasons: list[str] = []

    max_gw = row.get("max_gross_weight")
    if max_gw is not None and box.gross_weight > Decimal(str(max_gw)):
        reasons.append(f"gross_weight>{max_gw}")

    max_length = row.get("max_length")
    if max_length is not None and box.length > Decimal(str(max_length)):
        reasons.append(f"length>{max_length}")

    max_width = row.get("max_width")
    if max_width is not None and box.width > Decimal(str(max_width)):
        reasons.append(f"width>{max_width}")

    max_height = row.get("max_height")
    if max_height is not None and box.height > Decimal(str(max_height)):
        reasons.append(f"height>{max_height}")

    max_lwh = row.get("max_l_plus_w_plus_h")
    if max_lwh is not None and (box.length + box.width + box.height) > Decimal(str(max_lwh)):
        reasons.append(f"l+w+h>{max_lwh}")

    return reasons


def _ceil_to_kg(value: Decimal) -> Decimal:
    """
    向上取整到 1kg。
    """

    return value.to_integral_value(rounding=ROUND_CEILING)


def chargeable_weight(box: BoxInput, divisor: Any) -> tuple[Decimal, Decimal, Decimal, bool]:
    divisor_defaulted = False
    try:
        divisor_dec = Decimal(str(divisor)) if divisor is not None else DEFAULT_VOLUMETRIC_DIVISOR
        if divisor_dec <= 0:
            divisor_dec = DEFAULT_VOLUMETRIC_DIVISOR
            divisor_defaulted = True
    except (InvalidOperation, TypeError, ValueError):
        divisor_dec = DEFAULT_VOLUMETRIC_DIVISOR
        divisor_defaulted = True

    if divisor is None:
        divisor_defaulted = True

    vol = (box.length * box.width * box.height) / divisor_dec
    charge = box.gross_weight if box.gross_weight >= vol else vol
    return charge, vol, divisor_dec, divisor_defaulted


def evaluate_tier_for_boxes(
    boxes: list[BoxInput],
    row: dict[str, Any],
    channel_min_weight: Decimal | None = None,
) -> tuple[bool, Decimal, list[str], list[dict[str, str]], bool, dict[str, str]]:
    min_w = Decimal(str(row["min_weight"]))
    max_w = Decimal(str(row["max_weight"])) if row.get("max_weight") is not None else None
    unit_price = Decimal(str(row["unit_price"]))
    min_charge = Decimal(str(row["min_charge"]))

    reasons: list[str] = []
    box_details: list[dict[str, str]] = []
    tier_used_default_divisor = False
    total_gross_weight = Decimal("0")
    total_volumetric_weight = Decimal("0")

    for idx, box in enumerate(boxes, start=1):
        failed = check_constraints(box, row)
        if failed:
            reasons.append(f"box#{idx}:" + ",".join(failed))
            continue

        charge_w, vol_w, divisor_used, divisor_defaulted = chargeable_weight(box, row.get("volumetric_divisor"))
        if divisor_defaulted:
            tier_used_default_divisor = True
        total_gross_weight += box.gross_weight
        total_volumetric_weight += vol_w
        box_details.append(
            {
                "box": str(idx),
                "gross_weight": str(box.gross_weight),
                "volumetric_weight": str(vol_w.quantize(Decimal("0.001"))),
                "box_chargeable_weight": str(charge_w.quantize(Decimal("0.001"))),
                "volumetric_divisor_used": str(divisor_used.quantize(Decimal("0.001"))),
                "volumetric_divisor_defaulted": str(divisor_defaulted).lower(),
            }
        )

    if reasons:
        return False, Decimal("0"), reasons, [], tier_used_default_divisor, {}

    rounded_total_gross = _ceil_to_kg(total_gross_weight)
    rounded_total_volumetric = _ceil_to_kg(total_volumetric_weight)
    total_chargeable_weight = (
        rounded_total_gross if rounded_total_gross >= rounded_total_volumetric else rounded_total_volumetric
    )

    billing_weight = total_chargeable_weight
    min_weight_floor_applied = False

    if total_chargeable_weight < min_w:
        if channel_min_weight is not None and min_w == channel_min_weight:
            billing_weight = min_w
            min_weight_floor_applied = True
        else:
            reasons.append(f"total_chargeable<{min_w}")
    if max_w is not None and billing_weight > max_w:
        reasons.append(f"billing_weight>{max_w}")
    if reasons:
        return False, Decimal("0"), reasons, [], tier_used_default_divisor, {}

    total_price = billing_weight * unit_price
    if total_price < min_charge:
        total_price = min_charge

    calc_context = {
        "total_gross_weight": str(total_gross_weight.quantize(Decimal("0.001"))),
        "total_volumetric_weight": str(total_volumetric_weight.quantize(Decimal("0.001"))),
        "rounded_total_gross_weight": str(rounded_total_gross.quantize(Decimal("0.001"))),
        "rounded_total_volumetric_weight": str(rounded_total_volumetric.quantize(Decimal("0.001"))),
        "chargeable_weight": str(total_chargeable_weight.quantize(Decimal("0.001"))),
        "billing_weight": str(billing_weight.quantize(Decimal("0.001"))),
        "tier_min_weight": str(min_w.quantize(Decimal("0.001"))),
        "min_weight_floor_applied": str(min_weight_floor_applied).lower(),
    }

    return True, total_price.quantize(Decimal("0.01")), [], box_details, tier_used_default_divisor, calc_context


def build_rejected_channel(
    channel_row: dict[str, Any],
    reason: str,
    details: list[str] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "channel_id": channel_row["id"],
        "channel_code": channel_row["channel_code"],
        "channel_name": channel_row["channel_name"],
        "source_company": channel_row.get("source_company"),
        "reason": reason,
    }
    if details is not None:
        payload["details"] = details
    return payload


def _normalize_cargo_natures(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return [str(item).strip().lower() for item in value if str(item).strip()]
    if isinstance(value, str):
        return [part.strip().lower() for part in value.split(",") if part.strip()]
    return [str(value).strip().lower()]


def _normalize_company_text(value: Any) -> str:
    text = str(value or "").strip().upper()
    return re.sub(r"\s+", "", text)


def _lookup_battery_general_surcharge(
    source_company: Any,
    target_country: Any,
) -> tuple[Decimal | None, str | None]:
    company_text = _normalize_company_text(source_company)
    if not company_text:
        return None, None

    target_country_norm = _normalize_country_code(target_country)
    generic_match: tuple[Decimal, str] | None = None

    for company_keyword, countries, surcharge in BATTERY_GENERAL_SURCHARGE_RULES_CNY:
        if _normalize_company_text(company_keyword) in company_text:
            if countries is None:
                if generic_match is None:
                    generic_match = (surcharge, company_keyword)
                continue

            normalized_countries = {_normalize_country_code(country) for country in countries}
            if target_country_norm and target_country_norm in normalized_countries:
                return surcharge, f"{company_keyword}/{target_country_norm}"

    if generic_match is not None:
        return generic_match
    return None, None


def _should_use_jiufang_us_air_highest_tier_rate(
    channel_row: dict[str, Any],
    target_country: str | None,
) -> bool:
    if _normalize_country_code(target_country) != "US":
        return False
    if str(channel_row.get("transport_mode") or "").strip().lower() != "air":
        return False
    return _normalize_company_text("九方通逊") in _normalize_company_text(channel_row.get("source_company"))


def _tier_rank_key(row: dict[str, Any]) -> tuple[Decimal, Decimal, int]:
    min_weight = Decimal(str(row.get("min_weight") or "0"))
    max_weight_raw = row.get("max_weight")
    max_weight = Decimal(str(max_weight_raw)) if max_weight_raw is not None else Decimal("999999999")
    tier_id = int(row.get("tier_id") or row.get("id") or 0)
    return min_weight, max_weight, tier_id


def _select_highest_tier_row(channel_rows: list[dict[str, Any]]) -> dict[str, Any]:
    return max(channel_rows, key=_tier_rank_key)


def _resolve_candidate_base_pricing(
    channel_rows: list[dict[str, Any]],
    channel_row: dict[str, Any],
    matched_row: dict[str, Any],
    matched_base_total: Decimal,
    calc_context: dict[str, Any],
    target_country: str | None,
) -> dict[str, Any]:
    original_base_total = matched_base_total.quantize(Decimal("0.01"))
    billing_weight = Decimal(str((calc_context or {}).get("billing_weight") or "0"))

    payload = {
        "base_total_price": original_base_total,
        "original_base_total_price": original_base_total,
        "rate_row": matched_row,
        "pricing_policy": "standard",
        "discount_applied": False,
    }

    if not _should_use_jiufang_us_air_highest_tier_rate(channel_row, target_country):
        return payload

    highest_tier_row = _select_highest_tier_row(channel_rows)
    highest_unit_price = Decimal(str(highest_tier_row.get("unit_price") or "0"))
    min_charge = Decimal(str(matched_row.get("min_charge") or "0"))
    discounted_base_total = billing_weight * highest_unit_price
    if discounted_base_total < min_charge:
        discounted_base_total = min_charge
    discounted_base_total = discounted_base_total.quantize(Decimal("0.01"))

    payload.update(
        {
            "base_total_price": discounted_base_total,
            "rate_row": highest_tier_row,
            "pricing_policy": "jiufang_us_air_highest_tier_unit_price",
            "discount_applied": discounted_base_total < original_base_total,
        }
    )
    return payload


def _resolve_cargo_pricing_rule(
    channel_row: dict[str, Any],
    cargo_nature: str,
    target_country: str | None,
) -> tuple[bool, str, Decimal, str, str | None]:
    requested_nature = str(cargo_nature or "general").strip().lower() or "general"
    cargo_natures = _normalize_cargo_natures(channel_row.get("cargo_natures"))

    if requested_nature in cargo_natures:
        return True, requested_nature, Decimal("0"), "native", None

    # 电池货在普货渠道走“普货 + 磁检费”兜底逻辑（按公司固定加价）。
    if requested_nature == "battery" and "general" in cargo_natures:
        surcharge, matched_company = _lookup_battery_general_surcharge(
            channel_row.get("source_company"),
            target_country,
        )
        if surcharge is None:
            source_company = str(channel_row.get("source_company") or "UNKNOWN")
            target_country_text = _normalize_country_code(target_country) or "UNKNOWN"
            return (
                False,
                requested_nature,
                Decimal("0"),
                "unsupported",
                f"battery_general_surcharge_missing:{source_company}:{target_country_text}",
            )
        return (
            True,
            "general",
            surcharge.quantize(Decimal("0.01")),
            f"battery_via_general_plus_magnetic_fee:{matched_company}",
            None,
        )

    return False, requested_nature, Decimal("0"), "unsupported", f"cargo_nature_not_allowed:{requested_nature}"


def _resolve_textile_surcharge(
    channel_rules: list[dict[str, Any]] | None,
    calc_context: dict[str, Any],
    has_textile: bool,
) -> tuple[Decimal, str, str | None]:
    if not has_textile or not channel_rules:
        return Decimal("0.00"), "", None

    try:
        chargeable_weight = Decimal(str((calc_context or {}).get("chargeable_weight") or "0"))
    except Exception:
        chargeable_weight = Decimal("0")
    if chargeable_weight <= 0:
        return Decimal("0.00"), "", None

    matched: list[tuple[Decimal, str, str]] = []
    for rule in channel_rules:
        trigger_type = str(rule.get("trigger_type") or "").strip().lower()
        trigger_value = str(rule.get("trigger_value") or "").strip().lower()
        if trigger_type != "cargo_tag" or trigger_value != "textile":
            continue

        calc_method = str(rule.get("calc_method") or "").strip().lower()
        if calc_method != "per_kg":
            continue

        rule_currency = str(rule.get("currency") or "CNY").strip().upper() or "CNY"
        if rule_currency != "CNY":
            return Decimal("0.00"), "", f"textile_surcharge_currency_unsupported:{rule_currency}"

        try:
            amount = Decimal(str(rule.get("amount") or "0"))
        except Exception:
            amount = Decimal("0")
        surcharge = chargeable_weight * amount

        min_charge = rule.get("min_charge")
        if min_charge is not None:
            try:
                min_value = Decimal(str(min_charge))
                if surcharge < min_value:
                    surcharge = min_value
            except Exception:
                pass

        max_charge = rule.get("max_charge")
        if max_charge is not None:
            try:
                max_value = Decimal(str(max_charge))
                if surcharge > max_value:
                    surcharge = max_value
            except Exception:
                pass

        surcharge = surcharge.quantize(Decimal("0.01"))
        stack_mode = str(rule.get("stack_mode") or "stackable").strip().lower() or "stackable"
        rule_name = str(rule.get("rule_name") or "cargo_tag:textile").strip() or "cargo_tag:textile"
        matched.append(
            (
                surcharge,
                f"{rule_name}={amount.quantize(Decimal('0.0001'))}CNY/kg*{chargeable_weight.quantize(Decimal('0.001'))}kg",
                stack_mode,
            )
        )

    if not matched:
        return Decimal("0.00"), "", None

    non_stackable = [item for item in matched if item[2] != "stackable"]
    selected = non_stackable[:1] if non_stackable else matched
    total = sum((item[0] for item in selected), Decimal("0")).quantize(Decimal("0.01"))
    note = " + ".join([item[1] for item in selected])
    return total, note, None


def channel_rejection_reason(
    channel_row: dict[str, Any],
    destination: str,
    target_country: str | None,
    cargo_nature: str,
    allow_any_destination: bool,
    tax_requirement: str,
    warehouse: str | None = None,
    address: str | None = None,
) -> str | None:
    _ = cargo_nature

    row_country = _normalize_country_code(channel_row.get("destination_country"))
    target_country_norm = _normalize_country_code(target_country)
    row_scope = (channel_row.get("destination_scope") or "any").lower()
    keyword = str(channel_row.get("destination_keyword") or "").strip()
    tokens = _parse_scope_tokens(keyword)
    row_tax = channel_row.get("tax_included")
    row_tax_effective = _effective_tax_included_value(row_tax)

    if row_scope == "country":
        if target_country_norm and row_country and not _country_compatible(row_country, target_country_norm):
            return f"country_mismatch:{row_country}->{target_country_norm}"
        if target_country_norm and not row_country and not allow_any_destination:
            return "destination_too_broad:country"
        if tokens and target_country_norm and target_country_norm not in tokens:
            return f"country_keyword_mismatch:{keyword}"

    elif row_scope == "country_list":
        if not tokens:
            return "country_list_missing_keyword"
        if not target_country_norm:
            return "target_country_missing"
        if target_country_norm not in tokens:
            return f"country_list_mismatch:{target_country_norm}->{','.join(tokens)}"
        if row_country and row_country != "EU" and not _country_compatible(row_country, target_country_norm):
            return f"country_mismatch:{row_country}->{target_country_norm}"

    elif row_scope == "fba_code":
        if target_country_norm and row_country and not _country_compatible(row_country, target_country_norm):
            return f"country_mismatch:{row_country}->{target_country_norm}"
        if not tokens:
            return "fba_code_missing_keyword"
        wh_code = _extract_warehouse_code(warehouse, destination)
        if not wh_code:
            return "fba_code_missing_input"
        if wh_code.upper() not in tokens:
            return f"fba_code_mismatch:{wh_code}->{','.join(tokens)}"

    elif row_scope == "zip_prefix":
        if target_country_norm and row_country and not _country_compatible(row_country, target_country_norm):
            return f"country_mismatch:{row_country}->{target_country_norm}"
        if not tokens:
            return "zip_prefix_missing_keyword"
        prefix = _extract_postal_prefix(address, destination)
        if not prefix:
            return "postal_code_missing"
        allowed_prefixes = [token[0] for token in tokens if token and token[0].isdigit()]
        if not allowed_prefixes:
            return "zip_prefix_invalid_keyword"
        if prefix not in allowed_prefixes:
            return f"zip_prefix_mismatch:{prefix}->{','.join(allowed_prefixes)}"

    elif row_scope == "any":
        return "destination_scope_any_ignored"

    else:
        # 未知 scope，兼容旧逻辑：country + keyword 子串匹配
        if target_country_norm and row_country and not _country_compatible(row_country, target_country_norm):
            return f"country_mismatch:{row_country}->{target_country_norm}"
        if keyword and not matches_destination(destination, keyword):
            return f"destination_mismatch:{keyword}"

    if tax_requirement == "required" and not row_tax_effective:
        return "tax_included_required"
    if tax_requirement == "not_required" and row_tax_effective:
        return "tax_excluded_required"

    return None


def recommend(
    rows: list[dict[str, Any]],
    destination: str,
    target_country: str | None,
    cargo_nature: str,
    boxes: list[BoxInput],
    has_textile: bool,
    top_n: int,
    allow_any_destination: bool,
    tax_requirement: str,
    warehouse: str | None = None,
    address: str | None = None,
    surcharge_rules_by_channel: dict[int, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    by_channel: dict[int, list[dict[str, Any]]] = {}
    for row in rows:
        by_channel.setdefault(row["id"], []).append(row)

    recommended: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    prioritize_tax_declared = _should_prioritize_tax_declared_channel(target_country, tax_requirement)
    channel_surcharge_map = surcharge_rules_by_channel or {}

    for channel_rows in by_channel.values():
        first = channel_rows[0]
        channel_surcharge_rules = channel_surcharge_map.get(int(first["id"]), [])
        cargo_allowed, effective_cargo_nature, cargo_surcharge, pricing_mode, cargo_reject_reason = _resolve_cargo_pricing_rule(
            first,
            cargo_nature,
            target_country,
        )
        if not cargo_allowed:
            rejected.append(build_rejected_channel(first, str(cargo_reject_reason or "cargo_nature_not_allowed")))
            continue

        reject_reason = channel_rejection_reason(
            channel_row=first,
            destination=destination,
            target_country=target_country,
            cargo_nature=effective_cargo_nature,
            allow_any_destination=allow_any_destination,
            tax_requirement=tax_requirement,
            warehouse=warehouse,
            address=address,
        )
        if reject_reason is not None:
            rejected.append(build_rejected_channel(first, reject_reason))
            continue

        tier_passed = False
        tier_fail_reasons: list[str] = []
        best_candidate: dict[str, Any] | None = None
        raw_tax_included = first.get("tax_included")
        effective_tax_included = _effective_tax_included_value(raw_tax_included)
        tax_resolution = _tax_included_resolution(raw_tax_included)
        channel_min_weight = min(Decimal(str(item["min_weight"])) for item in channel_rows)

        for row in channel_rows:
            ok, total_price, fail_reasons, box_details, used_default_divisor, calc_context = evaluate_tier_for_boxes(
                boxes,
                row,
                channel_min_weight=channel_min_weight,
            )
            if not ok:
                tier_fail_reasons.extend([f"tier#{row['tier_id']}:{x}" for x in fail_reasons])
                continue

            currency = str(row.get("currency") or "CNY")
            textile_surcharge, textile_surcharge_note, textile_surcharge_error = _resolve_textile_surcharge(
                channel_surcharge_rules,
                calc_context,
                has_textile,
            )
            if textile_surcharge_error:
                tier_fail_reasons.append(f"tier#{row['tier_id']}:{textile_surcharge_error}")
                continue

            total_surcharge = (cargo_surcharge + textile_surcharge).quantize(Decimal("0.01"))
            if total_surcharge > 0 and currency.upper() != "CNY":
                tier_fail_reasons.append(
                    f"tier#{row['tier_id']}:surcharge_currency_mismatch:{currency}"
                )
                continue

            surcharge_note_parts: list[str] = []
            if cargo_surcharge > 0 and pricing_mode:
                surcharge_note_parts.append(pricing_mode)
            if textile_surcharge > 0 and textile_surcharge_note:
                surcharge_note_parts.append(textile_surcharge_note)
            surcharge_note = " + ".join(surcharge_note_parts)

            tier_passed = True
            pricing_resolution = _resolve_candidate_base_pricing(
                channel_rows=channel_rows,
                channel_row=first,
                matched_row=row,
                matched_base_total=total_price,
                calc_context=calc_context,
                target_country=target_country,
            )
            base_total = pricing_resolution["base_total_price"]
            original_base_total = pricing_resolution["original_base_total_price"]
            rate_row = pricing_resolution["rate_row"]
            pricing_policy = str(pricing_resolution["pricing_policy"] or "standard")
            discount_applied = bool(pricing_resolution.get("discount_applied"))
            final_total = (base_total + total_surcharge).quantize(Decimal("0.01"))
            original_final_total = (original_base_total + total_surcharge).quantize(Decimal("0.01"))
            candidate = {
                "channel_id": first["id"],
                "channel_code": first["channel_code"],
                "channel_name": first["channel_name"],
                "currency": currency,
                "tier_id": row["tier_id"],
                "rate_source_tier_id": rate_row.get("tier_id"),
                "base_total_price": str(base_total),
                "original_base_total_price": str(original_base_total),
                "surcharge_price": str(total_surcharge),
                "textile_surcharge_price": str(textile_surcharge.quantize(Decimal("0.01"))),
                "surcharge_currency": "CNY",
                "pricing_mode": pricing_mode,
                "pricing_policy": pricing_policy,
                "discount_applied": discount_applied,
                "surcharge_note": surcharge_note,
                "has_textile": has_textile,
                "total_price": str(final_total),
                "original_total_price": str(original_final_total),
                "unit_price_used": str(Decimal(str(rate_row.get("unit_price") or "0")).quantize(Decimal("0.0001"))),
                "calc_context": calc_context,
                "transit_days": {
                    "min": first.get("transit_days_min"),
                    "max": first.get("transit_days_max"),
                },
                "destination_country": first.get("destination_country"),
                "destination_scope": first.get("destination_scope"),
                "tax_included": raw_tax_included,
                "effective_tax_included": effective_tax_included,
                "tax_included_resolution": tax_resolution,
                "source_company": first.get("source_company"),
                "source_workbook": first.get("source_workbook"),
                "rule_hits": [
                    f"transport_mode={first['transport_mode']}",
                    f"cargo_nature={cargo_nature}",
                    f"has_textile={str(has_textile).lower()}",
                    f"effective_cargo_nature={effective_cargo_nature}",
                    f"pricing_mode={pricing_mode}",
                    f"prioritize_tax_declared={str(prioritize_tax_declared).lower()}",
                    f"target_country={target_country or 'UNKNOWN'}",
                    f"destination_scope={first.get('destination_scope') or 'any'}",
                    f"tax_requirement={tax_requirement}",
                    f"effective_tax_included={str(effective_tax_included).lower()}",
                    f"tax_included_resolution={tax_resolution}",
                    f"destination_keyword={first.get('destination_keyword') or 'ANY'}",
                    f"tier=[{row['min_weight']},{row.get('max_weight')}]",
                    f"rate_source_tier=[{rate_row.get('min_weight')},{rate_row.get('max_weight')}]",
                    f"pricing_policy={pricing_policy}",
                    f"discount_applied={str(discount_applied).lower()}",
                    f"group_chargeable_weight={calc_context.get('chargeable_weight') or 'UNKNOWN'}",
                    f"group_billing_weight={calc_context.get('billing_weight') or 'UNKNOWN'}",
                    f"min_weight_floor_applied={calc_context.get('min_weight_floor_applied') or 'false'}",
                    f"surcharge={str(total_surcharge)} CNY",
                    f"textile_surcharge={str(textile_surcharge.quantize(Decimal('0.01')))} CNY",
                    f"default_volumetric_divisor={str(DEFAULT_VOLUMETRIC_DIVISOR)}",
                    f"used_default_divisor={str(used_default_divisor).lower()}",
                ],
                "box_details": box_details,
            }
            if best_candidate is None or Decimal(candidate["total_price"]) < Decimal(best_candidate["total_price"]):
                best_candidate = candidate

        if tier_passed and best_candidate is not None:
            recommended.append(best_candidate)
        else:
            rejected.append(build_rejected_channel(first, "no_tier_matched", tier_fail_reasons))

    def _recommended_sort_key(item: dict[str, Any]) -> tuple[int, Decimal, int]:
        tax_priority = 0
        if prioritize_tax_declared and not _effective_tax_included_value(item.get("tax_included")):
            tax_priority = 1
        transit_min = (
            item.get("transit_days", {}).get("min")
            if item.get("transit_days", {}).get("min") is not None
            else 10**9
        )
        return (
            tax_priority,
            Decimal(item["total_price"]),
            transit_min,
        )

    recommended.sort(key=_recommended_sort_key)

    return {
        "recommended": recommended[:top_n],
        "rejected": rejected,
    }


def _to_decimal(value: Any, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value))
    except Exception:
        return Decimal(default)


def _describe_pricing_policy(
    pricing_policy: str,
    rate_row: dict[str, Any] | None = None,
) -> str:
    policy = str(pricing_policy or "standard").strip().lower()
    if policy in {"", "standard"}:
        return ""

    tier_text = ""
    if isinstance(rate_row, dict) and rate_row:
        tier_text = f"（费率阶梯：{rate_row.get('min_weight')}-{rate_row.get('max_weight')}）"

    if policy == "jiufang_us_air_highest_tier_unit_price":
        return f"九方通逊美国空运优惠：按本渠道最高重量段费率计价{tier_text}"

    return f"特殊计价规则：{pricing_policy}{tier_text}"


def _format_channel_calc_note(
    box_details: list[dict[str, str]],
    row: dict[str, Any],
    total_price: Decimal,
    currency: str,
    surcharge_price: Decimal = Decimal("0"),
    surcharge_note: str = "",
    calc_context: dict[str, Any] | None = None,
    rate_row: dict[str, Any] | None = None,
    pricing_policy: str = "standard",
    original_total_price: Decimal | None = None,
) -> str:
    base_total_price = (total_price - surcharge_price).quantize(Decimal("0.01"))
    pricing_rate_row = rate_row or row
    unit_price = _to_decimal(pricing_rate_row.get("unit_price"))
    min_charge = _to_decimal(row.get("min_charge"))

    if isinstance(calc_context, dict) and calc_context:
        total_gross = _to_decimal(calc_context.get("total_gross_weight"))
        total_vol = _to_decimal(calc_context.get("total_volumetric_weight"))
        rounded_gross = _to_decimal(calc_context.get("rounded_total_gross_weight"))
        rounded_vol = _to_decimal(calc_context.get("rounded_total_volumetric_weight"))
        chargeable = _to_decimal(calc_context.get("chargeable_weight"))
        billing_weight = _to_decimal(calc_context.get("billing_weight"), default=str(chargeable))
        tier_min_weight = _to_decimal(calc_context.get("tier_min_weight"))
        min_weight_floor_applied = str(calc_context.get("min_weight_floor_applied") or "").strip().lower() == "true"
        billing_expr = f"billing=chargeable={billing_weight.quantize(Decimal('0.001'))}kg"
        if min_weight_floor_applied:
            billing_expr = (
                f"billing=max(chargeable={chargeable.quantize(Decimal('0.001'))}kg,"
                f" tier_min={tier_min_weight.quantize(Decimal('0.001'))}kg)="
                f"{billing_weight.quantize(Decimal('0.001'))}kg"
            )
        note = (
            "汇总: "
            f"sum_gross={total_gross.quantize(Decimal('0.001'))}kg->ceil={rounded_gross.quantize(Decimal('0.001'))}kg; "
            f"sum_vol={total_vol.quantize(Decimal('0.001'))}kg->ceil={rounded_vol.quantize(Decimal('0.001'))}kg; "
            f"chargeable=max({rounded_gross.quantize(Decimal('0.001'))},{rounded_vol.quantize(Decimal('0.001'))})="
            f"{chargeable.quantize(Decimal('0.001'))}kg; "
            f"{billing_expr}; "
            f"base=max({billing_weight.quantize(Decimal('0.001'))}*{unit_price.quantize(Decimal('0.0001'))},"
            f"{min_charge.quantize(Decimal('0.01'))})={base_total_price} {currency}"
        )
        if pricing_policy != "standard":
            policy_desc = _describe_pricing_policy(pricing_policy, pricing_rate_row)
            if policy_desc:
                note += f"; {policy_desc}"
            if original_total_price is not None and original_total_price.quantize(Decimal("0.01")) != total_price.quantize(Decimal("0.01")):
                note += f"; 原价={original_total_price.quantize(Decimal('0.01'))} {currency}"
        if surcharge_price > 0:
            note += (
                f"; surcharge={surcharge_price.quantize(Decimal('0.01'))} CNY ({surcharge_note}); "
                f"final={total_price.quantize(Decimal('0.01'))} {currency}"
            )
        elif pricing_policy != "standard":
            note += f"; final={total_price.quantize(Decimal('0.01'))} {currency}"
        return note

    if not box_details:
        if surcharge_price > 0:
            return (
                f"base={base_total_price} {currency}; "
                f"surcharge={surcharge_price.quantize(Decimal('0.01'))} CNY ({surcharge_note}); "
                f"final={total_price.quantize(Decimal('0.01'))} {currency}"
            )
        return f"total={total_price.quantize(Decimal('0.01'))} {currency}"

    if len(box_details) == 1:
        box = box_details[0]
        gross = _to_decimal(box.get("gross_weight"))
        vol = _to_decimal(box.get("volumetric_weight"))
        charge = _to_decimal(box.get("box_chargeable_weight") or box.get("chargeable_weight"))
        divisor = box.get("volumetric_divisor_used", str(DEFAULT_VOLUMETRIC_DIVISOR))
        note = f"1箱: chargeable=max({gross.quantize(Decimal('0.001'))},{vol.quantize(Decimal('0.001'))})={charge.quantize(Decimal('0.001'))}kg (div={divisor})"
        if surcharge_price > 0:
            note += (
                f"; surcharge={surcharge_price.quantize(Decimal('0.01'))} CNY ({surcharge_note}); "
                f"final={total_price.quantize(Decimal('0.01'))} {currency}"
            )
        return note

    total_charge = sum(_to_decimal(item.get("chargeable_weight")) for item in box_details)
    note = (
        f"{len(box_details)}箱: "
        f"sum chargeable={total_charge.quantize(Decimal('0.001'))}kg; "
        f"unit={unit_price.quantize(Decimal('0.0001'))}, min={min_charge.quantize(Decimal('0.01'))}, "
        f"base={base_total_price} {currency}"
    )
    if surcharge_price > 0:
        note += f"; surcharge={surcharge_price.quantize(Decimal('0.01'))} CNY ({surcharge_note})"
    note += f"; final={total_price.quantize(Decimal('0.01'))} {currency}"
    return note


def build_channel_price_snapshot(
    request: PricingRequest,
    rows: list[dict[str, Any]] | None = None,
    surcharge_rules_by_channel: dict[int, list[dict[str, Any]]] | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """
    生成前 N 个渠道的计价快照（用于输出简明价格说明文件）。
    """

    if rows is None:
        raise ValueError("rows is required for build_channel_price_snapshot")
    dataset = rows
    if not dataset:
        return []
    surcharge_rules_by_channel = (surcharge_rules_by_channel or {}) if request.has_textile else {}

    target_country = (request.target_country or infer_target_country(request.destination) or "").upper() or None
    prioritize_tax_declared = _should_prioritize_tax_declared_channel(target_country, request.tax_included)

    by_channel: dict[int, list[dict[str, Any]]] = {}
    channel_order: list[int] = []
    for row in dataset:
        channel_id = int(row["id"])
        if channel_id not in by_channel:
            channel_order.append(channel_id)
            by_channel[channel_id] = []
        by_channel[channel_id].append(row)

    snapshots: list[dict[str, Any]] = []
    for channel_id in channel_order:
        channel_rows = by_channel[channel_id]
        first = channel_rows[0]
        channel_surcharge_rules = surcharge_rules_by_channel.get(channel_id, [])

        entry: dict[str, Any] = {
            "channel_id": first.get("id"),
            "channel_code": first.get("channel_code"),
            "channel_name": first.get("channel_name"),
            "source_company": first.get("source_company"),
            "source_workbook": first.get("source_workbook"),
            "tax_included": first.get("tax_included"),
            "effective_tax_included": _effective_tax_included_value(first.get("tax_included")),
            "tax_included_resolution": _tax_included_resolution(first.get("tax_included")),
            "has_textile": request.has_textile,
            "destination_scope": first.get("destination_scope"),
            "destination_keyword": first.get("destination_keyword"),
            "transit_days_min": first.get("transit_days_min"),
            "transit_days_max": first.get("transit_days_max"),
            "status": "rejected",
            "currency": None,
            "base_total_price": None,
            "surcharge_price": "0.00",
            "textile_surcharge_price": "0.00",
            "surcharge_currency": "CNY",
            "pricing_mode": None,
            "total_price": None,
            "tier_id": None,
            "unit_price_used": None,
            "calc_note": "",
            "reason": "",
        }

        cargo_allowed, effective_cargo_nature, cargo_surcharge, pricing_mode, cargo_reject_reason = _resolve_cargo_pricing_rule(
            first,
            request.cargo_nature,
            target_country,
        )
        if not cargo_allowed:
            entry["reason"] = str(cargo_reject_reason or "cargo_nature_not_allowed")
            entry["calc_note"] = f"未计价: {entry['reason']}"
            snapshots.append(entry)
            continue

        reject_reason = channel_rejection_reason(
            channel_row=first,
            destination=request.destination,
            target_country=target_country,
            cargo_nature=effective_cargo_nature,
            allow_any_destination=request.allow_any_destination,
            tax_requirement=request.tax_included,
            warehouse=request.warehouse,
            address=request.address,
        )
        if reject_reason is not None:
            entry["reason"] = reject_reason
            entry["calc_note"] = f"未计价: {reject_reason}"
            snapshots.append(entry)
            continue

        tier_fail_reasons: list[str] = []
        best_candidate: dict[str, Any] | None = None
        channel_min_weight = min(Decimal(str(item["min_weight"])) for item in channel_rows)

        for row in channel_rows:
            ok, total_price, fail_reasons, box_details, used_default_divisor, calc_context = evaluate_tier_for_boxes(
                request.boxes, row, channel_min_weight=channel_min_weight
            )
            if not ok:
                tier_fail_reasons.extend([f"tier#{row['tier_id']}:{item}" for item in fail_reasons])
                continue

            currency = str(row.get("currency") or "CNY")
            textile_surcharge, textile_surcharge_note, textile_surcharge_error = _resolve_textile_surcharge(
                channel_surcharge_rules,
                calc_context,
                request.has_textile,
            )
            if textile_surcharge_error:
                tier_fail_reasons.append(f"tier#{row['tier_id']}:{textile_surcharge_error}")
                continue

            total_surcharge = (cargo_surcharge + textile_surcharge).quantize(Decimal("0.01"))
            if total_surcharge > 0 and currency.upper() != "CNY":
                tier_fail_reasons.append(
                    f"tier#{row['tier_id']}:surcharge_currency_mismatch:{currency}"
                )
                continue

            surcharge_note_parts: list[str] = []
            if cargo_surcharge > 0 and pricing_mode:
                surcharge_note_parts.append(pricing_mode)
            if textile_surcharge > 0 and textile_surcharge_note:
                surcharge_note_parts.append(textile_surcharge_note)
            surcharge_note = " + ".join(surcharge_note_parts)

            pricing_resolution = _resolve_candidate_base_pricing(
                channel_rows=channel_rows,
                channel_row=first,
                matched_row=row,
                matched_base_total=total_price,
                calc_context=calc_context,
                target_country=target_country,
            )
            base_total = pricing_resolution["base_total_price"]
            original_base_total = pricing_resolution["original_base_total_price"]
            rate_row = pricing_resolution["rate_row"]
            pricing_policy = str(pricing_resolution["pricing_policy"] or "standard")
            discount_applied = bool(pricing_resolution.get("discount_applied"))
            final_total = (base_total + total_surcharge).quantize(Decimal("0.01"))
            original_final_total = (original_base_total + total_surcharge).quantize(Decimal("0.01"))
            candidate = {
                "row": row,
                "rate_row": rate_row,
                "base_total_price": base_total,
                "original_base_total_price": original_base_total,
                "surcharge_price": total_surcharge,
                "textile_surcharge_price": textile_surcharge.quantize(Decimal("0.01")),
                "pricing_mode": pricing_mode,
                "pricing_policy": pricing_policy,
                "discount_applied": discount_applied,
                "surcharge_note": surcharge_note,
                "total_price": final_total,
                "original_total_price": original_final_total,
                "box_details": box_details,
                "used_default_divisor": used_default_divisor,
                "calc_context": calc_context,
            }
            if best_candidate is None or candidate["total_price"] < best_candidate["total_price"]:
                best_candidate = candidate

        if best_candidate is None:
            entry["reason"] = "no_tier_matched"
            if tier_fail_reasons:
                entry["calc_note"] = f"未计价: {tier_fail_reasons[0]}"
            else:
                entry["calc_note"] = "未计价: no_tier_matched"
            snapshots.append(entry)
            continue

        selected_row = best_candidate["row"]
        selected_rate_row = best_candidate.get("rate_row") or selected_row
        selected_total = best_candidate["total_price"]
        selected_base_total = best_candidate["base_total_price"]
        selected_original_base_total = best_candidate.get("original_base_total_price") or selected_base_total
        selected_surcharge = best_candidate["surcharge_price"]
        selected_textile_surcharge = best_candidate.get("textile_surcharge_price") or Decimal("0.00")
        selected_pricing_mode = best_candidate["pricing_mode"]
        selected_pricing_policy = str(best_candidate.get("pricing_policy") or "standard")
        selected_discount_applied = bool(best_candidate.get("discount_applied"))
        selected_surcharge_note = str(best_candidate.get("surcharge_note") or "")
        selected_box_details = best_candidate["box_details"]
        selected_calc_context = best_candidate.get("calc_context") or {}
        selected_original_total = best_candidate.get("original_total_price") or selected_total
        selected_currency = str(selected_row.get("currency") or "CNY")
        entry["status"] = "priced"
        entry["currency"] = selected_currency
        entry["base_total_price"] = str(selected_base_total.quantize(Decimal("0.01")))
        entry["original_base_total_price"] = str(selected_original_base_total.quantize(Decimal("0.01")))
        entry["surcharge_price"] = str(selected_surcharge.quantize(Decimal("0.01")))
        entry["textile_surcharge_price"] = str(selected_textile_surcharge.quantize(Decimal("0.01")))
        entry["pricing_mode"] = selected_pricing_mode
        entry["pricing_policy"] = selected_pricing_policy
        entry["discount_applied"] = selected_discount_applied
        entry["total_price"] = str(selected_total.quantize(Decimal("0.01")))
        entry["original_total_price"] = str(selected_original_total.quantize(Decimal("0.01")))
        entry["tier_id"] = selected_row.get("tier_id")
        entry["rate_source_tier_id"] = selected_rate_row.get("tier_id")
        unit_price_used = _to_decimal(selected_rate_row.get("unit_price"))
        entry["unit_price_used"] = (
            str(unit_price_used.quantize(Decimal("0.0001"))) if unit_price_used is not None else None
        )
        entry["source_workbook"] = selected_row.get("source_workbook") or entry.get("source_workbook")
        entry["reason"] = ""
        entry["calc_note"] = _format_channel_calc_note(
            selected_box_details,
            selected_row,
            selected_total,
            selected_currency,
            surcharge_price=selected_surcharge,
            surcharge_note=selected_surcharge_note,
            calc_context=selected_calc_context,
            rate_row=selected_rate_row,
            pricing_policy=selected_pricing_policy,
            original_total_price=selected_original_total,
        )
        snapshots.append(entry)

    def _snapshot_sort_key(item: dict[str, Any]) -> tuple[Any, Any, Any, str]:
        status = str(item.get("status") or "rejected").lower()
        channel_code = str(item.get("channel_code") or "")
        if status == "priced":
            tax_priority = 0
            if prioritize_tax_declared and not _effective_tax_included_value(item.get("tax_included")):
                tax_priority = 1
            return (0, tax_priority, _to_decimal(item.get("total_price"), default="999999999"), channel_code)
        return (1, 0, str(item.get("reason") or "unknown"), channel_code)

    snapshots_sorted = sorted(snapshots, key=_snapshot_sort_key)
    return snapshots_sorted[: max(0, int(limit))]


def summarize_rejected(rejected: list[dict[str, Any]]) -> dict[str, int]:
    counter = Counter()
    for item in rejected:
        reason = str(item.get("reason") or "unknown")
        base_reason = reason.split(":", 1)[0]
        counter[base_reason] += 1
    return dict(counter)


def evaluate_request(
    request: PricingRequest,
    rows: list[dict[str, Any]] | None = None,
    surcharge_rules_by_channel: dict[int, list[dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    if rows is None:
        raise ValueError("rows is required for evaluate_request")
    dataset = rows
    if not dataset:
        raise ValueError(
            "No active channels/tiers found for this transport mode. "
            "Please initialize and import pricing data first."
        )
    surcharge_rules_by_channel = (surcharge_rules_by_channel or {}) if request.has_textile else {}

    target_country = (request.target_country or infer_target_country(request.destination) or "").upper() or None

    result = recommend(
        rows=dataset,
        destination=request.destination,
        target_country=target_country,
        cargo_nature=request.cargo_nature,
        boxes=request.boxes,
        has_textile=request.has_textile,
        top_n=max(1, request.top_n),
        allow_any_destination=request.allow_any_destination,
        tax_requirement=request.tax_included,
        warehouse=request.warehouse,
        address=request.address,
        surcharge_rules_by_channel=surcharge_rules_by_channel,
    )

    rejected = result.get("rejected", [])
    output: dict[str, Any] = {
        "target_country": target_country,
        "tax_requirement": request.tax_included,
        "has_textile": request.has_textile,
        "recommended": result.get("recommended", []),
        "rejected_count": len(rejected),
        "rejected_summary": summarize_rejected(rejected),
    }

    if request.verbose_rejected:
        max_details = max(0, int(request.max_rejected_details))
        trimmed = []
        for item in rejected:
            cloned = dict(item)
            details = cloned.get("details")
            if isinstance(details, list) and len(details) > max_details:
                cloned["details"] = details[:max_details]
                cloned["details_omitted"] = len(details) - max_details
            trimmed.append(cloned)
        output["rejected"] = trimmed

    return output
