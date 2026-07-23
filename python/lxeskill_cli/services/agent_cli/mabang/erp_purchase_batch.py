from __future__ import annotations

import hashlib
import json
from collections import OrderedDict, defaultdict
from copy import copy
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Mapping

from services.agent_cli.mabang import generate_fba_restock_workbook as restock_workbook
from services.agent_cli.mabang import generate_restock_workbook as purchase_summary
from services.agent_cli.mabang.erp_http import ErpHttpError, error_payload, request_json
from services.agent_cli.mabang.shipment_quantity_validation import read_delivery_msku_infos


PURCHASE_CONFIRMATION_CODES = frozenset(
    {
        "purchase_inventory_confirmation_required",
        "purchase_inventory_quote_stale",
        "purchase_batch_replace_confirmation_required",
    }
)
FORMAL_QUANTITY_COLUMNS = ("计划发货量", "本次采购量", "留存库存抵扣量")
INVENTORY_ROW_FILL_COLOR = "FFFFFF00"


class PurchaseBatchClientError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _decimal_text(value: Decimal) -> str:
    if value == value.to_integral_value():
        return str(int(value))
    return format(value.normalize(), "f").rstrip("0").rstrip(".")


def _decimal(value: Any) -> Decimal:
    return Decimal(str(value or "0"))


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
            product_name = purchase_summary._clean_cell(product.get("product_name"))
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
            source_price = Decimal(str(product["original_price"]))
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


def mark_draft_workbooks(result: dict[str, Any]) -> dict[str, Any]:
    from openpyxl import load_workbook
    from openpyxl.styles import Font, PatternFill

    paths = [Path(result["purchase_summary_xlsx"]), *(Path(item) for item in result["restock_xlsx_paths"])]
    updated: list[Path] = []
    for path in paths:
        workbook = load_workbook(path)
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
) -> tuple[list[list[Any]], list[list[Any]]]:
    current: list[list[Any]] = []
    inventory: list[list[Any]] = []
    details = [
        dict(item)
        for item in line.get("allocation_details") or []
        if isinstance(item, Mapping) and purchase_summary._clean_cell(item.get("sp_no")).upper() == sp_no.upper()
    ]
    current_quantity = sum(
        (_decimal(item.get("quantity")) for item in details if item.get("source_kind") == "current_purchase"),
        Decimal("0"),
    )

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
            values["库存sku"] = "\n".join(
                f"{sku} × {purchase_summary._decimal_to_cell_value(sku_quantity)}"
                for sku, sku_quantity in bucket["skus"].items()
            )
            values["库存sku（第一行）"] = next(iter(bucket["skus"]))
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
        current, inventory = _restock_source_rows(original, line, sp_no=sp_no, columns=new_columns)
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


def apply_formal_erp_result(result: dict[str, Any], erp_result: Mapping[str, Any]) -> dict[str, Any]:
    from openpyxl import load_workbook

    lines = _line_map(erp_result)
    if not lines:
        raise PurchaseBatchClientError(
            "erp_purchase_result_incomplete", "ERP 成功响应未返回 purchase_lines"
        )
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


def client_error_payload(exc: PurchaseBatchClientError | ErpHttpError) -> dict[str, Any]:
    if isinstance(exc, ErpHttpError):
        return error_payload(exc)
    return {"code": exc.code, "message": str(exc)}


__all__ = [
    "PurchaseBatchClientError",
    "apply_formal_erp_result",
    "build_purchase_intent",
    "client_error_payload",
    "confirmation_result",
    "import_purchase_intent",
    "mark_draft_workbooks",
]
