from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from shared.config import config
from services.mabang.amazon.fba.replenishment_template import (
    DEFAULT_TEMPLATE_NAME,
    ReplenishmentTemplate,
    calculate_weighted_daily_sales,
    effective_params_for_msku,
    get_template,
    replenishment_days_from_template,
    sea_day_candidates_from_template,
    trend_group_from_template,
    validate_template,
)

DEFAULT_SALES_ANALYSIS_DIR = Path("artifacts") / "mabang_store_msku_analysis"
DEFAULT_ACTUAL_INVENTORY_DIR = Path("artifacts") / "mabang_store_msku_inventory"
DEFAULT_OUTPUT_DIR = Path("artifacts") / "mabang_store_msku_replenishment"
SOURCE = "mabang_store_msku_replenishment"
EXCEL_ROW_HEIGHT = 15
EXCEL_COLUMN_WIDTH = 15
SALES_REPORT_RE = re.compile(r"^(?P<source_time>\d{12})-(?P<store>.+)_sales_analysis\.xlsx$", re.IGNORECASE)
INVENTORY_REPORT_RE = re.compile(r"^(?P<source_time>\d{12})-(?P<store>.+)_actual_inventory\.xlsx$", re.IGNORECASE)
DETAIL_SHEET = "MSKU明细"
SUMMARY_SHEET = "链接备货汇总"
AIR_URGENT_SHEET = "空运（急发）"
AIR_SHEET = "空运"
SEA_SHEET = "海运"
NO_SHIP_SHEET = "暂不建议发货"
SAMPLE_INSUFFICIENT_SHEET = "样本不足"
INVENTORY_SHEETS = ("真实库存-组合sku", "真实库存-库存sku")
REPORT_SHEETS = (
    SUMMARY_SHEET,
    AIR_URGENT_SHEET,
    AIR_SHEET,
    SEA_SHEET,
    NO_SHIP_SHEET,
    SAMPLE_INSUFFICIENT_SHEET,
)
DETAIL_COLUMNS = (
    "MSKU",
    "父ASIN",
    "ASIN",
    "本地SKU",
    "商品链接",
    "SKU类型",
    "模板名称",
    "命中规则",
    "销量趋势",
    "趋势分组",
    "加权日销",
    "可销售天数",
    "FBA总库存",
    "真实库存数量",
    "单品重量(g)",
    "补货天数",
    "补货量",
    "海运天数",
    "海运建议量",
    "预计总重量kg",
    "决策原因",
    "子SKU",
)
SUMMARY_COLUMNS = (
    "父ASIN",
    "商品链接",
    "MSKU数",
    "总补货量",
    "空运（急发）补货量",
    "空运补货量",
    "海运建议量",
    "涉及运输方式",
    "最大加权日销",
    "合计加权日销",
    "最小可销售天数",
    "决策备注",
    "链接真实本地库存汇总",
)
INVENTORY_REQUIRED_COLUMNS = (
    "MSKU",
    "父ASIN",
    "ASIN",
    "本地SKU",
    "商品链接",
    "FBA总库存",
    "加权日销",
    "可销售天数",
    "真实库存数量",
    "子SKU",
)
SALES_REQUIRED_COLUMNS = (
    "MSKU",
    "父ASIN",
    "ASIN",
    "本地SKU",
    "7天销量",
    "14天销量",
    "30天销量",
    "销量趋势",
    "单品重量(g)(cm)",
)
TRANSPORT_ORDER = (AIR_URGENT_SHEET, AIR_SHEET, SEA_SHEET, NO_SHIP_SHEET, SAMPLE_INSUFFICIENT_SHEET)
TWO_DECIMAL_COLUMNS = {"加权日销", "可销售天数", "FBA总库存", "真实库存数量", "单品重量(g)", "预计总重量kg", "最大加权日销", "合计加权日销", "最小可销售天数", "链接真实本地库存汇总"}
INTEGER_COLUMNS = {"MSKU数", "总补货量", "空运（急发）补货量", "空运补货量", "海运建议量", "补货天数", "补货量", "海运天数"}
WEIGHT_RE = re.compile(r"[-+]?\d+(?:,\d{3})*(?:\.\d+)?|[-+]?\d+(?:\.\d+)?")
URL_RE = re.compile(r"https?://\S+", re.IGNORECASE)


class StoreMskuReplenishmentError(ValueError):
    pass


@dataclass(frozen=True)
class ReportFile:
    path: Path
    source_data_time: str
    source_datetime: datetime


