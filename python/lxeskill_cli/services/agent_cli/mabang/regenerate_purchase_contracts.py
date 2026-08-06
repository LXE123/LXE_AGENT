from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import quote

from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.agent_cli.mabang import erp_http
from services.agent_cli.mabang import erp_purchase_batch
from services.agent_cli.mabang import fill_purchase_contracts as contract_workbook


SOURCE = "fba_purchase_contract_regeneration"
RESULT_SCHEMA = "lxe.fba.purchase-contract-regeneration-result.v1"


@dataclass(frozen=True)
class SavedContract:
    contract_id: str
    supplier_name: str
    contract_no: str
    contract_date: date
    tax_rate: str
    lines: list[contract_workbook.PurchaseContractLine]


def _error(
    code: str,
    message: str,
    *,
    detail: Mapping[str, Any] | None = None,
) -> erp_purchase_batch.PurchaseBatchClientError:
    return erp_purchase_batch.PurchaseBatchClientError(code, message, detail=detail)


def _mapping(value: Any, *, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise _error(
            "erp_purchase_batch_invalid",
            f"ERP 采购批次详情字段 `{field}` 必须是对象",
            detail={"field": field},
        )
    return value


def _list(value: Any, *, field: str) -> list[Any]:
    if not isinstance(value, list):
        raise _error(
            "erp_purchase_batch_invalid",
            f"ERP 采购批次详情字段 `{field}` 必须是数组",
            detail={"field": field},
        )
    return value


def _text(value: Any, *, field: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise _error(
            "erp_purchase_batch_invalid",
            f"ERP 采购批次详情缺少字段 `{field}`",
            detail={"field": field},
        )
    return text


def _positive_version(value: Any, *, field: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise _error(
            "erp_purchase_batch_invalid",
            f"ERP 采购批次详情字段 `{field}` 必须是正整数",
            detail={"field": field},
        )
    return value


def _decimal(value: Any, *, field: str) -> Decimal:
    if isinstance(value, bool) or value in (None, ""):
        raise _error(
            "erp_contract_detail_invalid",
            f"ERP 合同明细缺少数值字段 `{field}`",
            detail={"field": field},
        )
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise _error(
            "erp_contract_detail_invalid",
            f"ERP 合同明细字段 `{field}` 不是有效数字: {value}",
            detail={"field": field},
        ) from exc
    if not result.is_finite() or result < 0:
        raise _error(
            "erp_contract_detail_invalid",
            f"ERP 合同明细字段 `{field}` 必须是非负有限数字: {value}",
            detail={"field": field},
        )
    return result


def _current_revision(batch: Mapping[str, Any]) -> Mapping[str, Any]:
    revisions = [
        _mapping(item, field=f"revisions[{index}]")
        for index, item in enumerate(_list(batch.get("revisions"), field="revisions"))
    ]
    current = [revision for revision in revisions if str(revision.get("status") or "") == "current"]
    if not current:
        raise _error(
            "purchase_batch_not_current",
            "采购批次没有当前有效版本，不能重新生成正式合同",
        )
    if len(current) != 1:
        raise _error(
            "erp_purchase_batch_invalid",
            f"ERP 采购批次返回了 {len(current)} 个当前版本",
            detail={"field": "revisions.status"},
        )
    return current[0]


def _saved_contract(
    summary: Mapping[str, Any],
    detail: Mapping[str, Any],
    *,
    batch_id: str,
    batch_no: str,
    version_no: int,
    index: int,
) -> SavedContract:
    prefix = f"contracts[{index}]"
    contract_id = _text(summary.get("contract_id"), field=f"{prefix}.contract_id")
    supplier_name = _text(summary.get("supplier_name"), field=f"{prefix}.supplier_name")
    contract_no = _text(summary.get("contract_no"), field=f"{prefix}.contract_no")
    summary_status = _text(summary.get("status"), field=f"{prefix}.status")
    if summary_status != "current":
        raise _error(
            "erp_contract_detail_mismatch",
            f"ERP 当前采购版本包含非当前合同: {contract_no}",
            detail={
                "field": f"{prefix}.status",
                "expected": "current",
                "actual": summary_status,
                "contract_id": contract_id,
            },
        )
    expected = {
        "contract_id": contract_id,
        "supplier_name": supplier_name,
        "contract_no": contract_no,
        "batch_id": batch_id,
        "batch_no": batch_no,
        "version_no": version_no,
        "status": "current",
        "source_kind": "generated",
    }
    for field, expected_value in expected.items():
        raw_actual = detail.get(field)
        actual = raw_actual if field == "version_no" else str(raw_actual or "").strip()
        if field == "batch_no":
            matches = str(actual).upper() == str(expected_value).upper()
        else:
            matches = actual == expected_value
        if not matches:
            raise _error(
                "erp_contract_detail_mismatch",
                f"ERP 合同详情与采购批次不一致: `{field}`",
                detail={
                    "field": field,
                    "expected": expected_value,
                    "actual": actual,
                    "contract_id": contract_id,
                },
            )

    raw_contract_date = _text(detail.get("contract_date"), field=f"{prefix}.contract_date")
    try:
        contract_date = date.fromisoformat(raw_contract_date)
    except ValueError as exc:
        raise _error(
            "erp_contract_detail_invalid",
            f"ERP 合同日期无效: {raw_contract_date}",
            detail={"field": f"{prefix}.contract_date"},
        ) from exc
    tax_rate = _text(detail.get("tax_rate"), field=f"{prefix}.tax_rate")

    lines: list[contract_workbook.PurchaseContractLine] = []
    raw_lines = _list(detail.get("lines"), field=f"{prefix}.lines")
    for line_index, raw_line in enumerate(raw_lines):
        line = _mapping(raw_line, field=f"{prefix}.lines[{line_index}]")
        line_prefix = f"{prefix}.lines[{line_index}]"
        quantity = _decimal(
            line.get("purchase_quantity"),
            field=f"{line_prefix}.purchase_quantity",
        )
        if quantity == 0:
            continue
        unit_price = _decimal(
            line.get("tax_unit_price"),
            field=f"{line_prefix}.tax_unit_price",
        )
        lines.append(
            contract_workbook.PurchaseContractLine(
                manufacturer=supplier_name,
                product_name=_text(
                    line.get("contract_product_name"),
                    field=f"{line_prefix}.contract_product_name",
                ),
                model=_text(line.get("model"), field=f"{line_prefix}.model"),
                unit=_text(line.get("unit"), field=f"{line_prefix}.unit"),
                quantity=quantity,
                tax_unit_price=unit_price,
                tax_amount=quantity * unit_price,
                tax_rate=tax_rate,
            )
        )
    if not lines:
        raise _error(
            "erp_contract_detail_invalid",
            f"ERP 正式合同没有正数采购明细: {contract_no}",
            detail={"field": f"{prefix}.lines", "contract_id": contract_id},
        )
    return SavedContract(
        contract_id=contract_id,
        supplier_name=supplier_name,
        contract_no=contract_no,
        contract_date=contract_date,
        tax_rate=tax_rate,
        lines=lines,
    )


def _fetch_batch(batch_no: str) -> Mapping[str, Any]:
    _status, payload = erp_http.request_json(
        "GET",
        f"/api/v1/erp/purchase-batches/by-number/{quote(batch_no, safe='')}",
        operation=f"查询 ERP 采购批次 {batch_no}",
    )
    return _mapping(payload, field="batch")


def _fetch_contract(contract_id: str, *, contract_no: str) -> Mapping[str, Any]:
    _status, payload = erp_http.request_json(
        "GET",
        f"/api/v1/erp/contracts/{quote(contract_id, safe='')}",
        operation=f"查询 ERP 正式合同 {contract_no}",
    )
    return _mapping(payload, field="contract")


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    batch_no = str(arguments.get("batch_no") or "").strip().upper()
    template_path = Path(str(arguments.get("contract_template_xlsx") or "")).expanduser()
    output_files: list[dict[str, Any]] = []
    batch_id = ""
    version_no: int | None = None
    try:
        if not batch_no:
            raise _error("batch_no_required", "必须提供 ERP 采购批次号")
        batch = _fetch_batch(batch_no)
        batch_id = _text(batch.get("batch_id"), field="batch_id")
        returned_batch_no = _text(batch.get("batch_no"), field="batch_no")
        if returned_batch_no.upper() != batch_no:
            raise _error(
                "erp_purchase_batch_invalid",
                "ERP 返回的采购批次号与请求不一致",
                detail={"expected": batch_no, "actual": returned_batch_no},
            )
        batch_no = returned_batch_no
        revision = _current_revision(batch)
        revision_batch_id = _text(revision.get("batch_id"), field="revision.batch_id")
        if revision_batch_id != batch_id:
            raise _error(
                "erp_purchase_batch_invalid",
                "ERP 当前采购版本不属于请求的采购批次",
                detail={
                    "field": "revision.batch_id",
                    "expected": batch_id,
                    "actual": revision_batch_id,
                },
            )
        version_no = _positive_version(revision.get("version_no"), field="version_no")
        raw_contracts = _list(revision.get("contracts"), field="revisions.current.contracts")
        if not raw_contracts:
            raise _error(
                "purchase_batch_has_no_current_contracts",
                f"采购批次 {batch_no} 当前版本没有需要重新生成的正式合同",
            )

        saved_contracts: list[SavedContract] = []
        for index, raw_summary in enumerate(raw_contracts):
            summary = _mapping(raw_summary, field=f"contracts[{index}]")
            contract_id = _text(summary.get("contract_id"), field=f"contracts[{index}].contract_id")
            contract_no = _text(summary.get("contract_no"), field=f"contracts[{index}].contract_no")
            detail = _fetch_contract(contract_id, contract_no=contract_no)
            saved_contracts.append(
                _saved_contract(
                    summary,
                    detail,
                    batch_id=batch_id,
                    batch_no=batch_no,
                    version_no=version_no,
                    index=index,
                )
            )

        sheet_names = contract_workbook.validate_contract_template(
            template_path,
            [contract.supplier_name for contract in saved_contracts],
        )
        warnings: list[str] = []
        for contract in saved_contracts:
            try:
                output_xlsx = contract_workbook._save_single_company_contract(
                    template_xlsx=template_path,
                    output_dir=contract_workbook.OUTPUT_DIR,
                    manufacturer=contract.supplier_name,
                    sheet_name=sheet_names[contract.supplier_name],
                    lines=contract.lines,
                    contract_date=contract.contract_date,
                    warnings=warnings,
                    contract_number=contract.contract_no,
                    strict_layout=True,
                )
            except Exception as exc:
                raise contract_workbook.FormalContractGenerationError(
                    f"厂家 `{contract.supplier_name}` 正式合同重新生成失败: "
                    f"{_exception_text(exc)}",
                    output_files=output_files,
                ) from exc
            output_files.append(
                {
                    "contract_id": contract.contract_id,
                    "supplier_name": contract.supplier_name,
                    "contract_no": contract.contract_no,
                    "output_xlsx": output_xlsx,
                }
            )
        return {
            "success": True,
            "status": "completed",
            "mode": "regenerated",
            "result_schema": RESULT_SCHEMA,
            "batch_id": batch_id,
            "batch_no": batch_no,
            "version_no": version_no,
            "contract_template_xlsx": str(template_path),
            "generated_count": len(output_files),
            "contracts": output_files,
            "contract_xlsx_paths": [item["output_xlsx"] for item in output_files],
            "warnings": warnings,
            "source": SOURCE,
        }
    except (erp_purchase_batch.PurchaseBatchClientError, erp_http.ErpHttpError) as exc:
        return {
            "success": False,
            "batch_id": batch_id,
            "batch_no": batch_no,
            "version_no": version_no,
            "contract_template_xlsx": str(template_path),
            "exception": _exception_text(exc),
            "error": erp_purchase_batch.client_error_payload(exc),
            "source": SOURCE,
        }
    except Exception as exc:  # noqa: BLE001 - preserve the real render or filesystem error
        partial = getattr(exc, "output_files", output_files)
        partial_outputs = list(partial) if isinstance(partial, list) else output_files
        return {
            "success": False,
            "batch_id": batch_id,
            "batch_no": batch_no,
            "version_no": version_no,
            "contract_template_xlsx": str(template_path),
            "contracts": partial_outputs,
            "contract_xlsx_paths": [
                str(item.get("output_xlsx") or "")
                for item in partial_outputs
                if isinstance(item, Mapping) and item.get("output_xlsx")
            ],
            "exception": _exception_text(exc),
            "error": {
                "code": "purchase_contract_regeneration_failed",
                "message": _exception_text(exc),
            },
            "source": SOURCE,
        }


__all__ = ["RESULT_SCHEMA", "SOURCE", "SavedContract", "run"]
