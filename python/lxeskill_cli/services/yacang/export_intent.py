from __future__ import annotations

import re
from datetime import date, timedelta
from typing import Any, Callable, Mapping

from services.yacang.exports.sales_source import resolve_source_date_range
from services.yacang.warehouses import (
    WAREHOUSES,
    WAREHOUSE_ALIAS_TO_CODE,
    match_warehouse_aliases,
)


ALL_DATA_TYPES = (
    "inventory-sales",
    "inventory-current-snapshot",
    "inbound-listing-time",
)
WAREHOUSE_CODES = tuple(warehouse.code for warehouse in WAREHOUSES)

_LEGACY_DATA_TYPES = {
    "sales-monthly": "inventory-sales",
    "sales-90d": "inventory-sales",
    "inventory-month-end": "inventory-current-snapshot",
}
_AGENT_SELECTION_STATES = {"omitted", "resolved", "ambiguous"}
_INVENTORY_STATES = {"current", "historical", "omitted", "ambiguous"}
_CREATED_MODES = {"default", "relative_days", "explicit_range"}

_WAREHOUSE_RE = re.compile(r"(?<![A-Z0-9])([A-Z]{2}\d{4})(?![A-Z0-9])", re.IGNORECASE)
_RELATIVE_CREATED_RE = re.compile(
    r"(?P<fragment>(?:最近|近|过去)\s*(?P<days>\d+)\s*天(?:内)?\s*(?:创建|新建|建档))"
)
_ISO_RANGE_RE = re.compile(
    r"(?P<start>\d{4}-\d{1,2}-\d{1,2})\s*(?:到|至|~|～|—|–)\s*"
    r"(?P<end>\d{4}-\d{1,2}-\d{1,2})"
)
_CN_RANGE_RE = re.compile(
    r"(?P<start>(?P<start_year>\d{4})年(?P<start_month>\d{1,2})月(?P<start_day>\d{1,2})日?)"
    r"\s*(?:到|至|~|～|—|–)\s*"
    r"(?P<end>(?P<end_year>\d{4})年(?P<end_month>\d{1,2})月(?P<end_day>\d{1,2})日?)"
)
_CN_YEARLESS_RANGE_RE = re.compile(
    r"(?<!\d年)(?P<start>(?P<start_month>\d{1,2})月(?P<start_day>\d{1,2})日?)"
    r"\s*(?:到|至|~|～|—|–)\s*"
    r"(?P<end>(?P<end_month>\d{1,2})月(?P<end_day>\d{1,2})日?)"
)
_DATE_TOKEN_RE = re.compile(r"\d{4}-\d{1,2}-\d{1,2}|(?:\d{4}年)?\d{1,2}月\d{1,2}日?")
_SALES_DAYS_RE = re.compile(r"(?<!\d)(?P<days>\d{1,3})\s*天(?:的)?(?:每天|每日|日度)?销量")
_SALES_DAY_SEQUENCE_RE = re.compile(
    r"(?P<windows>\d{1,3}(?:\s*[/、]\s*\d{1,3})+)\s*天?(?:的)?销量"
)
_DAILY_SALES_DETAIL_RE = re.compile(r"逐日|每天|每日|日度|日销量|日销")

_ALL_DATA_MARKERS = ("全部数据", "所有数据", "完整数据", "全套", "四类", "导一套")
_ALL_WAREHOUSE_MARKERS = (
    "四仓",
    "四个仓",
    "四个仓库",
    "全部仓库",
    "所有仓库",
    "全仓",
    "全部四仓",
    "四仓都要",
)
_CREATED_WORDS = ("创建", "新建", "建档")
_UNKNOWN_BUSINESS_MARKERS = ("订单", "退货", "采购", "出库", "利润", "成本", "费用", "账单", "运费")
_MONTHLY_SALES_MARKERS = (
    "7/15/30",
    "7、15、30",
    "7 15 30",
    "月度销量",
    "汇总销量",
    "最近一个月销量",
    "最近一个月销售",
    "最近一个月卖得怎么样",
    "近一个月销量",
    "近一个月销售",
    "最近一个月出货",
    "最近30天销售",
    "近30天销售",
    "最近30天卖了多少",
    "近30天卖了多少",
    "一周销量",
    "两周销量",
    "一个月销量",
    "近期销售表现",
    "近期销售情况",
)
_DAILY_SALES_MARKERS = (
    "日度90天",
    "日度 90 天",
    "90天日销量",
    "90 天日销量",
    "近90天",
    "近 90 天",
    "最近90天",
    "最近 90 天",
    "最近三个月每天",
    "近三个月每天",
    "三个月每天",
    "最近三个月每日",
    "近三个月每日",
    "三个月每日",
    "三个月日销",
    "三个月销售趋势",
    "每天的销量",
    "每天销量",
    "每日销量",
    "逐日",
)
_CURRENT_INVENTORY_MARKERS = (
    "当前库存",
    "现在库存",
    "库存现状",
    "现在还有多少货",
    "现在仓里",
    "还剩多少货",
    "仓里还有多少",
    "当前剩多少",
    "现有库存",
    "目前库存",
    "库存情况",
    "库存列表",
    "库存快照",
)
_INBOUND_LISTING_MARKERS = (
    "什么时候入库",
    "什么时候进仓",
    "什么时候上架",
    "哪天入仓",
    "入库时间",
    "入库日期",
    "入仓日期",
    "上架时间",
    "上架日期",
    "什么时候上的架",
    "什么时候进来的",
    "仓库产品",
    "产品资料",
)