@dataclass(frozen=True)
class MatchedReports:
    source_data_time: str
    sales_analysis_path: Path
    actual_inventory_path: Path


@dataclass(frozen=True)
class SalesDetail:
    trend: str
    weight_grams: float | None
    sales_7d: float
    sales_14d: float
    sales_30d: float


@dataclass(frozen=True)
class InventoryInputRow:
    msku: str
    parent_asin: str
    asin: str
    local_sku: str
    product_link: str
    sku_type: str
    weighted_daily_sales: float
    sales_days: float | None
    fba_total_inventory: float
    actual_inventory: float | None
    child_skus: str


@dataclass(frozen=True)
class ReplenishmentRow:
    msku: str
    parent_asin: str
    asin: str
    local_sku: str
    product_link: str
    sku_type: str
    template_name: str
    matched_rule: str
    sales_trend: str
    trend_group: str
    weighted_daily_sales: float
    sales_days: float | None
    fba_total_inventory: float
    actual_inventory: float | None
    weight_grams: float | None
    replenish_days: int | None
    replenish_quantity: int | None
    sea_days: int | None
    sea_quantity: int | None
    estimated_weight_kg: float | None
    decision_reason: str
    child_skus: str
    sheet_name: str

    def to_detail_payload(self) -> dict[str, Any]:
        return {
            "MSKU": self.msku,
            "父ASIN": self.parent_asin,
            "ASIN": self.asin,
            "本地SKU": self.local_sku,
            "商品链接": self.product_link,
            "SKU类型": self.sku_type,
            "模板名称": self.template_name,
            "命中规则": self.matched_rule,
            "销量趋势": self.sales_trend,
            "趋势分组": self.trend_group,
            "加权日销": _display_float(self.weighted_daily_sales),
            "可销售天数": _display_optional_float(self.sales_days),
            "FBA总库存": _display_float(self.fba_total_inventory),
            "真实库存数量": _display_optional_float(self.actual_inventory),
            "单品重量(g)": _display_optional_float(self.weight_grams),
            "补货天数": _display_optional_int(self.replenish_days),
            "补货量": _display_optional_int(self.replenish_quantity),
            "海运天数": _display_optional_int(self.sea_days),
            "海运建议量": _display_optional_int(self.sea_quantity),
            "预计总重量kg": _display_optional_float(self.estimated_weight_kg),
            "决策原因": self.decision_reason,
            "子SKU": self.child_skus,
        }


@dataclass(frozen=True)
class StoreMskuReplenishmentResult:
    store_name: str
    source_data_time: str
    sales_analysis_xlsx_path: str
    actual_inventory_xlsx_path: str
    template_name: str
    template_version: int
    row_count: int
    link_count: int
    air_urgent_count: int
    air_count: int
    sea_count: int
    no_ship_count: int
    sample_insufficient_count: int
    report_xlsx_path: str
    source: str = SOURCE

    def to_payload(self) -> dict[str, Any]:
        return {
            "success": True,
            "store_name": self.store_name,
            "source_data_time": self.source_data_time,
            "sales_analysis_xlsx_path": self.sales_analysis_xlsx_path,
            "actual_inventory_xlsx_path": self.actual_inventory_xlsx_path,
            "template_name": self.template_name,
            "template_version": self.template_version,
            "row_count": self.row_count,
            "link_count": self.link_count,
            "air_urgent_count": self.air_urgent_count,
            "air_count": self.air_count,
            "sea_count": self.sea_count,
            "no_ship_count": self.no_ship_count,
            "sample_insufficient_count": self.sample_insufficient_count,
            "report_xlsx_path": self.report_xlsx_path,
            "source": self.source,
        }


def _clean_text(value: Any) -> str:
    return str(value or "").strip()


def _safe_file_part(value: Any) -> str:
    text = _clean_text(value)
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", text)
    return text.strip("._-") or "store_msku"


def normalize_store_name(value: Any) -> str:
    store_name = _clean_text(value)
    if not store_name:
        raise ValueError("store_name 不能为空")
    return store_name


def _configured_path(name: str, default: Path) -> Path:
    configured = str(getattr(config, name, "") or "").strip()
    return Path(configured) if configured else default


def _sales_analysis_dir(input_dir: str | Path | None = None) -> Path:
    return Path(input_dir) if input_dir is not None else _configured_path(
        "MABANG_STORE_MSKU_ANALYSIS_OUTPUT_DIR",
        DEFAULT_SALES_ANALYSIS_DIR,
    )


