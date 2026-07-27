from __future__ import annotations

import hashlib
import json
import os
import re
from io import BytesIO
from collections import OrderedDict, defaultdict
from copy import copy
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import unquote

from services.agent_cli.mabang import generate_fba_restock_workbook as restock_workbook
from services.agent_cli.mabang import generate_restock_workbook as purchase_summary
from services.agent_cli.mabang.erp_http import ErpHttpError, error_payload, request_json
from services.agent_cli.mabang.shipment_quantity_validation import read_delivery_msku_infos
from shared.datasets import dataset_dir


PURCHASE_CONFIRMATION_CODES = frozenset(
    {
        "purchase_inventory_confirmation_required",
        "purchase_inventory_quote_stale",
        "purchase_batch_replace_confirmation_required",
    }
)
FORMAL_QUANTITY_COLUMNS = ("计划发货量", "本次采购量", "留存库存抵扣量")
INVENTORY_ROW_FILL_COLOR = "FFFFFF00"
CONTRACT_OUTPUT_DIR = dataset_dir("fba_purchase_contracts")
_INVALID_FILE_NAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


class PurchaseBatchClientError(RuntimeError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        detail: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.detail = dict(detail or {})


def _decimal_text(value: Decimal) -> str:
    if value == value.to_integral_value():
        return str(int(value))
    return format(value.normalize(), "f").rstrip("0").rstrip(".")


def _decimal(value: Any) -> Decimal:
    if isinstance(value, bool) or value in (None, ""):
        raise InvalidOperation("missing decimal")
    result = Decimal(str(value))
    if not result.is_finite():
        raise InvalidOperation("non-finite decimal")
    return result


def _file_sha256(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _canonical_sha256(value: Mapping[str, Any]) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _require_text(value: Any, *, label: str) -> str:
    text = purchase_summary._clean_cell(value)
    if not text:
        raise PurchaseBatchClientError(
            "purchase_intent_invalid", f"正式 ERP 采购数据缺少{label}"
        )
    return text


def _product_for_sku(products: Any, stock_sku: str) -> dict[str, Any]:
    product = products.get(purchase_summary._sku_match_key(stock_sku))
    if product is None:
        raise PurchaseBatchClientError(
            "purchase_intent_unmatched_stock_sku",
            f"出口退税总表未找到库存 SKU: {stock_sku}",
        )
    return dict(product)


def _unit_components(csv_path: str | Path) -> list[dict[str, Any]]:
    infos = read_delivery_msku_infos(csv_path)
    mskus: list[dict[str, Any]] = []
    for raw_msku, info in infos.items():
        msku = _require_text(raw_msku, label="MSKU")
        denominator = info.msku_ship_quantity
        if denominator is None or denominator <= 0 or denominator != denominator.to_integral_value():
            raise PurchaseBatchClientError(
                "purchase_msku_unit_quantity_invalid",
                f"发货单 {Path(csv_path).name} 的 MSKU={msku} 缺少正整数 MSKU发货量",
            )
        components: list[dict[str, Any]] = []
        for stock_sku, source_quantity in info.components.items():
            if source_quantity <= 0:
                raise PurchaseBatchClientError(
                    "purchase_msku_unit_quantity_invalid",
                    f"发货单 {Path(csv_path).name} 的 MSKU={msku} 包含非正数 SKU 数量",
                )
            quantity_per_msku = source_quantity / denominator
            if quantity_per_msku != quantity_per_msku.to_integral_value():
                raise PurchaseBatchClientError(
                    "purchase_msku_unit_quantity_invalid",
                    f"发货单 {Path(csv_path).name} 的 MSKU={msku}, SKU={stock_sku} "
                    f"无法推导整数 quantity_per_msku: {source_quantity}/{denominator}",
                )
            components.append(
                {
                    "stock_sku": purchase_summary._clean_cell(stock_sku).upper(),
                    "quantity_per_msku": _decimal_text(quantity_per_msku),
                }
            )
        if not components:
            raise PurchaseBatchClientError(
                "purchase_msku_unit_quantity_invalid",
                f"发货单 {Path(csv_path).name} 的 MSKU={msku} 没有库存 SKU 组成",
            )
        mskus.append({"msku": msku.upper(), "components": components})
    return mskus


def build_purchase_intent(
    delivery_nos: list[str],
    *,
    master_xlsx: str | Path,
    csv_dir: str | Path | None = None,
    confirm_inventory_quote_id: str = "",
    replace_batch_id: str = "",
    expected_version_no: int | None = None,
    change_reason: str = "",
) -> tuple[dict[str, Any], dict[str, Any]]:
    _batch_summary, _batch_sources, normalized_delivery_nos, csv_paths = (
        purchase_summary.summarize_delivery_quantities(delivery_nos, csv_dir=csv_dir)
    )
    products = purchase_summary.load_master_products(master_xlsx)

    supplier_configs: OrderedDict[str, dict[str, Any]] = OrderedDict()
    contract_lines: OrderedDict[tuple[str, str], dict[str, Any]] = OrderedDict()
    sps: list[dict[str, Any]] = []
    csv_hashes: list[dict[str, str]] = []
    for sp_no, csv_path_text in zip(normalized_delivery_nos, csv_paths, strict=True):
        csv_path = Path(csv_path_text)
        delivery_summary = OrderedDict(
            (sku, quantity)
            for sku, quantity in purchase_summary.summarize_tax_sku_quantities_in_delivery_order(csv_path).items()
            if quantity > 0
        )
        country, _country_warnings = restock_workbook._delivery_country_metadata(csv_path)
        planned_lines: list[dict[str, Any]] = []
        for stock_sku, quantity in delivery_summary.items():
            product = _product_for_sku(products, stock_sku)
            manufacturer = _require_text(product.get("manufacturer"), label=f"厂家: SKU={stock_sku}")
            model = _require_text(product.get("model"), label=f"型号: SKU={stock_sku}")
            product_name = _require_text(
                product.get("product_name"), label=f"产品名称: SKU={stock_sku}"
            )
            unit, contract_product_name, contract_prefix, tax_rate = (
                purchase_summary._contract_fields_for_manufacturer(
                    products, manufacturer, collect_warnings=False
                )
            )
            unit = _require_text(unit, label=f"单位: 厂家={manufacturer}")
            contract_product_name = _require_text(
                contract_product_name, label=f"合同产品名称: 厂家={manufacturer}"
            )
            contract_prefix = _require_text(
                contract_prefix, label=f"合同编号前缀: 厂家={manufacturer}"
            ).upper()
            tax_rate = _require_text(tax_rate, label=f"税率: 厂家={manufacturer}")
            try:
                restock_workbook._tax_multiplier_from_rate(
                    tax_rate,
                    manufacturer=manufacturer,
                    model=model,
                )
            except RuntimeError as exc:
                raise PurchaseBatchClientError(
                    "purchase_intent_invalid", str(exc)
                ) from exc
            if not contract_prefix.isalnum() or len(contract_prefix) > 16:
                raise PurchaseBatchClientError(
                    "purchase_intent_invalid",
                    f"厂家={manufacturer} 的合同编号前缀必须是 1～16 位字母或数字",
                )
            existing_supplier = supplier_configs.get(manufacturer)
            supplier_config = {
                "name": manufacturer,
                "contract_prefix": contract_prefix,
                "tax_rate": tax_rate,
            }
            if existing_supplier is not None and existing_supplier != supplier_config:
                raise PurchaseBatchClientError(
                    "purchase_intent_invalid", f"厂家={manufacturer} 的合同配置不一致"
                )
            supplier_configs[manufacturer] = supplier_config
            normalized_sku = purchase_summary._clean_cell(stock_sku).upper()
            planned_lines.append(
                {
                    "stock_sku": normalized_sku,
                    "product_name": product_name,
                    "model": model,
                    "supplier_name": manufacturer,
                    "planned_shipment_quantity": _decimal_text(quantity),
                }
            )
            contract_key = (manufacturer, model.casefold())
            contract_line = contract_lines.get(contract_key)
            try:
                source_price = _decimal(product["original_price"])
            except (InvalidOperation, ValueError) as exc:
                raise PurchaseBatchClientError(
                    "purchase_intent_invalid",
                    f"正式 ERP 采购数据原价无法解析: SKU={stock_sku}, value={product.get('original_price')}",
                ) from exc
            if source_price < 0:
                raise PurchaseBatchClientError(
                    "purchase_intent_invalid",
                    f"正式 ERP 采购数据原价不能为负数: SKU={stock_sku}, value={source_price}",
                )
            if contract_line is None:
                contract_line = {
                    "supplier_name": manufacturer,
                    "tax_rate": tax_rate,
                    "line_ref": f"L{len(contract_lines) + 1:04d}",
                    "contract_product_name": contract_product_name,
                    "model": model,
                    "unit": unit,
                    "source_tax_unit_price": _decimal_text(source_price),
                    "planned_shipment_quantity": Decimal("0"),
                    "allocations": [],
                }
                contract_lines[contract_key] = contract_line
            elif (
                contract_line["source_tax_unit_price"] != _decimal_text(source_price)
                or contract_line["unit"] != unit
                or contract_line["contract_product_name"] != contract_product_name
            ):
                raise PurchaseBatchClientError(
                    "purchase_intent_invalid",
                    f"同一厂家型号的价格或合同字段不一致: 厂家={manufacturer}, 型号={model}",
                )
            contract_line["planned_shipment_quantity"] += quantity
            contract_line["allocations"].append(
                {
                    "sp_no": sp_no,
                    "stock_sku": normalized_sku,
                    "planned_quantity": _decimal_text(quantity),
                }
            )

        mskus = _unit_components(csv_path)
        planned_by_sku = {
            line["stock_sku"]: Decimal(line["planned_shipment_quantity"])
            for line in planned_lines
        }
        mapped_by_sku: defaultdict[str, Decimal] = defaultdict(lambda: Decimal("0"))
        infos = read_delivery_msku_infos(csv_path)
        for info in infos.values():
            for stock_sku, quantity in info.components.items():
                mapped_by_sku[purchase_summary._clean_cell(stock_sku).upper()] += quantity
        if dict(mapped_by_sku) != planned_by_sku:
            raise PurchaseBatchClientError(
                "purchase_msku_mapping_mismatch",
                f"发货单 {csv_path.name} 的 MSKU 组成数量与库存 SKU 计划量不一致: "
                f"planned={dict(planned_by_sku)}, mapped={dict(mapped_by_sku)}",
            )
        delivery_sha256 = _file_sha256(csv_path)
        csv_hashes.append({"sp_no": sp_no, "sha256": delivery_sha256})
        sps.append(
            {
                "sp_no": sp_no,
                "country": country,
                "delivery_file_name": csv_path.name,
                "delivery_sha256": delivery_sha256,
                "planned_lines": planned_lines,
                "mskus": mskus,
            }
        )

    contracts_by_supplier: OrderedDict[str, list[dict[str, Any]]] = OrderedDict()
    for line in contract_lines.values():
        serialized = dict(line)
        serialized.pop("supplier_name", None)
        serialized.pop("tax_rate", None)
        serialized["planned_shipment_quantity"] = _decimal_text(
            serialized["planned_shipment_quantity"]
        )
        contracts_by_supplier.setdefault(line["supplier_name"], []).append(serialized)
    contracts = [
        {
            "supplier_name": supplier,
            "tax_rate": supplier_configs[supplier]["tax_rate"],
            "lines": lines,
        }
        for supplier, lines in contracts_by_supplier.items()
    ]
    suppliers = [
        {"name": config["name"], "contract_prefix": config["contract_prefix"]}
        for config in supplier_configs.values()
    ]
    prefix_owners: dict[str, str] = {}
    for supplier in suppliers:
        previous = prefix_owners.setdefault(supplier["contract_prefix"], supplier["name"])
        if previous != supplier["name"]:
            raise PurchaseBatchClientError(
                "purchase_intent_invalid",
                f"供应商合同编号前缀重复: {supplier['contract_prefix']} ({previous}, {supplier['name']})",
            )

    intent: dict[str, Any] = {
        "created_by": "lxeskill:fba-purchase-summary-create",
        "suppliers": suppliers,
        "sps": sps,
        "contracts": contracts,
    }
    source_fingerprint = {
        "master_xlsx_sha256": _file_sha256(Path(master_xlsx).expanduser()),
        "delivery_csvs": csv_hashes,
        "intent": intent,
    }
    intent["source_sha256"] = _canonical_sha256(source_fingerprint)
    if replace_batch_id:
        intent["replace_batch_id"] = replace_batch_id
        intent["expected_version_no"] = expected_version_no
        intent["change_reason"] = change_reason
    if confirm_inventory_quote_id:
        intent["confirm_inventory_quote_id"] = confirm_inventory_quote_id
    request_basis = {
        key: value for key, value in intent.items() if key != "confirm_inventory_quote_id"
    }
    intent["request_id"] = f"purchase-{_canonical_sha256(request_basis)[:32]}"
    context = {
        "delivery_nos": normalized_delivery_nos,
        "csv_paths": csv_paths,
        "master_xlsx": str(Path(master_xlsx).expanduser()),
        "product_warnings": list(products.warnings),
    }
    return intent, context


def import_purchase_intent(payload: Mapping[str, Any]) -> tuple[int, dict[str, Any]]:
    return request_json(
        "POST",
        "/api/v1/erp/purchase-batches/import",
        operation="创建正式采购批次",
        json_payload=payload,
        accepted_error_codes=PURCHASE_CONFIRMATION_CODES,
    )


def _incomplete(message: str, *, field: str = "") -> PurchaseBatchClientError:
    detail = {"field": field} if field else None
    return PurchaseBatchClientError(
        "erp_purchase_result_incomplete",
        f"ERP 采购响应不完整或数量不守恒: {message}",
        detail=detail,
    )


def _required_result_text(
    value: Any,
    *,
    field: str,
) -> str:
    text = purchase_summary._clean_cell(value)
    if not text:
        raise _incomplete(f"缺少 {field}", field=field)
    return text


def _required_result_decimal(
    value: Any,
    *,
    field: str,
    positive: bool = False,
) -> Decimal:
    try:
        number = _decimal(value)
    except (InvalidOperation, ValueError) as exc:
        raise _incomplete(f"{field} 不是有限数字", field=field) from exc
    if number < 0 or (positive and number <= 0):
        qualifier = "正数" if positive else "非负数"
        raise _incomplete(f"{field} 必须是{qualifier}", field=field)
    return number


def _required_result_list(value: Any, *, field: str) -> list[Any]:
    if not isinstance(value, list):
        raise _incomplete(f"{field} 必须是数组", field=field)
    return value


def _expected_purchase_lines(
    request_payload: Mapping[str, Any],
) -> OrderedDict[str, dict[str, Any]]:
    expected: OrderedDict[str, dict[str, Any]] = OrderedDict()
    contracts = _required_result_list(request_payload.get("contracts"), field="request.contracts")
    for contract_index, raw_contract in enumerate(contracts):
        field = f"request.contracts[{contract_index}]"
        if not isinstance(raw_contract, Mapping):
            raise _incomplete(f"{field} 必须是对象", field=field)
        supplier_name = _required_result_text(
            raw_contract.get("supplier_name"), field=f"{field}.supplier_name"
        )
        lines = _required_result_list(raw_contract.get("lines"), field=f"{field}.lines")
        for line_index, raw_line in enumerate(lines):
            line_field = f"{field}.lines[{line_index}]"
            if not isinstance(raw_line, Mapping):
                raise _incomplete(f"{line_field} 必须是对象", field=line_field)
            line_ref = _required_result_text(raw_line.get("line_ref"), field=f"{line_field}.line_ref")
            if line_ref in expected:
                raise _incomplete(f"请求中 line_ref 重复: {line_ref}", field=f"{line_field}.line_ref")
            planned = _required_result_decimal(
                raw_line.get("planned_shipment_quantity"),
                field=f"{line_field}.planned_shipment_quantity",
                positive=True,
            )
            allocations = _required_result_list(
                raw_line.get("allocations"), field=f"{line_field}.allocations"
            )
            expected_allocations: defaultdict[tuple[str, str], Decimal] = defaultdict(
                lambda: Decimal("0")
            )
            for allocation_index, raw_allocation in enumerate(allocations):
                allocation_field = f"{line_field}.allocations[{allocation_index}]"
                if not isinstance(raw_allocation, Mapping):
                    raise _incomplete(
                        f"{allocation_field} 必须是对象", field=allocation_field
                    )
                sp_no = _required_result_text(
                    raw_allocation.get("sp_no"), field=f"{allocation_field}.sp_no"
                ).upper()
                stock_sku = _required_result_text(
                    raw_allocation.get("stock_sku"),
                    field=f"{allocation_field}.stock_sku",
                ).upper()
                quantity = _required_result_decimal(
                    raw_allocation.get("planned_quantity"),
                    field=f"{allocation_field}.planned_quantity",
                    positive=True,
                )
                expected_allocations[(sp_no, stock_sku)] += quantity
            if sum(expected_allocations.values(), Decimal("0")) != planned:
                raise _incomplete(
                    f"请求行 {line_ref} 的 SP/SKU 分配合计不等于计划量",
                    field=f"{line_field}.allocations",
                )
            expected[line_ref] = {
                "supplier_name": supplier_name,
                "model": _required_result_text(raw_line.get("model"), field=f"{line_field}.model"),
                "planned": planned,
                "allocations": dict(expected_allocations),
            }
    return expected


def _validate_allocation_details(
    raw_line: Mapping[str, Any],
    *,
    line_ref: str,
    expected: Mapping[str, Any],
    field_prefix: str,
) -> tuple[Decimal, Decimal]:
    details = _required_result_list(
        raw_line.get("allocation_details"), field=f"{field_prefix}.allocation_details"
    )
    actual_allocations: defaultdict[tuple[str, str], Decimal] = defaultdict(
        lambda: Decimal("0")
    )
    carryover_total = Decimal("0")
    purchase_total = Decimal("0")
    for detail_index, raw_detail in enumerate(details):
        detail_field = f"{field_prefix}.allocation_details[{detail_index}]"
        if not isinstance(raw_detail, Mapping):
            raise _incomplete(f"{detail_field} 必须是对象", field=detail_field)
        sp_no = _required_result_text(
            raw_detail.get("sp_no"), field=f"{detail_field}.sp_no"
        ).upper()
        stock_sku = _required_result_text(
            raw_detail.get("stock_sku"), field=f"{detail_field}.stock_sku"
        ).upper()
        source_kind = _required_result_text(
            raw_detail.get("source_kind"), field=f"{detail_field}.source_kind"
        )
        if source_kind not in {"carryover", "current_purchase"}:
            raise _incomplete(
                f"{detail_field}.source_kind 未知: {source_kind}",
                field=f"{detail_field}.source_kind",
            )
        quantity = _required_result_decimal(
            raw_detail.get("quantity"), field=f"{detail_field}.quantity", positive=True
        )
        actual_allocations[(sp_no, stock_sku)] += quantity
        if source_kind == "carryover":
            _required_result_text(
                raw_detail.get("carryover_entry_id"),
                field=f"{detail_field}.carryover_entry_id",
            )
            _required_result_text(
                raw_detail.get("source_contract_no"),
                field=f"{detail_field}.source_contract_no",
            )
            _required_result_decimal(
                raw_detail.get("historical_tax_unit_price"),
                field=f"{detail_field}.historical_tax_unit_price",
            )
            carryover_total += quantity
        else:
            purchase_total += quantity
    if dict(actual_allocations) != expected["allocations"]:
        raise _incomplete(
            f"行 {line_ref} 的 SP/SKU 来源分配不守恒: "
            f"expected={expected['allocations']}, actual={dict(actual_allocations)}",
            field=f"{field_prefix}.allocation_details",
        )
    return carryover_total, purchase_total


def _validate_quote(
    quote: Mapping[str, Any],
    *,
    request_payload: Mapping[str, Any],
    field_prefix: str,
) -> None:
    _required_result_text(quote.get("quote_id"), field=f"{field_prefix}.quote_id")
    _required_result_text(
        quote.get("intent_sha256"), field=f"{field_prefix}.intent_sha256"
    )
    _required_result_text(
        quote.get("inventory_sha256"), field=f"{field_prefix}.inventory_sha256"
    )
    expected_lines = _expected_purchase_lines(request_payload)
    raw_lines = _required_result_list(quote.get("lines"), field=f"{field_prefix}.lines")
    actual_refs: set[str] = set()
    planned_total = Decimal("0")
    carryover_total = Decimal("0")
    purchase_total = Decimal("0")
    for line_index, raw_line in enumerate(raw_lines):
        line_field = f"{field_prefix}.lines[{line_index}]"
        if not isinstance(raw_line, Mapping):
            raise _incomplete(f"{line_field} 必须是对象", field=line_field)
        line_ref = _required_result_text(raw_line.get("line_ref"), field=f"{line_field}.line_ref")
        if line_ref in actual_refs or line_ref not in expected_lines:
            raise _incomplete(f"报价行 line_ref 无法匹配或重复: {line_ref}", field=f"{line_field}.line_ref")
        actual_refs.add(line_ref)
        expected = expected_lines[line_ref]
        supplier_name = _required_result_text(
            raw_line.get("supplier_name"), field=f"{line_field}.supplier_name"
        )
        model = _required_result_text(raw_line.get("model"), field=f"{line_field}.model")
        for name in ("tax_rate", "contract_product_name", "unit"):
            _required_result_text(raw_line.get(name), field=f"{line_field}.{name}")
        _required_result_decimal(
            raw_line.get("source_tax_unit_price"),
            field=f"{line_field}.source_tax_unit_price",
        )
        if supplier_name != expected["supplier_name"] or model.casefold() != expected["model"].casefold():
            raise _incomplete(f"报价行 {line_ref} 的供应商或型号与请求不一致", field=line_field)
        planned = _required_result_decimal(
            raw_line.get("planned_shipment_quantity"),
            field=f"{line_field}.planned_shipment_quantity",
            positive=True,
        )
        carryover = _required_result_decimal(
            raw_line.get("carryover_applied_quantity"),
            field=f"{line_field}.carryover_applied_quantity",
        )
        purchased = _required_result_decimal(
            raw_line.get("purchase_quantity"), field=f"{line_field}.purchase_quantity"
        )
        if planned != expected["planned"] or planned != carryover + purchased:
            raise _incomplete(f"报价行 {line_ref} 不满足 计划量=采购量+库存抵扣量", field=line_field)
        detail_carryover, detail_purchase = _validate_allocation_details(
            raw_line,
            line_ref=line_ref,
            expected=expected,
            field_prefix=line_field,
        )
        if detail_carryover != carryover or detail_purchase != purchased:
            raise _incomplete(f"报价行 {line_ref} 的来源分配与采购/抵扣量不一致", field=line_field)
        inventory_sources = _required_result_list(
            raw_line.get("inventory_sources"), field=f"{line_field}.inventory_sources"
        )
        suggested_total = Decimal("0")
        for source_index, raw_source in enumerate(inventory_sources):
            source_field = f"{line_field}.inventory_sources[{source_index}]"
            if not isinstance(raw_source, Mapping):
                raise _incomplete(f"{source_field} 必须是对象", field=source_field)
            _required_result_text(
                raw_source.get("carryover_entry_id"),
                field=f"{source_field}.carryover_entry_id",
            )
            _required_result_text(
                raw_source.get("source_contract_no"),
                field=f"{source_field}.source_contract_no",
            )
            _required_result_decimal(
                raw_source.get("historical_tax_unit_price"),
                field=f"{source_field}.historical_tax_unit_price",
            )
            available = _required_result_decimal(
                raw_source.get("available_quantity"),
                field=f"{source_field}.available_quantity",
            )
            suggested = _required_result_decimal(
                raw_source.get("suggested_applied_quantity"),
                field=f"{source_field}.suggested_applied_quantity",
            )
            if suggested > available:
                raise _incomplete(f"{source_field} 建议抵扣量超过可用量", field=source_field)
            suggested_total += suggested
        if suggested_total != carryover:
            raise _incomplete(f"报价行 {line_ref} 的库存来源建议抵扣合计不守恒", field=line_field)
        applications = _required_result_list(
            raw_line.get("applications"), field=f"{line_field}.applications"
        )
        application_total = Decimal("0")
        for application_index, raw_application in enumerate(applications):
            application_field = f"{line_field}.applications[{application_index}]"
            if not isinstance(raw_application, Mapping):
                raise _incomplete(
                    f"{application_field} 必须是对象", field=application_field
                )
            _required_result_text(
                raw_application.get("carryover_entry_id"),
                field=f"{application_field}.carryover_entry_id",
            )
            _required_result_text(
                raw_application.get("source_contract_no"),
                field=f"{application_field}.source_contract_no",
            )
            _required_result_decimal(
                raw_application.get("historical_tax_unit_price"),
                field=f"{application_field}.historical_tax_unit_price",
            )
            application_total += _required_result_decimal(
                raw_application.get("applied_quantity"),
                field=f"{application_field}.applied_quantity",
                positive=True,
            )
        if application_total != carryover:
            raise _incomplete(f"报价行 {line_ref} 的库存应用合计不守恒", field=line_field)
        planned_total += planned
        carryover_total += carryover
        purchase_total += purchased
    if actual_refs != set(expected_lines):
        raise _incomplete(
            f"报价行集合与请求不一致: missing={sorted(set(expected_lines) - actual_refs)}",
            field=f"{field_prefix}.lines",
        )
    top_planned = _required_result_decimal(
        quote.get("planned_shipment_quantity"),
        field=f"{field_prefix}.planned_shipment_quantity",
    )
    top_carryover = _required_result_decimal(
        quote.get("carryover_applied_quantity"),
        field=f"{field_prefix}.carryover_applied_quantity",
    )
    top_purchase = _required_result_decimal(
        quote.get("purchase_quantity"), field=f"{field_prefix}.purchase_quantity"
    )
    if (top_planned, top_carryover, top_purchase) != (
        planned_total,
        carryover_total,
        purchase_total,
    ) or top_planned != top_carryover + top_purchase:
        raise _incomplete("报价总量与明细不守恒", field=field_prefix)
    _required_result_list(
        quote.get("inventory_issues"), field=f"{field_prefix}.inventory_issues"
    )


def _validate_success_response(
    response: Mapping[str, Any],
    *,
    request_payload: Mapping[str, Any],
) -> None:
    for field in ("status", "batch_id", "batch_no", "revision_id"):
        _required_result_text(response.get(field), field=field)
    version_no = response.get("version_no")
    if isinstance(version_no, bool):
        raise _incomplete("version_no 必须是正整数", field="version_no")
    try:
        parsed_version = int(version_no)
    except (TypeError, ValueError) as exc:
        raise _incomplete("version_no 必须是正整数", field="version_no") from exc
    if parsed_version <= 0:
        raise _incomplete("version_no 必须是正整数", field="version_no")
    expected_sp_nos = [
        _required_result_text(item.get("sp_no"), field="request.sps[].sp_no")
        for item in _required_result_list(request_payload.get("sps"), field="request.sps")
        if isinstance(item, Mapping)
    ]
    raw_sp_nos = _required_result_list(response.get("sp_nos"), field="sp_nos")
    response_sp_nos = [_required_result_text(value, field="sp_nos[]") for value in raw_sp_nos]
    if response_sp_nos != expected_sp_nos:
        raise _incomplete("sp_nos 与请求顺序或内容不一致", field="sp_nos")

    expected_lines = _expected_purchase_lines(request_payload)
    raw_lines = _required_result_list(response.get("purchase_lines"), field="purchase_lines")
    actual_refs: set[str] = set()
    positive_suppliers: set[str] = set()
    for line_index, raw_line in enumerate(raw_lines):
        line_field = f"purchase_lines[{line_index}]"
        if not isinstance(raw_line, Mapping):
            raise _incomplete(f"{line_field} 必须是对象", field=line_field)
        line_ref = _required_result_text(raw_line.get("line_ref"), field=f"{line_field}.line_ref")
        if line_ref in actual_refs or line_ref not in expected_lines:
            raise _incomplete(f"成功响应 line_ref 无法匹配或重复: {line_ref}", field=f"{line_field}.line_ref")
        actual_refs.add(line_ref)
        expected = expected_lines[line_ref]
        supplier_name = _required_result_text(
            raw_line.get("supplier_name"), field=f"{line_field}.supplier_name"
        )
        model = _required_result_text(raw_line.get("model"), field=f"{line_field}.model")
        for name in ("tax_rate", "contract_product_name", "unit"):
            _required_result_text(raw_line.get(name), field=f"{line_field}.{name}")
        _required_result_decimal(
            raw_line.get("source_tax_unit_price"),
            field=f"{line_field}.source_tax_unit_price",
        )
        if supplier_name != expected["supplier_name"] or model.casefold() != expected["model"].casefold():
            raise _incomplete(f"成功响应行 {line_ref} 的供应商或型号与请求不一致", field=line_field)
        planned = _required_result_decimal(
            raw_line.get("planned_shipment_quantity"),
            field=f"{line_field}.planned_shipment_quantity",
            positive=True,
        )
        carryover = _required_result_decimal(
            raw_line.get("carryover_applied_quantity"),
            field=f"{line_field}.carryover_applied_quantity",
        )
        purchased = _required_result_decimal(
            raw_line.get("purchase_quantity"), field=f"{line_field}.purchase_quantity"
        )
        if planned != expected["planned"] or planned != carryover + purchased:
            raise _incomplete(f"成功响应行 {line_ref} 不满足 计划量=采购量+库存抵扣量", field=line_field)
        detail_carryover, detail_purchase = _validate_allocation_details(
            raw_line,
            line_ref=line_ref,
            expected=expected,
            field_prefix=line_field,
        )
        if detail_carryover != carryover or detail_purchase != purchased:
            raise _incomplete(f"成功响应行 {line_ref} 的来源分配与采购/抵扣量不一致", field=line_field)
        inventory_sources = _required_result_list(
            raw_line.get("inventory_sources"), field=f"{line_field}.inventory_sources"
        )
        suggested_total = Decimal("0")
        for source_index, raw_source in enumerate(inventory_sources):
            source_field = f"{line_field}.inventory_sources[{source_index}]"
            if not isinstance(raw_source, Mapping):
                raise _incomplete(f"{source_field} 必须是对象", field=source_field)
            _required_result_text(
                raw_source.get("carryover_entry_id"),
                field=f"{source_field}.carryover_entry_id",
            )
            _required_result_text(
                raw_source.get("source_contract_no"),
                field=f"{source_field}.source_contract_no",
            )
            _required_result_decimal(
                raw_source.get("historical_tax_unit_price"),
                field=f"{source_field}.historical_tax_unit_price",
            )
            available = _required_result_decimal(
                raw_source.get("available_quantity"),
                field=f"{source_field}.available_quantity",
            )
            suggested = _required_result_decimal(
                raw_source.get("suggested_applied_quantity"),
                field=f"{source_field}.suggested_applied_quantity",
            )
            if suggested > available:
                raise _incomplete(f"{source_field} 建议抵扣量超过可用量", field=source_field)
            suggested_total += suggested
        if suggested_total != carryover:
            raise _incomplete(f"成功响应行 {line_ref} 的库存来源合计不守恒", field=line_field)
        applications = _required_result_list(
            raw_line.get("applications"), field=f"{line_field}.applications"
        )
        application_total = Decimal("0")
        for application_index, raw_application in enumerate(applications):
            application_field = f"{line_field}.applications[{application_index}]"
            if not isinstance(raw_application, Mapping):
                raise _incomplete(
                    f"{application_field} 必须是对象", field=application_field
                )
            _required_result_text(
                raw_application.get("carryover_entry_id"),
                field=f"{application_field}.carryover_entry_id",
            )
            _required_result_text(
                raw_application.get("source_contract_no"),
                field=f"{application_field}.source_contract_no",
            )
            _required_result_decimal(
                raw_application.get("historical_tax_unit_price"),
                field=f"{application_field}.historical_tax_unit_price",
            )
            application_total += _required_result_decimal(
                raw_application.get("applied_quantity"),
                field=f"{application_field}.applied_quantity",
                positive=True,
            )
        if application_total != carryover:
            raise _incomplete(f"成功响应行 {line_ref} 的库存应用合计不守恒", field=line_field)
        if purchased > 0:
            positive_suppliers.add(supplier_name)
            _required_result_text(raw_line.get("contract_id"), field=f"{line_field}.contract_id")
            _required_result_text(raw_line.get("contract_no"), field=f"{line_field}.contract_no")
            _required_result_decimal(raw_line.get("tax_unit_price"), field=f"{line_field}.tax_unit_price")
    if actual_refs != set(expected_lines):
        raise _incomplete(
            f"成功响应采购行集合与请求不一致: missing={sorted(set(expected_lines) - actual_refs)}",
            field="purchase_lines",
        )

    contracts = _required_result_list(response.get("contracts"), field="contracts")
    contract_suppliers: set[str] = set()
    for contract_index, raw_contract in enumerate(contracts):
        field = f"contracts[{contract_index}]"
        if not isinstance(raw_contract, Mapping):
            raise _incomplete(f"{field} 必须是对象", field=field)
        _required_result_text(raw_contract.get("contract_id"), field=f"{field}.contract_id")
        supplier_name = _required_result_text(
            raw_contract.get("supplier_name"), field=f"{field}.supplier_name"
        )
        _required_result_text(raw_contract.get("contract_no"), field=f"{field}.contract_no")
        if supplier_name in contract_suppliers:
            raise _incomplete(f"供应商合同重复: {supplier_name}", field=field)
        contract_suppliers.add(supplier_name)
    if contract_suppliers != positive_suppliers:
        raise _incomplete(
            "contracts 与实际采购量大于零的供应商集合不一致", field="contracts"
        )


def validate_purchase_response(
    *,
    status_code: int,
    response: Mapping[str, Any],
    request_payload: Mapping[str, Any],
) -> None:
    if status_code < 400:
        _validate_success_response(response, request_payload=request_payload)
        return
    raw_error = response.get("error")
    raw_detail = response.get("detail")
    error = raw_error if isinstance(raw_error, Mapping) else raw_detail
    if not isinstance(error, Mapping):
        raise _incomplete("409 业务响应缺少 error/detail", field="error")
    code = _required_result_text(error.get("code"), field="error.code")
    _required_result_text(error.get("message"), field="error.message")
    if code == "purchase_inventory_confirmation_required":
        _validate_quote(response, request_payload=request_payload, field_prefix="quote")
    elif code == "purchase_inventory_quote_stale":
        latest_quote = response.get("latest_quote")
        if not isinstance(latest_quote, Mapping):
            raise _incomplete("报价过期响应缺少 latest_quote", field="latest_quote")
        _validate_quote(
            latest_quote,
            request_payload=request_payload,
            field_prefix="latest_quote",
        )
    elif code == "purchase_batch_replace_confirmation_required":
        conflicts = _required_result_list(error.get("conflicts"), field="error.conflicts")
        if not conflicts:
            raise _incomplete("批次替换确认响应没有冲突明细", field="error.conflicts")
        for index, raw_conflict in enumerate(conflicts):
            field = f"error.conflicts[{index}]"
            if not isinstance(raw_conflict, Mapping):
                raise _incomplete(f"{field} 必须是对象", field=field)
            for name in ("sp_no", "batch_id", "batch_no"):
                _required_result_text(raw_conflict.get(name), field=f"{field}.{name}")
            version = raw_conflict.get("version_no")
            if isinstance(version, bool) or not isinstance(version, int) or version <= 0:
                raise _incomplete(f"{field}.version_no 必须是正整数", field=f"{field}.version_no")
    else:
        raise _incomplete(f"未识别的确认响应错误码: {code}", field="error.code")


def confirmation_result(
    *,
    response: Mapping[str, Any],
    status_code: int,
    request_payload: Mapping[str, Any],
) -> dict[str, Any]:
    raw_detail = response.get("detail")
    raw_error = response.get("error")
    detail = dict(raw_detail) if isinstance(raw_detail, Mapping) else {}
    top_error = dict(raw_error) if isinstance(raw_error, Mapping) else {}
    fields = detail or top_error
    code = str(fields.get("code") or "purchase_confirmation_required")
    message = str(fields.get("message") or "ERP 要求用户确认后才能创建采购批次")
    return {
        "success": False,
        "status": str(response.get("status") or "confirmation_required"),
        "request_id": request_payload["request_id"],
        "source_sha256": request_payload["source_sha256"],
        "error": {
            "code": code,
            "message": message,
            "http_status": status_code,
            "detail": dict(response),
        },
        "erp": dict(response),
    }


def _renamed_path(path: Path, suffix: str) -> Path:
    target = path.with_name(f"{path.stem}{suffix}{path.suffix}")
    if target != path:
        path.replace(target)
    return target


def _rebuild_draft_quantity_sheet(worksheet: Any) -> None:
    old_columns = [purchase_summary._clean_cell(cell.value) for cell in worksheet[1]]
    if "数量" not in old_columns:
        return
    new_columns = _replace_quantity_header(old_columns)
    rebuilt: list[list[Any]] = []
    for row in worksheet.iter_rows(min_row=2, values_only=True):
        if purchase_summary._clean_cell(row[0] if row else "") == "合计":
            continue
        original = _row_dict(old_columns, row)
        try:
            planned = _decimal(original.get("数量"))
        except (InvalidOperation, ValueError) as exc:
            raise PurchaseBatchClientError(
                "draft_artifact_quantity_invalid",
                f"草稿工作簿数量无法解析: sheet={worksheet.title}, value={original.get('数量')}",
            ) from exc
        rebuilt.append(
            _formal_row_values(
                original,
                planned=planned,
                purchased=planned,
                carryover=Decimal("0"),
                columns=new_columns,
            )
        )
    title = worksheet.title
    workbook = worksheet.parent
    index = workbook.index(worksheet)
    workbook.remove(worksheet)
    target = workbook.create_sheet(title, index)
    purchase_summary._write_rows(target, tuple(new_columns), rebuilt, append_total=True)


def mark_draft_workbooks(result: dict[str, Any]) -> dict[str, Any]:
    from openpyxl import load_workbook
    from openpyxl.styles import Font, PatternFill

    paths = [Path(result["purchase_summary_xlsx"]), *(Path(item) for item in result["restock_xlsx_paths"])]
    updated: list[Path] = []
    for path in paths:
        workbook = load_workbook(path)
        for sheet_name in list(workbook.sheetnames):
            if sheet_name == purchase_summary.UNMATCHED_SHEET_NAME:
                continue
            _rebuild_draft_quantity_sheet(workbook[sheet_name])
        note = workbook.create_sheet("草稿-未同步ERP", 0)
        note["A1"] = "草稿：未同步 ERP，未占用库存，不含正式合同编号"
        note["A1"].font = Font(bold=True)
        note["A1"].fill = PatternFill(fill_type="solid", fgColor="FFFFC000")
        note.column_dimensions["A"].width = 72
        workbook.save(path)
        updated.append(_renamed_path(path, "-DRAFT"))

    result["purchase_summary_xlsx"] = str(updated[0])
    result["restock_xlsx_paths"] = [str(path) for path in updated[1:]]
    result["restock_outputs"] = [
        {"delivery_no": delivery_no, "output_xlsx": str(path)}
        for delivery_no, path in zip(result["delivery_nos"], updated[1:], strict=True)
    ]
    result["mode"] = "draft"
    result["erp_synced"] = False
    result["official_contract_numbers_created"] = False
    return result


def _line_map(erp_result: Mapping[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    raw_lines = erp_result.get("purchase_lines") or erp_result.get("lines") or []
    return {
        (
            purchase_summary._clean_cell(line.get("supplier_name")),
            purchase_summary._clean_cell(line.get("model")).casefold(),
        ): dict(line)
        for line in raw_lines
        if isinstance(line, Mapping)
    }


def _replace_quantity_header(columns: list[str]) -> list[str]:
    index = columns.index("数量")
    return [*columns[:index], *FORMAL_QUANTITY_COLUMNS, *columns[index + 1 :]]


def _row_dict(columns: list[str], values: list[Any] | tuple[Any, ...]) -> dict[str, Any]:
    return {
        column: values[index] if index < len(values) else ""
        for index, column in enumerate(columns)
    }


def _formal_row_values(
    original: Mapping[str, Any],
    *,
    planned: Decimal,
    purchased: Decimal,
    carryover: Decimal,
    columns: list[str],
) -> list[Any]:
    values = dict(original)
    values["计划发货量"] = purchase_summary._decimal_to_cell_value(planned)
    values["本次采购量"] = purchase_summary._decimal_to_cell_value(purchased)
    values["留存库存抵扣量"] = purchase_summary._decimal_to_cell_value(carryover)
    values.pop("数量", None)
    return [values.get(column, "") for column in columns]


def _sp_product_names(
    request_payload: Mapping[str, Any],
) -> dict[tuple[str, str], str]:
    names: dict[tuple[str, str], str] = {}
    for sp_index, raw_sp in enumerate(
        _required_result_list(request_payload.get("sps"), field="request.sps")
    ):
        field = f"request.sps[{sp_index}]"
        if not isinstance(raw_sp, Mapping):
            raise _incomplete(f"{field} 必须是对象", field=field)
        sp_no = _required_result_text(raw_sp.get("sp_no"), field=f"{field}.sp_no").upper()
        for line_index, raw_line in enumerate(
            _required_result_list(raw_sp.get("planned_lines"), field=f"{field}.planned_lines")
        ):
            line_field = f"{field}.planned_lines[{line_index}]"
            if not isinstance(raw_line, Mapping):
                raise _incomplete(f"{line_field} 必须是对象", field=line_field)
            stock_sku = _required_result_text(
                raw_line.get("stock_sku"), field=f"{line_field}.stock_sku"
            ).upper()
            product_name = _required_result_text(
                raw_line.get("product_name"), field=f"{line_field}.product_name"
            )
            key = (sp_no, stock_sku)
            previous = names.setdefault(key, product_name)
            if previous != product_name:
                raise _incomplete(
                    f"同一 SP/SKU 的产品名称不一致: {sp_no}/{stock_sku}",
                    field=line_field,
                )
    return names


def _set_stock_sku_fields(
    values: dict[str, Any],
    *,
    skus: Mapping[str, Decimal],
    sp_no: str,
    product_names: Mapping[tuple[str, str], str],
) -> None:
    if not skus:
        raise _incomplete(f"SP={sp_no} 的来源行没有库存 SKU", field="allocation_details")
    sku_lines: list[str] = []
    name_lines: list[str] = []
    for stock_sku, quantity in skus.items():
        normalized_sku = purchase_summary._clean_cell(stock_sku).upper()
        product_name = product_names.get((sp_no.upper(), normalized_sku))
        if not product_name:
            raise _incomplete(
                f"SP={sp_no}, SKU={normalized_sku} 缺少冻结产品名称",
                field="request.sps[].planned_lines[].product_name",
            )
        sku_lines.append(
            f"{normalized_sku} × {purchase_summary._decimal_to_cell_value(quantity)}"
        )
        name_lines.append(product_name)
    values["库存sku"] = "\n".join(sku_lines)
    values["产品名称"] = "\n".join(name_lines)
    values["库存sku（第一行）"] = next(iter(skus)).upper()
    values["产品名称（第一行）"] = name_lines[0]


def _rebuild_purchase_sheet(worksheet: Any, lines: Mapping[tuple[str, str], dict[str, Any]]) -> None:
    old_columns = [purchase_summary._clean_cell(cell.value) for cell in worksheet[1]]
    if "数量" not in old_columns:
        return
    old_rows = [list(row) for row in worksheet.iter_rows(min_row=2, values_only=True)]
    data_rows = [row for row in old_rows if purchase_summary._clean_cell(row[0] if row else "") != "合计"]
    new_columns = _replace_quantity_header(old_columns)
    rebuilt: list[list[Any]] = []
    for row in data_rows:
        original = _row_dict(old_columns, row)
        key = (
            purchase_summary._clean_cell(original.get("厂家")),
            purchase_summary._clean_cell(original.get("型号")).casefold(),
        )
        line = lines.get(key)
        if line is None:
            raise PurchaseBatchClientError(
                "erp_purchase_result_incomplete",
                f"ERP 结果缺少采购行: 厂家={key[0]}, 型号={original.get('型号')}",
            )
        planned = _decimal(line.get("planned_shipment_quantity"))
        purchased = _decimal(line.get("purchase_quantity"))
        carryover = _decimal(line.get("carryover_applied_quantity"))
        original_price = _decimal(original.get("原价"))
        original["总价"] = purchase_summary._decimal_to_cell_value(original_price * purchased)
        tax_unit_price = line.get("tax_unit_price")
        if tax_unit_price is not None and purchase_summary._is_zhengfei_manufacturer(key[0]):
            average = _decimal(tax_unit_price)
            original["均价"] = purchase_summary._decimal_to_cell_value(average)
            original["总价（均价）"] = purchase_summary._decimal_to_cell_value(average * purchased)
        elif purchased == 0:
            original["均价"] = ""
            original["总价（均价）"] = ""
        rebuilt.append(
            _formal_row_values(
                original,
                planned=planned,
                purchased=purchased,
                carryover=carryover,
                columns=new_columns,
            )
        )

    title = worksheet.title
    workbook = worksheet.parent
    index = workbook.index(worksheet)
    workbook.remove(worksheet)
    target = workbook.create_sheet(title, index)
    purchase_summary._write_rows(target, tuple(new_columns), rebuilt, append_total=True)


def _restock_source_rows(
    original: Mapping[str, Any],
    line: Mapping[str, Any],
    *,
    sp_no: str,
    columns: list[str],
    product_names: Mapping[tuple[str, str], str],
) -> tuple[list[list[Any]], list[list[Any]]]:
    current: list[list[Any]] = []
    inventory: list[list[Any]] = []
    details = [
        dict(item)
        for item in line.get("allocation_details") or []
        if isinstance(item, Mapping) and purchase_summary._clean_cell(item.get("sp_no")).upper() == sp_no.upper()
    ]
    current_skus: OrderedDict[str, Decimal] = OrderedDict()
    for item in details:
        if item.get("source_kind") != "current_purchase":
            continue
        sku = purchase_summary._clean_cell(item.get("stock_sku")).upper()
        current_skus[sku] = current_skus.get(sku, Decimal("0")) + _decimal(
            item.get("quantity")
        )
    current_quantity = sum(current_skus.values(), Decimal("0"))

    def apply_price_totals(
        values: dict[str, Any],
        *,
        quantity: Decimal,
        source_price: Decimal,
        average_price: Decimal | None,
    ) -> None:
        gross_margin = _decimal(values.get("毛利率"))
        manufacturer = purchase_summary._clean_cell(values.get("厂家"))
        model = purchase_summary._clean_cell(values.get("型号"))
        multiplier = restock_workbook._tax_multiplier_from_rate(
            line.get("tax_rate") or "",
            manufacturer=manufacturer,
            model=model,
        )
        sale_price = (source_price / multiplier / (Decimal("1") - gross_margin)).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )
        values["总价（原价）"] = purchase_summary._decimal_to_cell_value(
            source_price * quantity
        )
        values["售价"] = purchase_summary._decimal_to_cell_value(sale_price)
        values["总价（售价）"] = purchase_summary._decimal_to_cell_value(
            sale_price * quantity
        )
        if average_price is None:
            values["均价"] = ""
            values["总价（均价）"] = ""
            values["售价(均价)"] = ""
            values["总价（售价(均价)）"] = ""
            return
        average_sale_price = (
            average_price / multiplier / (Decimal("1") - gross_margin)
        ).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        values["均价"] = purchase_summary._decimal_to_cell_value(average_price)
        values["总价（均价）"] = purchase_summary._decimal_to_cell_value(
            average_price * quantity
        )
        values["售价(均价)"] = purchase_summary._decimal_to_cell_value(
            average_sale_price
        )
        values["总价（售价(均价)）"] = purchase_summary._decimal_to_cell_value(
            average_sale_price * quantity
        )

    if current_quantity > 0:
        values = dict(original)
        values["采购订单号"] = line.get("contract_no") or ""
        _set_stock_sku_fields(
            values,
            skus=current_skus,
            sp_no=sp_no,
            product_names=product_names,
        )
        original_price = _decimal(values.get("原价"))
        average_price: Decimal | None = None
        if line.get("tax_unit_price") is not None and purchase_summary._is_zhengfei_manufacturer(
            values.get("厂家")
        ):
            average_price = _decimal(line["tax_unit_price"])
        apply_price_totals(
            values,
            quantity=current_quantity,
            source_price=original_price,
            average_price=average_price,
        )
        current.append(
            _formal_row_values(
                values,
                planned=current_quantity,
                purchased=current_quantity,
                carryover=Decimal("0"),
                columns=columns,
            )
        )

    grouped: OrderedDict[tuple[str, str], dict[str, Any]] = OrderedDict()
    for detail in details:
        if detail.get("source_kind") != "carryover":
            continue
        contract_no = purchase_summary._clean_cell(detail.get("source_contract_no"))
        price = _decimal(detail.get("historical_tax_unit_price"))
        key = (contract_no, _decimal_text(price))
        bucket = grouped.setdefault(key, {"quantity": Decimal("0"), "skus": OrderedDict()})
        quantity = _decimal(detail.get("quantity"))
        bucket["quantity"] += quantity
        sku = purchase_summary._clean_cell(detail.get("stock_sku"))
        bucket["skus"][sku] = bucket["skus"].get(sku, Decimal("0")) + quantity
    for (contract_no, price_text), bucket in grouped.items():
        quantity = bucket["quantity"]
        price = Decimal(price_text)
        values = dict(original)
        values["采购订单号"] = contract_no
        values["原价"] = purchase_summary._decimal_to_cell_value(price)
        apply_price_totals(
            values,
            quantity=quantity,
            source_price=price,
            average_price=None,
        )
        if bucket["skus"]:
            _set_stock_sku_fields(
                values,
                skus=bucket["skus"],
                sp_no=sp_no,
                product_names=product_names,
            )
        inventory.append(
            _formal_row_values(
                values,
                planned=quantity,
                purchased=Decimal("0"),
                carryover=quantity,
                columns=columns,
            )
        )
    return current, inventory


def _rebuild_restock_sheet(
    worksheet: Any,
    lines: Mapping[tuple[str, str], dict[str, Any]],
    *,
    sp_no: str,
    product_names: Mapping[tuple[str, str], str],
) -> None:
    from openpyxl.styles import PatternFill

    old_columns = [purchase_summary._clean_cell(cell.value) for cell in worksheet[1]]
    if "数量" not in old_columns:
        return
    data_rows = [
        list(row)
        for row in worksheet.iter_rows(min_row=2, values_only=True)
        if purchase_summary._clean_cell(row[0] if row else "") != "合计"
    ]
    new_columns = _replace_quantity_header(old_columns)
    normal_rows: list[list[Any]] = []
    inventory_rows: list[list[Any]] = []
    for row in data_rows:
        original = _row_dict(old_columns, row)
        key = (
            purchase_summary._clean_cell(original.get("厂家")),
            purchase_summary._clean_cell(original.get("型号")).casefold(),
        )
        line = lines.get(key)
        if line is None:
            raise PurchaseBatchClientError(
                "erp_purchase_result_incomplete",
                f"ERP 结果缺少备货行: SP={sp_no}, 厂家={key[0]}, 型号={original.get('型号')}",
            )
        current, inventory = _restock_source_rows(
            original,
            line,
            sp_no=sp_no,
            columns=new_columns,
            product_names=product_names,
        )
        normal_rows.extend(current)
        inventory_rows.extend(inventory)

    title = worksheet.title
    workbook = worksheet.parent
    index = workbook.index(worksheet)
    workbook.remove(worksheet)
    target = workbook.create_sheet(title, index)
    all_rows = [*normal_rows, *inventory_rows]
    purchase_summary._write_rows(target, tuple(new_columns), all_rows, append_total=True)
    yellow = PatternFill(fill_type="solid", fgColor=INVENTORY_ROW_FILL_COLOR)
    first_inventory_row = 2 + len(normal_rows)
    for row_index in range(first_inventory_row, first_inventory_row + len(inventory_rows)):
        for cell in target[row_index]:
            cell.fill = copy(yellow)


def apply_formal_erp_result(
    result: dict[str, Any],
    erp_result: Mapping[str, Any],
    *,
    request_payload: Mapping[str, Any],
) -> dict[str, Any]:
    from openpyxl import load_workbook

    lines = _line_map(erp_result)
    if not lines:
        raise PurchaseBatchClientError(
            "erp_purchase_result_incomplete", "ERP 成功响应未返回 purchase_lines"
        )
    product_names = _sp_product_names(request_payload)
    purchase_path = Path(result["purchase_summary_xlsx"])
    workbook = load_workbook(purchase_path)
    for sheet_name in list(workbook.sheetnames):
        if sheet_name == purchase_summary.UNMATCHED_SHEET_NAME:
            continue
        _rebuild_purchase_sheet(workbook[sheet_name], lines)
    workbook.save(purchase_path)

    for output in result["restock_outputs"]:
        path = Path(output["output_xlsx"])
        workbook = load_workbook(path)
        _rebuild_restock_sheet(
            workbook[restock_workbook.RESTOCK_SHEET_NAME],
            lines,
            sp_no=output["delivery_no"],
            product_names=product_names,
        )
        workbook.save(path)
    result["mode"] = "formal"
    result["erp_synced"] = True
    result["erp"] = dict(erp_result)
    result["batch_id"] = erp_result.get("batch_id")
    result["batch_no"] = erp_result.get("batch_no")
    result["version_no"] = erp_result.get("version_no")
    result["contracts"] = list(erp_result.get("contracts") or [])
    result["purchase_lines"] = list(erp_result.get("purchase_lines") or [])
    return result


def _contract_download_filename(
    headers: Mapping[str, str],
    contract: Mapping[str, Any],
) -> str:
    content_disposition = next(
        (
            str(value)
            for key, value in headers.items()
            if str(key).casefold() == "content-disposition"
        ),
        "",
    )
    file_name = ""
    encoded_match = re.search(
        r"filename\*\s*=\s*(?:UTF-8'')?([^;]+)",
        content_disposition,
        flags=re.IGNORECASE,
    )
    if encoded_match:
        file_name = unquote(encoded_match.group(1).strip().strip('"'))
    if not file_name:
        plain_match = re.search(
            r"filename\s*=\s*(?:\"([^\"]+)\"|([^;]+))",
            content_disposition,
            flags=re.IGNORECASE,
        )
        if plain_match:
            file_name = (plain_match.group(1) or plain_match.group(2) or "").strip()
    if not file_name:
        file_name = (
            purchase_summary._clean_cell(contract.get("contract_no"))
            or purchase_summary._clean_cell(contract.get("contract_id"))
            or "ERP采购合同"
        )
    file_name = _INVALID_FILE_NAME_CHARS.sub("_", Path(file_name).name).strip(" .")
    if not file_name:
        file_name = "ERP采购合同"
    if not file_name.casefold().endswith(".xlsx"):
        file_name = f"{file_name}.xlsx"
    return file_name


def download_contract_workbooks(
    result: dict[str, Any],
    *,
    output_dir: str | Path | None = None,
) -> dict[str, Any]:
    from openpyxl import load_workbook
    from services.agent_cli.mabang.erp_http import request_bytes

    target_dir = Path(output_dir or CONTRACT_OUTPUT_DIR).expanduser()
    target_dir.mkdir(parents=True, exist_ok=True)
    resolved_dir = target_dir.resolve()
    outputs: list[dict[str, Any]] = []
    used_names: set[str] = set()
    contracts = _required_result_list(result.get("contracts"), field="contracts")
    for index, raw_contract in enumerate(contracts):
        field = f"contracts[{index}]"
        if not isinstance(raw_contract, Mapping):
            raise _incomplete(f"{field} 必须是对象", field=field)
        contract = dict(raw_contract)
        contract_id = _required_result_text(
            contract.get("contract_id"), field=f"{field}.contract_id"
        )
        _status, content, headers = request_bytes(
            "GET",
            f"/api/v1/erp/contracts/{contract_id}/download",
            operation=f"下载 ERP 正式合同 {contract.get('contract_no') or contract_id}",
        )
        try:
            workbook = load_workbook(BytesIO(content), read_only=True, data_only=False)
            workbook.close()
        except Exception as exc:  # noqa: BLE001 - preserve malformed server artifact context
            raise PurchaseBatchClientError(
                "erp_contract_download_invalid",
                f"ERP 返回的合同不是有效 xlsx: contract_id={contract_id}, error={exc}",
            ) from exc
        file_name = _contract_download_filename(headers, contract)
        if file_name.casefold() in used_names:
            stem = Path(file_name).stem
            file_name = f"{stem}-{contract_id[:8]}.xlsx"
        used_names.add(file_name.casefold())
        target = (resolved_dir / file_name).resolve()
        if target.parent != resolved_dir:
            raise PurchaseBatchClientError(
                "erp_contract_download_path_invalid",
                f"ERP 合同文件名超出输出目录: {file_name}",
            )
        temporary = target.with_name(f".{target.name}.{os.getpid()}.part")
        try:
            temporary.write_bytes(content)
            os.replace(temporary, target)
        finally:
            if temporary.exists():
                temporary.unlink()
        outputs.append(
            {
                "contract_id": contract_id,
                "supplier_name": contract.get("supplier_name"),
                "contract_no": contract.get("contract_no"),
                "output_xlsx": str(target),
            }
        )
    result["contract_outputs"] = outputs
    result["contract_xlsx_paths"] = [item["output_xlsx"] for item in outputs]
    return result


def client_error_payload(exc: PurchaseBatchClientError | ErpHttpError) -> dict[str, Any]:
    if isinstance(exc, ErpHttpError):
        return error_payload(exc)
    payload: dict[str, Any] = {"code": exc.code, "message": str(exc)}
    if exc.detail:
        payload["detail"] = exc.detail
    return payload


__all__ = [
    "PurchaseBatchClientError",
    "apply_formal_erp_result",
    "build_purchase_intent",
    "client_error_payload",
    "confirmation_result",
    "download_contract_workbooks",
    "import_purchase_intent",
    "mark_draft_workbooks",
    "validate_purchase_response",
]