def normalize_export_intent(
    request_text: Any,
    *,
    data_type_intent: Mapping[str, Any] | None = None,
    warehouse_intent: Mapping[str, Any] | None = None,
    created_date_filter: Mapping[str, Any] | None = None,
    inventory_snapshot_intent: Mapping[str, Any] | None = None,
    today: Callable[[], date] = date.today,
) -> dict[str, Any]:
    text = require_request_text(request_text)
    execution_day = today()
    fixed_today = lambda: execution_day
    parsed = parse_request_text(text, today=fixed_today)
    candidates = validate_intent_candidates(
        data_type_intent=data_type_intent,
        warehouse_intent=warehouse_intent,
        created_date_filter=created_date_filter,
        inventory_snapshot_intent=inventory_snapshot_intent,
    )
    return merge_and_resolve_intent(text, parsed, candidates, today=fixed_today)


def normalize_structured_intent(
    *,
    data_type_intent: Mapping[str, Any],
    warehouse_intent: Mapping[str, Any],
    created_date_filter: Mapping[str, Any],
    inventory_snapshot_intent: Mapping[str, Any],
    today: Callable[[], date] = date.today,
) -> dict[str, Any]:
    """Normalize an AI-produced intent without inspecting the user's raw text."""
    execution_day = today()
    fixed_today = lambda: execution_day
    candidates = validate_intent_candidates(
        data_type_intent=data_type_intent,
        warehouse_intent=warehouse_intent,
        created_date_filter=created_date_filter,
        inventory_snapshot_intent=inventory_snapshot_intent,
        require_explicit_created_dates=True,
    )
    intent = {
        "data_type_intent": candidates["data_type_intent"] or {"state": "omitted"},
        "warehouse_intent": candidates["warehouse_intent"] or {"state": "omitted"},
        "created_date_filter": candidates["created_date_filter"] or {"state": "omitted"},
        "inventory_snapshot_intent": candidates["inventory_snapshot_intent"] or {"state": "omitted"},
    }
    questions = _structured_intent_questions(intent)
    preflight_issues: list[dict[str, Any]] = []
    if intent["inventory_snapshot_intent"]["state"] == "historical":
        preflight_issues.append(
            _issue(
                "unsupported",
                "UNSUPPORTED_HISTORICAL_INVENTORY",
                "当前雅仓能力不支持指定历史日期或历史月末库存快照。",
            )
        )
    if questions:
        return {
            "intent": intent,
            "effective_request": None,
            "questions": questions,
            "preflight_issues": preflight_issues,
            "requires_clarification": True,
        }

    data_types = list(ALL_DATA_TYPES) if intent["data_type_intent"]["state"] == "omitted" else list(
        intent["data_type_intent"]["values"]
    )
    warehouses = _effective_selection(intent["warehouse_intent"], WAREHOUSE_CODES)
    if data_types == ["inbound-listing-time"]:
        intent["warehouse_intent"] = {"state": "omitted"}
        warehouses = list(WAREHOUSE_CODES)
    sales_selected = "inventory-sales" in data_types
    inventory_selected = "inventory-current-snapshot" in data_types
    created_intent = intent["created_date_filter"]
    if created_intent["state"] != "omitted" and not sales_selected:
        preflight_issues.append(
            _issue(
                "invalid",
                "INVALID_CREATED_DATE_SCOPE",
                "商品创建日期筛选只能用于销量任务。",
            )
        )
    if intent["inventory_snapshot_intent"]["state"] == "current" and not inventory_selected:
        preflight_issues.append(
            _issue(
                "invalid",
                "INVALID_INVENTORY_INTENT_SCOPE",
                "库存快照意图只能用于库存任务。",
            )
        )

    effective_request: dict[str, Any] = {
        "data_types": data_types,
        "warehouses": warehouses,
    }
    if sales_selected:
        parsed = {
            "_created_effective": {
                "created_start_date": created_intent.get("start_date"),
                "created_end_date": created_intent.get("end_date"),
                "input_fragments": [],
                "normalization_rules": ["ai_structured_explicit_range"],
            }
        }
        effective_request["created_date_filter"] = _effective_created_date_filter(
            created_intent,
            parsed,
            today=fixed_today,
        )
    return {
        "intent": intent,
        "effective_request": effective_request,
        "questions": [],
        "preflight_issues": _deduplicate_records(preflight_issues),
        "requires_clarification": False,
    }