def _actual_inventory_dir(input_dir: str | Path | None = None) -> Path:
    return Path(input_dir) if input_dir is not None else _configured_path(
        "MABANG_STORE_MSKU_INVENTORY_OUTPUT_DIR",
        DEFAULT_ACTUAL_INVENTORY_DIR,
    )


def _output_dir(output_dir: str | Path | None = None) -> Path:
    path = Path(output_dir) if output_dir is not None else _configured_path(
        "MABANG_STORE_MSKU_REPLENISHMENT_OUTPUT_DIR",
        DEFAULT_OUTPUT_DIR,
    )
    path.mkdir(parents=True, exist_ok=True)
    return path


def _number(value: Any) -> float:
    if value is None:
        return 0.0
    if isinstance(value, bool):
        return float(int(value))
    if isinstance(value, (int, float)):
        number = float(value)
        return 0.0 if math.isnan(number) else number
    text = _clean_text(value).replace(",", "")
    if not text or text.lower() == "nan":
        return 0.0
    try:
        number = float(text)
    except (TypeError, ValueError):
        return 0.0
    return 0.0 if math.isnan(number) else number


def _optional_number(value: Any) -> float | None:
    text = _clean_text(value)
    if not text:
        return None
    return _number(value)


def _display_float(value: float) -> float:
    return round(float(value), 2)


def _display_optional_float(value: float | None) -> float | str:
    if value is None:
        return ""
    return _display_float(value)


def _display_optional_int(value: int | None) -> int | str:
    return "" if value is None else int(value)


def _row_key(row: dict[str, Any] | InventoryInputRow) -> tuple[str, str, str, str]:
    if isinstance(row, InventoryInputRow):
        return (row.msku, row.parent_asin, row.asin, row.local_sku)
    return (
        _clean_text(row.get("MSKU")),
        _clean_text(row.get("父ASIN")),
        _clean_text(row.get("ASIN")),
        _clean_text(row.get("本地SKU")),
    )


def _extract_product_url(value: Any) -> str:
    match = URL_RE.search(_clean_text(value))
    if not match:
        return ""
    return match.group(0).rstrip("),，;；。")


def _product_url_prefix(value: Any, asin: Any) -> str:
    url = _extract_product_url(value)
    if not url:
        return ""

    clean_asin = _clean_text(asin)
    if clean_asin and clean_asin in url:
        prefix = url.split(clean_asin, 1)[0]
        if prefix:
            return prefix

    slash_index = url.rfind("/")
    if slash_index < 0:
        return ""
    return url[: slash_index + 1]


def _parse_report_file(path: Path, pattern: re.Pattern[str]) -> ReportFile | None:
    match = pattern.match(path.name)
    if not match:
        return None
    source_data_time = match.group("source_time")
    try:
        source_datetime = datetime.strptime(source_data_time, "%Y%m%d%H%M")
    except ValueError:
        return None
    return ReportFile(path=path, source_data_time=source_data_time, source_datetime=source_datetime)


def _find_report_files(directory: Path, pattern: re.Pattern[str], safe_store_name: str) -> list[ReportFile]:
    if not directory.is_dir():
        return []
    reports: list[ReportFile] = []
    for path in directory.glob(f"*-{safe_store_name}_*.xlsx"):
        parsed = _parse_report_file(path, pattern)
        if parsed is not None:
            reports.append(parsed)
    return reports


def find_matching_report_files(
    store_name: str,
    *,
    sales_analysis_dir: str | Path | None = None,
    actual_inventory_dir: str | Path | None = None,
) -> MatchedReports:
    clean_store_name = normalize_store_name(store_name)
    safe_store_name = _safe_file_part(clean_store_name)
    sales_reports = _find_report_files(_sales_analysis_dir(sales_analysis_dir), SALES_REPORT_RE, safe_store_name)
    inventory_reports = _find_report_files(_actual_inventory_dir(actual_inventory_dir), INVENTORY_REPORT_RE, safe_store_name)
    sales_by_time = {item.source_data_time: item for item in sales_reports}
    inventory_by_time = {item.source_data_time: item for item in inventory_reports}
    common_times = sorted(set(sales_by_time) & set(inventory_by_time), reverse=True)
    if not common_times:
        sales_times = ", ".join(sorted(sales_by_time, reverse=True)[:5]) or "无"
        inventory_times = ", ".join(sorted(inventory_by_time, reverse=True)[:5]) or "无"
        raise StoreMskuReplenishmentError(
            f"未找到同源时间的销量分析和真实库存报表: store={clean_store_name}, "
            f"sales_times={sales_times}, inventory_times={inventory_times}"
        )
    source_data_time = common_times[0]
    return MatchedReports(
        source_data_time=source_data_time,
        sales_analysis_path=sales_by_time[source_data_time].path,
        actual_inventory_path=inventory_by_time[source_data_time].path,
    )


def _headers_and_rows(xlsx_path: str | Path, sheet_name: str) -> tuple[list[str], list[dict[str, Any]]]:
    try:
        from openpyxl import load_workbook
    except Exception as exc:
        raise RuntimeError("缺少 openpyxl 依赖，无法读取xlsx") from exc

    source_path = Path(xlsx_path)
    if not source_path.is_file():
        raise FileNotFoundError(f"xlsx不存在: {source_path}")

    workbook = None
    try:
        workbook = load_workbook(source_path, read_only=True, data_only=True)
        if sheet_name not in workbook.sheetnames:
            raise StoreMskuReplenishmentError(f"xlsx缺少sheet: {sheet_name}, path={source_path}")
        worksheet = workbook[sheet_name]
        rows = worksheet.iter_rows(values_only=True)
        headers = [_clean_text(cell) for cell in list(next(rows, None) or [])]
        if not any(headers):
            raise StoreMskuReplenishmentError(f"xlsx表头为空: sheet={sheet_name}, path={source_path}")
        records: list[dict[str, Any]] = []
        for values in rows:
            row = dict(zip(headers, list(values or []), strict=False))
            if any(_clean_text(value) for value in row.values()):
                records.append(row)
    except StoreMskuReplenishmentError:
        raise
    except Exception as exc:
        raise RuntimeError(f"读取xlsx失败: {source_path}, sheet={sheet_name}, error={exc}") from exc
    finally:
        try:
            if workbook is not None:
                workbook.close()
        except Exception:
            pass
    return headers, records


def _require_columns(headers: list[str], required_columns: tuple[str, ...], *, path: Path, sheet_name: str) -> None:
    missing = [column for column in required_columns if column not in headers]
    if missing:
        raise StoreMskuReplenishmentError(
            f"xlsx缺少列: {', '.join(missing)}, sheet={sheet_name}, path={path}"
        )


def load_inventory_rows(xlsx_path: str | Path) -> list[InventoryInputRow]:
    source_path = Path(xlsx_path)
    rows: list[InventoryInputRow] = []
    for sheet_name in INVENTORY_SHEETS:
        headers, records = _headers_and_rows(source_path, sheet_name)
        _require_columns(headers, INVENTORY_REQUIRED_COLUMNS, path=source_path, sheet_name=sheet_name)
        sku_type = "组合sku" if sheet_name == "真实库存-组合sku" else "库存sku"
        for record in records:
            rows.append(
                InventoryInputRow(
                    msku=_clean_text(record.get("MSKU")),
                    parent_asin=_clean_text(record.get("父ASIN")) or "未填写父ASIN",
                    asin=_clean_text(record.get("ASIN")),
                    local_sku=_clean_text(record.get("本地SKU")),
                    product_link=_clean_text(record.get("商品链接")),
                    sku_type=sku_type,
                    weighted_daily_sales=_number(record.get("加权日销")),
                    sales_days=_optional_number(record.get("可销售天数")),
                    fba_total_inventory=_number(record.get("FBA总库存")),
                    actual_inventory=_optional_number(record.get("真实库存数量")),
                    child_skus=_clean_text(record.get("子SKU")),
                )
            )
    return rows