def _structured_intent_questions(intent: Mapping[str, Mapping[str, Any]]) -> list[dict[str, str]]:
    questions: list[dict[str, str]] = []
    messages = {
        "data_type_intent": ("data_type", "DATA_TYPE_REQUIRED", "请确认需要导出哪类雅仓数据。"),
        "warehouse_intent": ("warehouse", "WAREHOUSE_REQUIRED", "请确认需要导出的雅仓仓库范围。"),
        "created_date_filter": ("created_date", "CREATED_DATE_REQUIRED", "请确认商品创建日期筛选条件。"),
        "inventory_snapshot_intent": (
            "inventory_snapshot",
            "INVENTORY_SNAPSHOT_REQUIRED",
            "请确认需要当前库存还是历史库存。",
        ),
    }
    for field, (dimension, code, message) in messages.items():
        if intent[field].get("state") == "ambiguous":
            questions.append(_question(dimension, code, message))
    return questions


def require_request_text(request_text: Any) -> str:
    if not isinstance(request_text, str) or not request_text.strip():
        raise ValueError("request_text 必须是非空文本")
    return request_text.strip()


def validate_intent_candidates(
    *,
    data_type_intent: Mapping[str, Any] | None = None,
    warehouse_intent: Mapping[str, Any] | None = None,
    created_date_filter: Mapping[str, Any] | None = None,
    inventory_snapshot_intent: Mapping[str, Any] | None = None,
    require_explicit_created_dates: bool = False,
) -> dict[str, dict[str, Any] | None]:
    return {
        "data_type_intent": _validate_selection_candidate(
            "data_type_intent",
            data_type_intent,
            allowed_values=ALL_DATA_TYPES,
            aliases=_LEGACY_DATA_TYPES,
        ),
        "warehouse_intent": _validate_selection_candidate(
            "warehouse_intent",
            warehouse_intent,
            allowed_values=WAREHOUSE_CODES,
            aliases=WAREHOUSE_ALIAS_TO_CODE,
        ),
        "created_date_filter": _validate_created_candidate(
            created_date_filter,
            require_explicit_dates=require_explicit_created_dates,
        ),
        "inventory_snapshot_intent": _validate_inventory_candidate(inventory_snapshot_intent),
    }


def _validate_selection_candidate(
    name: str,
    candidate: Mapping[str, Any] | None,
    *,
    allowed_values: tuple[str, ...],
    aliases: Mapping[str, str] | None = None,
) -> dict[str, Any] | None:
    if candidate is None:
        return None
    value = _mapping_copy(name, candidate)
    state = value.get("state")
    if state not in _AGENT_SELECTION_STATES:
        raise ValueError(f"{name}.state 只允许 omitted、resolved 或 ambiguous")
    expected_keys = {"state", "values"} if state == "resolved" else {"state"}
    _require_exact_keys(name, value, expected_keys)
    if state != "resolved":
        return {"state": state}

    values = value["values"]
    if not isinstance(values, list) or not values:
        raise ValueError(f"{name}.values 必须是非空列表")
    if any(not isinstance(item, str) for item in values):
        raise ValueError(f"{name}.values 只能包含字符串")
    aliases = aliases or {}
    if len(set(values)) != len(values):
        raise ValueError(f"{name}.values 不允许重复")
    normalized = list(dict.fromkeys(aliases.get(item, item) for item in values))
    unknown = sorted(set(normalized).difference(allowed_values))
    if unknown:
        raise ValueError(f"{name}.values 包含不支持的值: {', '.join(unknown)}")
    selected = [item for item in allowed_values if item in normalized]
    return {"state": "resolved", "values": selected}


def _validate_created_candidate(
    candidate: Mapping[str, Any] | None,
    *,
    require_explicit_dates: bool = False,
) -> dict[str, Any] | None:
    if candidate is None:
        return None
    value = _mapping_copy("created_date_filter", candidate)
    state = value.get("state")
    if state not in _AGENT_SELECTION_STATES:
        raise ValueError("created_date_filter.state 只允许 omitted、resolved 或 ambiguous")
    if state != "resolved":
        _require_exact_keys("created_date_filter", value, {"state"})
        return {"state": state}

    mode = value.get("mode")
    if mode not in _CREATED_MODES:
        raise ValueError("created_date_filter.mode 不受支持")
    if mode == "relative_days":
        expected_keys = {"state", "mode", "days"}
    elif mode == "explicit_range" and require_explicit_dates:
        expected_keys = {"state", "mode", "start_date", "end_date"}
    else:
        expected_keys = {"state", "mode"}
    _require_exact_keys("created_date_filter", value, expected_keys)
    if mode == "relative_days":
        days = value["days"]
        if isinstance(days, bool) or not isinstance(days, int) or days <= 0:
            raise ValueError("created_date_filter.days 必须是正整数")
        return {"state": "resolved", "mode": mode, "days": days}
    if mode == "explicit_range" and require_explicit_dates:
        start = _validate_iso_date(value["start_date"], "created_date_filter.start_date")
        end = _validate_iso_date(value["end_date"], "created_date_filter.end_date")
        if start > end:
            raise ValueError("created_date_filter.start_date 不能晚于 end_date")
        return {"state": "resolved", "mode": mode, "start_date": start, "end_date": end}
    return {"state": "resolved", "mode": mode}