def parse_weight_grams(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
        if not math.isnan(number) and number > 0:
            return number
    match = WEIGHT_RE.search(_clean_text(value))
    if not match:
        return None
    try:
        number = float(match.group(0).replace(",", ""))
    except ValueError:
        return None
    return number if number > 0 else None


def load_sales_details(xlsx_path: str | Path) -> dict[tuple[str, str, str, str], SalesDetail]:
    source_path = Path(xlsx_path)
    headers, records = _headers_and_rows(source_path, DETAIL_SHEET)
    _require_columns(headers, SALES_REQUIRED_COLUMNS, path=source_path, sheet_name=DETAIL_SHEET)
    details: dict[tuple[str, str, str, str], SalesDetail] = {}
    for record in records:
        key = _row_key(record)
        if key in details:
            raise StoreMskuReplenishmentError(
                f"销量分析MSKU明细存在重复行: MSKU={key[0]}, 父ASIN={key[1]}, ASIN={key[2]}, 本地SKU={key[3]}"
            )
        details[key] = SalesDetail(
            trend=_clean_text(record.get("销量趋势")),
            weight_grams=parse_weight_grams(record.get("单品重量(g)(cm)")),
            sales_7d=_number(record.get("7天销量")),
            sales_14d=_number(record.get("14天销量")),
            sales_30d=_number(record.get("30天销量")),
        )
    return details


def trend_group(trend: str) -> str | None:
    return trend_group_from_template(trend, get_template(DEFAULT_TEMPLATE_NAME))


def replenishment_days(weighted_daily_sales: float, mapped_trend: str) -> int:
    return replenishment_days_from_template(
        weighted_daily_sales,
        mapped_trend,
        get_template(DEFAULT_TEMPLATE_NAME).params,
    )


def _sea_day_candidates(weighted_daily_sales: float) -> list[int]:
    return sea_day_candidates_from_template(weighted_daily_sales, get_template(DEFAULT_TEMPLATE_NAME).params)


def calculate_replenishment_row(
    row: InventoryInputRow,
    sales_detail: SalesDetail,
    template: ReplenishmentTemplate | None = None,
) -> ReplenishmentRow:
    active_template = template or get_template(DEFAULT_TEMPLATE_NAME)
    params, matched_rule = effective_params_for_msku(active_template, row.msku)
    weighted_daily_sales = calculate_weighted_daily_sales(
        sales_7d=sales_detail.sales_7d,
        sales_14d=sales_detail.sales_14d,
        sales_30d=sales_detail.sales_30d,
        params=params,
    )
    sales_days = None if weighted_daily_sales <= 0 else row.fba_total_inventory / weighted_daily_sales
    rule_name = matched_rule or "默认规则"
    mapped_trend = trend_group_from_template(sales_detail.trend, active_template)
    if mapped_trend is None:
        return ReplenishmentRow(
            msku=row.msku,
            parent_asin=row.parent_asin,
            asin=row.asin,
            local_sku=row.local_sku,
            product_link=row.product_link,
            sku_type=row.sku_type,
            template_name=active_template.name,
            matched_rule=rule_name,
            sales_trend=sales_detail.trend,
            trend_group="样本不足",
            weighted_daily_sales=weighted_daily_sales,
            sales_days=sales_days,
            fba_total_inventory=row.fba_total_inventory,
            actual_inventory=row.actual_inventory,
            weight_grams=sales_detail.weight_grams,
            replenish_days=None,
            replenish_quantity=None,
            sea_days=None,
            sea_quantity=None,
            estimated_weight_kg=None,
            decision_reason="销量趋势为样本不足，不计算备货量",
            child_skus=row.child_skus,
            sheet_name=SAMPLE_INSUFFICIENT_SHEET,
        )

    replenish_day_count = replenishment_days_from_template(weighted_daily_sales, mapped_trend, params)
    replenish_quantity = math.ceil(weighted_daily_sales * replenish_day_count)
    base_kwargs = {
        "msku": row.msku,
        "parent_asin": row.parent_asin,
        "asin": row.asin,
        "local_sku": row.local_sku,
        "product_link": row.product_link,
        "sku_type": row.sku_type,
        "template_name": active_template.name,
        "matched_rule": rule_name,
        "sales_trend": sales_detail.trend,
        "trend_group": mapped_trend,
        "weighted_daily_sales": weighted_daily_sales,
        "sales_days": sales_days,
        "fba_total_inventory": row.fba_total_inventory,
        "actual_inventory": row.actual_inventory,
        "weight_grams": sales_detail.weight_grams,
        "replenish_days": replenish_day_count,
        "replenish_quantity": replenish_quantity,
        "child_skus": row.child_skus,
    }

    if sales_days is None:
        return ReplenishmentRow(
            **base_kwargs,
            sea_days=None,
            sea_quantity=None,
            estimated_weight_kg=None,
            decision_reason="可销售天数为空，暂不建议发货",
            sheet_name=NO_SHIP_SHEET,
        )
    air_urgent_days = float(params["shipping"]["air_urgent_sales_days_lte"])
    air_days = float(params["shipping"]["air_sales_days_lte"])
    if sales_days <= air_urgent_days:
        return ReplenishmentRow(
            **base_kwargs,
            sea_days=None,
            sea_quantity=None,
            estimated_weight_kg=None,
            decision_reason=f"可销售天数={sales_days:.2f} <= {air_urgent_days:g}，建议空运（急发）",
            sheet_name=AIR_URGENT_SHEET,
        )
    if sales_days <= air_days:
        return ReplenishmentRow(
            **base_kwargs,
            sea_days=None,
            sea_quantity=None,
            estimated_weight_kg=None,
            decision_reason=f"{air_urgent_days:g} < 可销售天数={sales_days:.2f} <= {air_days:g}，建议空运",
            sheet_name=AIR_SHEET,
        )

    min_daily_sales = float(params["sea"]["min_daily_sales"])
    if weighted_daily_sales <= min_daily_sales:
        return ReplenishmentRow(
            **base_kwargs,
            sea_days=None,
            sea_quantity=None,
            estimated_weight_kg=None,
            decision_reason=f"可销售天数={sales_days:.2f} > {air_days:g}，但加权日销={weighted_daily_sales:.2f} <= {min_daily_sales:g}，不建议海运",
            sheet_name=NO_SHIP_SHEET,
        )
    if sales_detail.weight_grams is None:
        return ReplenishmentRow(
            **base_kwargs,
            sea_days=None,
            sea_quantity=None,
            estimated_weight_kg=None,
            decision_reason=f"可销售天数 > {air_days:g} 且加权日销 > {min_daily_sales:g}，但缺少单品重量，暂不建议海运",
            sheet_name=NO_SHIP_SHEET,
        )

    tried: list[str] = []
    min_weight_kg = float(params["sea"]["min_weight_kg"])
    for sea_days in sea_day_candidates_from_template(weighted_daily_sales, params):
        sea_quantity = math.ceil(weighted_daily_sales * sea_days)
        estimated_weight_kg = sea_quantity * sales_detail.weight_grams / 1000
        tried.append(f"{sea_days}天: ceil({weighted_daily_sales:.2f}*{sea_days})={sea_quantity}, 重量={estimated_weight_kg:.2f}kg")
        if estimated_weight_kg > min_weight_kg:
            return ReplenishmentRow(
                **base_kwargs,
                sea_days=sea_days,
                sea_quantity=sea_quantity,
                estimated_weight_kg=estimated_weight_kg,
                decision_reason="可销售天数 > 70，满足海运条件；计算方法：" + "；".join(tried),
                sheet_name=SEA_SHEET,
            )

    return ReplenishmentRow(
        **base_kwargs,
        sea_days=None,
        sea_quantity=None,
        estimated_weight_kg=None,
        decision_reason=f"可销售天数 > {air_days:g}，但海运重量未超过{min_weight_kg:g}kg；计算方法：" + "；".join(tried),
        sheet_name=NO_SHIP_SHEET,
    )


def calculate_replenishment_rows(
    inventory_rows: list[InventoryInputRow],
    sales_details: dict[tuple[str, str, str, str], SalesDetail],
    template: ReplenishmentTemplate | None = None,
) -> list[ReplenishmentRow]:
    result: list[ReplenishmentRow] = []
    active_template = template or get_template(DEFAULT_TEMPLATE_NAME)
    for row in inventory_rows:
        key = _row_key(row)
        sales_detail = sales_details.get(key)
        if sales_detail is None:
            raise StoreMskuReplenishmentError(
                f"销量分析MSKU明细缺少匹配行: MSKU={key[0]}, 父ASIN={key[1]}, ASIN={key[2]}, 本地SKU={key[3]}"
            )
        result.append(calculate_replenishment_row(row, sales_detail, active_template))
    return result


def summarize_links(rows: list[ReplenishmentRow]) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for row in rows:
        group = groups.setdefault(
            row.parent_asin,
            {
                "父ASIN": row.parent_asin,
                "商品链接": "",
                "MSKU数": 0,
                "总补货量": 0,
                "空运（急发）补货量": 0,
                "空运补货量": 0,
                "海运建议量": 0,
                "涉及运输方式": set(),
                "最大加权日销": 0.0,
                "合计加权日销": 0.0,
                "最小可销售天数": None,
                "决策备注": [],
                "链接真实本地库存汇总": 0.0,
                "商品链接前缀": "",
                "_order": len(groups),
            },
        )
        group["MSKU数"] += 1
        link_prefix = _product_url_prefix(row.product_link, row.asin)
        if link_prefix and not group["商品链接前缀"]:
            group["商品链接前缀"] = link_prefix
            if row.parent_asin != "未填写父ASIN":
                group["商品链接"] = f"{link_prefix}{row.parent_asin}"
        if row.sheet_name == SAMPLE_INSUFFICIENT_SHEET:
            group["涉及运输方式"].add(SAMPLE_INSUFFICIENT_SHEET)
        else:
            group["总补货量"] += row.replenish_quantity or 0
            group["涉及运输方式"].add(row.sheet_name)
        if row.sheet_name == AIR_URGENT_SHEET:
            group["空运（急发）补货量"] += row.replenish_quantity or 0
        elif row.sheet_name == AIR_SHEET:
            group["空运补货量"] += row.replenish_quantity or 0
        elif row.sheet_name == SEA_SHEET:
            group["海运建议量"] += row.sea_quantity or 0
        group["最大加权日销"] = max(group["最大加权日销"], row.weighted_daily_sales)
        group["合计加权日销"] += row.weighted_daily_sales
        if row.sales_days is not None:
            current_min = group["最小可销售天数"]
            group["最小可销售天数"] = row.sales_days if current_min is None else min(current_min, row.sales_days)
        if row.actual_inventory is not None:
            group["链接真实本地库存汇总"] += row.actual_inventory
        if row.sheet_name in {SEA_SHEET, NO_SHIP_SHEET, SAMPLE_INSUFFICIENT_SHEET}:
            group["决策备注"].append(f"{row.msku}: {row.decision_reason}")

    summaries: list[dict[str, Any]] = []
    for group in groups.values():
        transport_values = [name for name in TRANSPORT_ORDER if name in group["涉及运输方式"]]
        summaries.append(
            {
                "父ASIN": group["父ASIN"],
                "商品链接": group["商品链接"],
                "MSKU数": group["MSKU数"],
                "总补货量": group["总补货量"],
                "空运（急发）补货量": group["空运（急发）补货量"],
                "空运补货量": group["空运补货量"],
                "海运建议量": group["海运建议量"],
                "涉及运输方式": "、".join(transport_values),
                "最大加权日销": _display_float(group["最大加权日销"]),
                "合计加权日销": _display_float(group["合计加权日销"]),
                "最小可销售天数": _display_optional_float(group["最小可销售天数"]),
                "决策备注": "；".join(group["决策备注"]),
                "链接真实本地库存汇总": _display_float(group["链接真实本地库存汇总"]),
            }
        )
    return sorted(summaries, key=lambda item: (-int(item["总补货量"]), groups[item["父ASIN"]]["_order"]))


def _write_table(worksheet: Any, headers: tuple[str, ...], rows: list[dict[str, Any]]) -> None:
    worksheet.append(list(headers))
    for row in rows:
        worksheet.append([row.get(header, "") for header in headers])
    worksheet.freeze_panes = "A2"
    if rows:
        worksheet.auto_filter.ref = worksheet.dimensions
    worksheet.sheet_format.defaultRowHeight = EXCEL_ROW_HEIGHT
    for row_index in range(1, worksheet.max_row + 1):
        worksheet.row_dimensions[row_index].height = EXCEL_ROW_HEIGHT
    for index, header in enumerate(headers, start=1):
        if header in TWO_DECIMAL_COLUMNS:
            for cells in worksheet.iter_rows(min_row=2, min_col=index, max_col=index):
                cells[0].number_format = "0.00"
        elif header in INTEGER_COLUMNS:
            for cells in worksheet.iter_rows(min_row=2, min_col=index, max_col=index):
                cells[0].number_format = "0"
    for column_cells in worksheet.columns:
        worksheet.column_dimensions[column_cells[0].column_letter].width = EXCEL_COLUMN_WIDTH


def write_replenishment_report(rows: list[ReplenishmentRow], report_path: str | Path) -> Path:
    try:
        from openpyxl import Workbook
    except Exception as exc:
        raise RuntimeError("缺少 openpyxl 依赖，无法写入备货计算报告") from exc

    target_path = Path(report_path)
    target_path.parent.mkdir(parents=True, exist_ok=True)
    sheet_rows = {
        AIR_URGENT_SHEET: [row for row in rows if row.sheet_name == AIR_URGENT_SHEET],
        AIR_SHEET: [row for row in rows if row.sheet_name == AIR_SHEET],
        SEA_SHEET: [row for row in rows if row.sheet_name == SEA_SHEET],
        NO_SHIP_SHEET: [row for row in rows if row.sheet_name == NO_SHIP_SHEET],
        SAMPLE_INSUFFICIENT_SHEET: [row for row in rows if row.sheet_name == SAMPLE_INSUFFICIENT_SHEET],
    }
    workbook = Workbook()
    try:
        specs: list[tuple[str, tuple[str, ...], list[dict[str, Any]]]] = [
            (SUMMARY_SHEET, SUMMARY_COLUMNS, summarize_links(rows)),
            *[
                (
                    sheet_name,
                    DETAIL_COLUMNS,
                    [row.to_detail_payload() for row in sorted(sheet_rows[sheet_name], key=_detail_sort_key)],
                )
                for sheet_name in (
                    AIR_URGENT_SHEET,
                    AIR_SHEET,
                    SEA_SHEET,
                    NO_SHIP_SHEET,
                    SAMPLE_INSUFFICIENT_SHEET,
                )
            ],
        ]
        for index, (sheet_name, headers, payload_rows) in enumerate(specs):
            worksheet = workbook.active if index == 0 else workbook.create_sheet()
            worksheet.title = sheet_name
            _write_table(worksheet, headers, payload_rows)
        workbook.save(target_path)
    finally:
        workbook.close()
    return target_path


def _detail_sort_key(row: ReplenishmentRow) -> tuple[int, str, str]:
    quantity = row.replenish_quantity or row.sea_quantity or 0
    return (-quantity, row.parent_asin, row.msku)


def calculate_store_msku_replenishment(
    store_name: str,
    *,
    template_name: str | None = None,
    sales_analysis_dir: str | Path | None = None,
    actual_inventory_dir: str | Path | None = None,
    output_dir: str | Path | None = None,
) -> StoreMskuReplenishmentResult:
    clean_store_name = normalize_store_name(store_name)
    template = validate_template(get_template(template_name or DEFAULT_TEMPLATE_NAME)).template
    reports = find_matching_report_files(
        clean_store_name,
        sales_analysis_dir=sales_analysis_dir,
        actual_inventory_dir=actual_inventory_dir,
    )
    inventory_rows = load_inventory_rows(reports.actual_inventory_path)
    sales_details = load_sales_details(reports.sales_analysis_path)
    replenishment_rows = calculate_replenishment_rows(inventory_rows, sales_details, template)
    report_path = _output_dir(output_dir) / f"{reports.source_data_time}-{_safe_file_part(clean_store_name)}_replenishment.xlsx"
    write_replenishment_report(replenishment_rows, report_path)
    summary_rows = summarize_links(replenishment_rows)

    return StoreMskuReplenishmentResult(
        store_name=clean_store_name,
        source_data_time=reports.source_data_time,
        sales_analysis_xlsx_path=str(reports.sales_analysis_path),
        actual_inventory_xlsx_path=str(reports.actual_inventory_path),
        template_name=template.name,
        template_version=template.version,
        row_count=len(replenishment_rows),
        link_count=len(summary_rows),
        air_urgent_count=sum(1 for row in replenishment_rows if row.sheet_name == AIR_URGENT_SHEET),
        air_count=sum(1 for row in replenishment_rows if row.sheet_name == AIR_SHEET),
        sea_count=sum(1 for row in replenishment_rows if row.sheet_name == SEA_SHEET),
        no_ship_count=sum(1 for row in replenishment_rows if row.sheet_name == NO_SHIP_SHEET),
        sample_insufficient_count=sum(1 for row in replenishment_rows if row.sheet_name == SAMPLE_INSUFFICIENT_SHEET),
        report_xlsx_path=str(report_path),
    )


__all__ = [
    "AIR_SHEET",
    "AIR_URGENT_SHEET",
    "DETAIL_COLUMNS",
    "NO_SHIP_SHEET",
    "REPORT_SHEETS",
    "SAMPLE_INSUFFICIENT_SHEET",
    "SEA_SHEET",
    "SOURCE",
    "SUMMARY_COLUMNS",
    "SUMMARY_SHEET",
    "InventoryInputRow",
    "ReplenishmentRow",
    "SalesDetail",
    "StoreMskuReplenishmentError",
    "StoreMskuReplenishmentResult",
    "calculate_replenishment_row",
    "calculate_replenishment_rows",
    "calculate_store_msku_replenishment",
    "find_matching_report_files",
    "load_inventory_rows",
    "load_sales_details",
    "normalize_store_name",
    "parse_weight_grams",
    "replenishment_days",
    "summarize_links",
    "trend_group",
    "write_replenishment_report",
]