def _validate_iso_date(value: Any, name: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{name} 必须是 YYYY-MM-DD 字符串")
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError as exc:
        raise ValueError(f"{name} 必须是有效的 YYYY-MM-DD 日期") from exc


def _validate_inventory_candidate(
    candidate: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    if candidate is None:
        return None
    value = _mapping_copy("inventory_snapshot_intent", candidate)
    _require_exact_keys("inventory_snapshot_intent", value, {"state"})
    state = value.get("state")
    if state not in _INVENTORY_STATES:
        raise ValueError(
            "inventory_snapshot_intent.state 只允许 current、historical、omitted 或 ambiguous"
        )
    return {"state": state}


def _mapping_copy(name: str, value: Mapping[str, Any]) -> dict[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"{name} 必须是对象")
    return dict(value)


def _require_exact_keys(name: str, value: Mapping[str, Any], expected: set[str]) -> None:
    actual = set(value)
    if actual != expected:
        extras = sorted(actual.difference(expected))
        missing = sorted(expected.difference(actual))
        details: list[str] = []
        if extras:
            details.append("不允许字段 " + ", ".join(extras))
        if missing:
            details.append("缺少字段 " + ", ".join(missing))
        raise ValueError(f"{name} 字段形状无效: {'；'.join(details)}")


def parse_request_text(
    request_text: str,
    *,
    today: Callable[[], date] = date.today,
) -> dict[str, Any]:
    questions: list[dict[str, str]] = []
    preflight_issues: list[dict[str, Any]] = []

    warehouse_intent, warehouse_explicit = _parse_warehouse_intent(request_text, questions)
    created_intent, created_effective, created_explicit = _parse_created_date_intent(
        request_text,
        questions,
        today=today,
    )
    (
        data_type_intent,
        supported_data_types,
        inventory_intent,
        type_issues,
    ) = _parse_data_type_intent(request_text, questions)
    preflight_issues.extend(type_issues)

    return {
        "data_type_intent": data_type_intent,
        "warehouse_intent": warehouse_intent,
        "created_date_filter": created_intent,
        "inventory_snapshot_intent": inventory_intent,
        "_supported_data_types": supported_data_types,
        "_created_effective": created_effective,
        "_warehouse_explicit": warehouse_explicit,
        "_created_explicit": created_explicit,
        "_questions": questions,
        "_preflight_issues": preflight_issues,
    }


def _parse_warehouse_intent(
    text: str,
    questions: list[dict[str, str]],
) -> tuple[dict[str, Any], bool]:
    mentioned = {match.upper() for match in _WAREHOUSE_RE.findall(text.upper())}
    mentioned.update(match_warehouse_aliases(text))
    unknown = sorted(mentioned.difference(WAREHOUSE_CODES))
    selected = [code for code in WAREHOUSE_CODES if code in mentioned]
    all_requested = any(marker in text for marker in _ALL_WAREHOUSE_MARKERS)
    if unknown:
        questions.append(
            _question(
                "warehouse",
                "UNKNOWN_WAREHOUSE",
                "无法识别仓库 " + ", ".join(unknown) + "；仅支持 " + ", ".join(WAREHOUSE_CODES) + "。",
            )
        )
        return {"state": "ambiguous"}, True
    if all_requested:
        return {"state": "resolved", "values": list(WAREHOUSE_CODES)}, True
    if selected:
        return {"state": "resolved", "values": selected}, True
    vague = re.search(r"美国仓|美仓|某仓|\d+号仓", text)
    if vague:
        questions.append(
            _question(
                "warehouse",
                "AMBIGUOUS_WAREHOUSE",
                f"无法唯一识别仓库“{vague.group(0)}”；请使用仓库代码或明确说全部仓库。",
            )
        )
        return {"state": "ambiguous"}, True
    return {"state": "omitted"}, False


def _parse_created_date_intent(
    text: str,
    questions: list[dict[str, str]],
    *,
    today: Callable[[], date],
) -> tuple[dict[str, Any], dict[str, Any] | None, bool]:
    has_created_word = any(word in text for word in _CREATED_WORDS)
    default_requested = "默认日期" in text or "默认创建日期" in text
    relative = _RELATIVE_CREATED_RE.search(text)
    explicit = _extract_explicit_range(text, execution_year=today().year) if has_created_word else None
    date_tokens = _DATE_TOKEN_RE.findall(text) if has_created_word else []

    if default_requested and (relative or explicit or date_tokens):
        questions.append(
            _question(
                "created_date",
                "CREATED_DATE_MODE_CONFLICT",
                "默认商品创建日期不能与显式创建日期条件同时使用。",
            )
        )
        return {"state": "ambiguous"}, None, True
    if default_requested:
        return {"state": "resolved", "mode": "default"}, None, True
    if relative:
        days = int(relative.group("days"))
        if days <= 0:
            questions.append(
                _question(
                    "created_date",
                    "INVALID_RELATIVE_CREATED_DAYS",
                    "最近 N 天创建中的 N 必须是正整数。",
                )
            )
            return {"state": "ambiguous"}, None, True
        fragment = re.sub(r"\s+", "", relative.group("fragment"))
        return (
            {"state": "resolved", "mode": "relative_days", "days": days},
            {"fragment": fragment},
            True,
        )
    if explicit is not None:
        if explicit.get("error"):
            questions.append(
                _question("created_date", explicit["error"], explicit["message"])
            )
            return {"state": "ambiguous"}, None, True
        return {"state": "resolved", "mode": "explicit_range"}, explicit, True
    if has_created_word and date_tokens:
        questions.append(
            _question(
                "created_date",
                "INCOMPLETE_CREATED_DATE_RANGE",
                "商品创建日期必须同时提供完整的开始日期和结束日期。",
            )
        )
        return {"state": "ambiguous"}, None, True
    if re.search(r"(?:最近|近|过去)\s*\d+\s*天的商品销量", text):
        questions.append(
            _question(
                "created_date",
                "AMBIGUOUS_CREATED_DATE",
                "请确认该天数是销量报表口径，还是商品创建日期条件。",
            )
        )
        return {"state": "ambiguous"}, None, True
    if not has_created_word and _contains_date_range(text) and "销量" in text:
        questions.append(
            _question(
                "created_date",
                "AMBIGUOUS_CREATED_DATE",
                "请确认该日期范围是否用于筛选商品创建日期。",
            )
        )
        return {"state": "ambiguous"}, None, True
    return {"state": "omitted"}, None, False


def _extract_explicit_range(text: str, *, execution_year: int) -> dict[str, Any] | None:
    match = _ISO_RANGE_RE.search(text)
    if match:
        return _build_explicit_range(
            match.group("start"),
            match.group("end"),
            fragments=[match.group("start"), match.group("end")],
            rules=["explicit_iso_range"],
        )
    match = _CN_RANGE_RE.search(text)
    if match:
        return _build_explicit_range(
            f'{match.group("start_year")}-{match.group("start_month")}-{match.group("start_day")}',
            f'{match.group("end_year")}-{match.group("end_month")}-{match.group("end_day")}',
            fragments=[match.group("start"), match.group("end")],
            rules=["explicit_chinese_range"],
        )
    match = _CN_YEARLESS_RANGE_RE.search(text)
    if match:
        normalized = _build_explicit_range(
            f'{execution_year}-{match.group("start_month")}-{match.group("start_day")}',
            f'{execution_year}-{match.group("end_month")}-{match.group("end_day")}',
            fragments=[match.group("start"), match.group("end")],
            rules=["explicit_chinese_range", "execution_year_inference"],
        )
        if normalized.get("error") == "INVERTED_CREATED_DATE_RANGE":
            return {
                "error": "AMBIGUOUS_CROSS_YEAR_CREATED_DATE",
                "message": "无年份商品创建日期可能跨年，不能唯一正规化。",
            }
        return normalized
    return None


def _build_explicit_range(
    start_text: str,
    end_text: str,
    *,
    fragments: list[str],
    rules: list[str],
) -> dict[str, Any]:
    try:
        start = date(*(int(part) for part in start_text.split("-")))
        end = date(*(int(part) for part in end_text.split("-")))
    except (TypeError, ValueError):
        return {
            "error": "INVALID_CREATED_DATE",
            "message": "商品创建日期包含无效日期。",
        }
    if start > end:
        return {
            "error": "INVERTED_CREATED_DATE_RANGE",
            "message": "商品创建日期的开始日期不能晚于结束日期。",
        }
    return {
        "created_start_date": start.isoformat(),
        "created_end_date": end.isoformat(),
        "input_fragments": fragments,
        "normalization_rules": rules,
    }


def _contains_date_range(text: str) -> bool:
    return bool(_ISO_RANGE_RE.search(text) or _CN_RANGE_RE.search(text) or _CN_YEARLESS_RANGE_RE.search(text))


def _parse_data_type_intent(
    text: str,
    questions: list[dict[str, str]],
) -> tuple[dict[str, Any], list[str], dict[str, Any], list[dict[str, Any]]]:
    combined_inventory_sales = bool(
        re.search(
            r"(?:库存\s*(?:和|与|、|及|以及)\s*(?:两种|两类)?销量|销量\s*(?:和|与|、|及|以及)\s*库存)",
            text,
        )
    )
    explicit_inventory_sales = bool(
        re.search(r"库存动销|动销数据|销量", text)
    ) or combined_inventory_sales
    daily_sales_detail = bool(_DAILY_SALES_DETAIL_RE.search(text)) and bool(
        explicit_inventory_sales or re.search(r"销售|出货|卖|日销|日度", text)
    )
    if _requests_all_data(text) and not daily_sales_detail:
        return (
            {"state": "resolved", "values": list(ALL_DATA_TYPES)},
            list(ALL_DATA_TYPES),
            {"state": "omitted"},
            [],
        )

    selected: set[str] = set()
    issues: list[dict[str, Any]] = []
    ambiguous_sales = False

    if daily_sales_detail:
        issues.append(
            {
                "kind": "unsupported",
                "code": "UNSUPPORTED_DATA_TYPE",
                "requested_value": {"sales_granularity": "daily"},
                "message": "当前雅仓库存动销只提供固定窗口的累计销量，不提供逐日销量明细",
            }
        )

    sequence_match = _SALES_DAY_SEQUENCE_RE.search(text)
    sales_day_matches = (
        [int(value) for value in re.findall(r"\d{1,3}", sequence_match.group("windows"))]
        if sequence_match
        else [int(match.group("days")) for match in _SALES_DAYS_RE.finditer(text)]
    )
    unsupported_days = [days for days in sales_day_matches if days not in {7, 15, 30, 60, 90}]
    if unsupported_days:
        sales_day_matches = unsupported_days
    for days in sales_day_matches:
        if days in {7, 15, 30, 60, 90}:
            if not daily_sales_detail:
                selected.add("inventory-sales")
        else:
            issues.append(
                {
                    "kind": "unsupported",
                    "code": "UNSUPPORTED_SALES_WINDOW",
                    "requested_value": {"sales_window_days": days},
                    "message": "当前完整库存动销报表只包含固定的销量窗口，不支持自定义销量天数",
                }
            )

    if not issues and any(marker in text for marker in _MONTHLY_SALES_MARKERS):
        selected.add("inventory-sales")
    if not issues and any(marker in text for marker in _DAILY_SALES_MARKERS):
        selected.add("inventory-sales")
    if explicit_inventory_sales and not issues:
        selected.add("inventory-sales")

    historical_inventory = bool(
        re.search(r"上个?月(?:月底|月末)库存|历史(?:月底|月末)?库存|\d{1,2}月\d{1,2}日(?:的)?库存", text)
    )
    bare_month_end = any(marker in text for marker in ("月底库存", "月末库存", "月末快照"))
    current_inventory = any(marker in text for marker in _CURRENT_INVENTORY_MARKERS)
    bare_inventory = (
        "库存" in text
        and "库存动销" not in text
        and (re.search(r"库存.*销量", text) is None or combined_inventory_sales)
        and "库存相关" not in text
        and not bare_month_end
        and not historical_inventory
    )
    if (bare_month_end and not historical_inventory) or current_inventory or bare_inventory:
        selected.add("inventory-current-snapshot")

    if historical_inventory:
        inventory_intent = {"state": "historical"}
        issues.append(
            _issue(
                "unsupported",
                "UNSUPPORTED_HISTORICAL_INVENTORY",
                "当前雅仓能力不支持指定历史日期或历史月末库存快照。",
            )
        )
    elif bare_month_end or current_inventory or bare_inventory:
        inventory_intent = {"state": "current"}
    else:
        inventory_intent = {"state": "omitted"}

    if any(marker in text for marker in _INBOUND_LISTING_MARKERS):
        selected.add("inbound-listing-time")

    vague_sales = (
        "最近卖得怎么样" in text or "最近销售情况" in text
    ) and "销量" not in text and not selected.intersection({"inventory-sales"}) and not issues
    if vague_sales:
        ambiguous_sales = True
    if "库存相关" in text:
        ambiguous_sales = True

    ordered = [data_type for data_type in ALL_DATA_TYPES if data_type in selected]
    unknown_terms = _find_unknown_business_terms(text)
    if unknown_terms:
        issues.append(
            {
                "kind": "unsupported",
                "code": "UNSUPPORTED_DATA_TYPE",
                "requested_value": {"business_terms": unknown_terms},
                "message": "请求的数据类型不在当前雅仓导出的三类支持范围内",
            }
        )
    if ambiguous_sales:
        questions.append(
            _question(
                "data_type",
                "AMBIGUOUS_SALES_TYPE",
                "请确认是否需要导出完整库存动销报表。",
            )
        )
        return {"state": "ambiguous"}, ordered, inventory_intent, issues
    if issues:
        return {"state": "unsupported"}, ordered, inventory_intent, issues
    if ordered:
        return {"state": "resolved", "values": ordered}, ordered, inventory_intent, issues
    return {"state": "omitted"}, [], inventory_intent, issues


def _requests_all_data(text: str) -> bool:
    if any(marker in text for marker in _ALL_DATA_MARKERS):
        return True
    if "都要" not in text:
        return False
    scoped_markers = ("销量", "库存", "入库", "上架", "仓库", "四仓", "两种")
    return not any(marker in text for marker in scoped_markers)


def _find_unknown_business_terms(text: str) -> list[str]:
    terms: list[str] = []
    for marker in _UNKNOWN_BUSINESS_MARKERS:
        if marker == "出库":
            matched = re.search(r"(?<!导)出库", text) is not None
        else:
            matched = marker in text
        if matched:
            terms.append(marker)
    return terms


def merge_and_resolve_intent(
    request_text: str,
    parsed: Mapping[str, Any],
    candidates: Mapping[str, dict[str, Any] | None],
    *,
    today: Callable[[], date] = date.today,
) -> dict[str, Any]:
    del request_text
    questions = [dict(item) for item in parsed["_questions"]]
    preflight_issues = [dict(item) for item in parsed["_preflight_issues"]]

    data_intent = _merge_selection_intent(
        "data_type",
        parsed["data_type_intent"],
        candidates["data_type_intent"],
        questions,
    )
    warehouse_intent = _merge_selection_intent(
        "warehouse",
        parsed["warehouse_intent"],
        candidates["warehouse_intent"],
        questions,
    )
    created_intent = _merge_created_intent(
        parsed["created_date_filter"],
        candidates["created_date_filter"],
        questions,
    )
    inventory_intent = _merge_inventory_intent(
        parsed["inventory_snapshot_intent"],
        candidates["inventory_snapshot_intent"],
        questions,
    )

    intent = {
        "data_type_intent": data_intent,
        "warehouse_intent": warehouse_intent,
        "created_date_filter": created_intent,
        "inventory_snapshot_intent": inventory_intent,
    }
    requires_clarification = any(
        dimension["state"] == "ambiguous"
        for dimension in (data_intent, warehouse_intent, created_intent, inventory_intent)
    ) or bool(questions)
    if requires_clarification:
        return {
            "intent": intent,
            "effective_request": None,
            "questions": _deduplicate_records(questions),
            "preflight_issues": _deduplicate_records(preflight_issues),
            "requires_clarification": True,
        }

    data_types = _effective_data_types(data_intent, parsed)
    warehouses = _effective_selection(warehouse_intent, WAREHOUSE_CODES)
    if data_types == ["inbound-listing-time"]:
        intent["warehouse_intent"] = {"state": "omitted"}
        warehouses = list(WAREHOUSE_CODES)
    sales_selected = "inventory-sales" in data_types
    inventory_selected = "inventory-current-snapshot" in data_types
    inbound_only = data_types == ["inbound-listing-time"]

    if created_intent["state"] != "omitted" and not sales_selected:
        if inbound_only:
            preflight_issues.append(
                _issue(
                    "unsupported",
                    "UNSUPPORTED_INBOUND_CREATED_DATE_FILTER",
                    "入库/上架时间是全局数据，不接受商品创建日期筛选。",
                )
            )
        else:
            preflight_issues.append(
                _issue(
                    "invalid",
                    "INVALID_CREATED_DATE_SCOPE",
                    "商品创建日期筛选只能用于销量任务。",
                )
            )
    if inventory_intent["state"] not in {"omitted", "historical"} and not inventory_selected:
        preflight_issues.append(
            _issue(
                "invalid",
                "INVALID_INVENTORY_INTENT_SCOPE",
                "库存快照意图只能用于库存任务。",
            )
        )
    effective_request: dict[str, Any] = {
        "data_types": data_types,
        "warehouses": warehouses,
    }
    if sales_selected:
        effective_request["created_date_filter"] = _effective_created_date_filter(
            created_intent,
            parsed,
            today=today,
        )

    return {
        "intent": intent,
        "effective_request": effective_request,
        "questions": [],
        "preflight_issues": _deduplicate_records(preflight_issues),
        "requires_clarification": False,
    }


def _merge_selection_intent(
    dimension: str,
    parsed: Mapping[str, Any],
    candidate: Mapping[str, Any] | None,
    questions: list[dict[str, str]],
) -> dict[str, Any]:
    if candidate is None or candidate["state"] == "omitted":
        return dict(parsed)
    if parsed["state"] == "omitted":
        return dict(candidate)
    if parsed["state"] in {"ambiguous", "unsupported"}:
        return dict(parsed)
    if candidate["state"] == "ambiguous":
        questions.append(
            _question(
                dimension,
                f"{dimension.upper()}_INTENT_CONFLICT",
                "Agent 候选与原始文本不能唯一对齐，请确认。",
            )
        )
        return {"state": "ambiguous"}
    if parsed.get("values") != candidate.get("values"):
        questions.append(
            _question(
                dimension,
                f"{dimension.upper()}_INTENT_CONFLICT",
                "Agent 候选与原始文本中的明确选择冲突，请确认。",
            )
        )
        return {"state": "ambiguous"}
    return dict(parsed)


def _merge_created_intent(
    parsed: Mapping[str, Any],
    candidate: Mapping[str, Any] | None,
    questions: list[dict[str, str]],
) -> dict[str, Any]:
    if candidate is None or candidate["state"] == "omitted":
        return dict(parsed)
    if candidate["state"] == "ambiguous":
        if parsed["state"] != "ambiguous":
            questions.append(
                _question(
                    "created_date",
                    "CREATED_DATE_INTENT_CONFLICT",
                    "Agent 日期候选与原始文本不能唯一对齐，请确认。",
                )
            )
        return {"state": "ambiguous"}
    if parsed["state"] == "ambiguous":
        return dict(parsed)
    if parsed["state"] == "omitted":
        if candidate.get("mode") == "default":
            return dict(candidate)
        questions.append(
            _question(
                "created_date",
                "CREATED_DATE_INTENT_CONFLICT",
                "原始文本没有足够的商品创建日期依据，不能采用 Agent 推算结果。",
            )
        )
        return {"state": "ambiguous"}
    comparable = {key: value for key, value in parsed.items() if key in {"state", "mode", "days"}}
    if comparable != dict(candidate):
        questions.append(
            _question(
                "created_date",
                "CREATED_DATE_INTENT_CONFLICT",
                "Agent 日期候选与原始文本中的明确日期语义冲突，请确认。",
            )
        )
        return {"state": "ambiguous"}
    return dict(parsed)


def _merge_inventory_intent(
    parsed: Mapping[str, Any],
    candidate: Mapping[str, Any] | None,
    questions: list[dict[str, str]],
) -> dict[str, Any]:
    if parsed["state"] == "historical":
        return dict(parsed)
    if candidate is None or candidate["state"] == "omitted":
        return dict(parsed)
    if parsed["state"] == "omitted":
        return dict(candidate)
    if parsed["state"] == "ambiguous" or candidate["state"] == "ambiguous":
        return {"state": "ambiguous"}
    if parsed["state"] != candidate["state"]:
        questions.append(
            _question(
                "inventory_snapshot",
                "INVENTORY_INTENT_CONFLICT",
                "Agent 库存时间候选与原始文本冲突，请确认。",
            )
        )
        return {"state": "ambiguous"}
    return dict(parsed)


def _effective_data_types(
    data_intent: Mapping[str, Any],
    parsed: Mapping[str, Any],
) -> list[str]:
    if data_intent["state"] == "omitted":
        return list(ALL_DATA_TYPES)
    if data_intent["state"] == "unsupported":
        return list(parsed["_supported_data_types"])
    return list(data_intent["values"])


def _effective_selection(intent: Mapping[str, Any], default: tuple[str, ...]) -> list[str]:
    if intent["state"] == "omitted":
        return list(default)
    return list(intent["values"])


def _effective_created_date_filter(
    intent: Mapping[str, Any],
    parsed: Mapping[str, Any],
    *,
    today: Callable[[], date],
) -> dict[str, Any]:
    if intent["state"] == "omitted" or intent.get("mode") == "default":
        start, end = resolve_source_date_range(today=today)
        return {
            "mode": "default",
            "created_start_date": start.isoformat(),
            "created_end_date": end.isoformat(),
            "source": "system_default",
            "input_fragments": [],
            "normalization_rules": ["default_execution_day"],
        }
    if intent["mode"] == "relative_days":
        end = today()
        start = end - timedelta(days=int(intent["days"]))
        fragment = (parsed.get("_created_effective") or {}).get("fragment")
        return {
            "mode": "relative_days",
            "created_start_date": start.isoformat(),
            "created_end_date": end.isoformat(),
            "source": "deterministic_relative_days",
            "input_fragments": [fragment] if fragment else [],
            "normalization_rules": ["relative_creation_days"],
        }
    raw = dict(parsed.get("_created_effective") or {})
    if not raw.get("created_start_date") and intent.get("start_date"):
        raw = {
            "created_start_date": intent["start_date"],
            "created_end_date": intent["end_date"],
            "input_fragments": [],
            "normalization_rules": ["ai_structured_explicit_range"],
        }
    return {
        "mode": "explicit_range",
        "created_start_date": raw["created_start_date"],
        "created_end_date": raw["created_end_date"],
        "source": "deterministic_explicit_range",
        "input_fragments": list(raw["input_fragments"]),
        "normalization_rules": list(raw["normalization_rules"]),
    }


def _question(dimension: str, code: str, message: str) -> dict[str, str]:
    return {"dimension": dimension, "code": code, "message": message}


def _issue(kind: str, code: str, message: str) -> dict[str, Any]:
    return {"kind": kind, "code": code, "message": message}


def _deduplicate_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[tuple[tuple[str, str], ...]] = set()
    for record in records:
        key = tuple(sorted((name, repr(value)) for name, value in record.items()))
        if key not in seen:
            seen.add(key)
            result.append(record)
    return result


__all__ = [
    "ALL_DATA_TYPES",
    "WAREHOUSE_CODES",
    "merge_and_resolve_intent",
    "normalize_structured_intent",
    "normalize_export_intent",
    "parse_request_text",
    "require_request_text",
    "validate_intent_candidates",
]
