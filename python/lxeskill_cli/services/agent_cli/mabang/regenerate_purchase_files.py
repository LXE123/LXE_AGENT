from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import quote

from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.agent_cli.mabang import erp_http
from services.agent_cli.mabang import erp_purchase_batch
from services.agent_cli.mabang import fill_purchase_contracts as contract_workbook
from services.agent_cli.mabang import generate_purchase_batch_workbooks as workbooks


SOURCE = "fba_purchase_files_regeneration"
RESULT_SCHEMA = "lxe.fba.purchase-files-regeneration-result.v1"
DEFAULT_GROSS_MARGIN = "0.3"


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
            "purchase_batch_artifact_snapshot_invalid",
            f"ERP 采购文件快照字段 `{field}` 必须是对象",
            detail={"field": field},
        )
    return value


def _list(value: Any, *, field: str) -> list[Any]:
    if not isinstance(value, list):
        raise _error(
            "purchase_batch_artifact_snapshot_invalid",
            f"ERP 采购文件快照字段 `{field}` 必须是数组",
            detail={"field": field},
        )
    return value


def _text(value: Any, *, field: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise _error(
            "purchase_batch_artifact_snapshot_invalid",
            f"ERP 采购文件快照缺少字段 `{field}`",
            detail={"field": field},
        )
    return text


def _positive_version(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        raise _error(
            "purchase_batch_artifact_snapshot_invalid",
            "ERP 采购文件快照版本号必须是正整数",
            detail={"field": "version_no"},
        )
    return value


def _business_date(snapshot: Mapping[str, Any]) -> date:
    raw = _text(snapshot.get("business_date"), field="business_date")
    try:
        return date.fromisoformat(raw)
    except ValueError as exc:
        raise _error(
            "purchase_batch_artifact_snapshot_invalid",
            f"ERP 采购文件快照业务日期无效: {raw}",
            detail={"field": "business_date"},
        ) from exc


def _fetch_snapshot(batch_no: str) -> Mapping[str, Any]:
    _status, payload = erp_http.request_json(
        "GET",
        (
            "/api/v1/erp/purchase-batches/by-number/"
            f"{quote(batch_no, safe='')}/artifact-snapshot"
        ),
        operation=f"查询 ERP 采购批次 {batch_no} 的文件快照",
    )
    return _mapping(payload, field="snapshot")


def _validate_snapshot_identity(
    snapshot: Mapping[str, Any],
    *,
    requested_batch_no: str,
) -> tuple[str, str, str, int, date, list[Mapping[str, Any]]]:
    if snapshot.get("snapshot_schema") != workbooks.ARTIFACT_SNAPSHOT_SCHEMA:
        raise _error(
            "purchase_batch_artifact_snapshot_invalid",
            "ERP 采购文件快照版本不受支持",
            detail={"snapshot_schema": snapshot.get("snapshot_schema")},
        )
    batch_id = _text(snapshot.get("batch_id"), field="batch_id")
    batch_no = _text(snapshot.get("batch_no"), field="batch_no")
    revision_id = _text(snapshot.get("revision_id"), field="revision_id")
    version_no = _positive_version(snapshot.get("version_no"))
    if batch_no.upper() != requested_batch_no:
        raise _error(
            "purchase_batch_artifact_snapshot_invalid",
            "ERP 采购文件快照批次号与请求不一致",
            detail={"expected": requested_batch_no, "actual": batch_no},
        )
    if str(snapshot.get("status") or "") != "current":
        raise _error(
            "purchase_batch_not_current",
            "采购批次没有当前有效版本，不能重新生成采购文件",
        )
    business_date = _business_date(snapshot)
    contracts: list[Mapping[str, Any]] = []
    for index, raw_contract in enumerate(
        _list(snapshot.get("contracts"), field="contracts")
    ):
        contract = _mapping(raw_contract, field=f"contracts[{index}]")
        contract_id = _text(
            contract.get("contract_id"),
            field=f"contracts[{index}].contract_id",
        )
        if str(contract.get("revision_id") or "") != revision_id:
            raise _error(
                "purchase_batch_artifact_snapshot_invalid",
                "ERP 正式合同不属于当前采购版本",
                detail={"contract_id": contract_id, "field": "revision_id"},
            )
        if contract.get("status") != "current" or contract.get("source_kind") != "generated":
            raise _error(
                "purchase_batch_artifact_snapshot_invalid",
                "ERP 采购文件快照包含非当前或非生成合同",
                detail={
                    "contract_id": contract_id,
                    "status": contract.get("status"),
                    "source_kind": contract.get("source_kind"),
                },
            )
        raw_contract_date = _text(
            contract.get("contract_date"),
            field=f"contracts[{index}].contract_date",
        )
        if raw_contract_date != business_date.isoformat():
            raise _error(
                "purchase_batch_artifact_snapshot_invalid",
                "ERP 正式合同日期与采购批次业务日期不一致",
                detail={
                    "contract_id": contract_id,
                    "expected": business_date.isoformat(),
                    "actual": raw_contract_date,
                },
            )
        contracts.append(contract)
    return batch_id, batch_no, revision_id, version_no, business_date, contracts


def _contract_outputs(
    contracts: list[Mapping[str, Any]],
    contract_result: Mapping[str, Any],
) -> tuple[list[dict[str, Any]], list[str]]:
    by_supplier = {
        str(item.get("supplier_name") or ""): item for item in contracts
    }
    outputs: list[dict[str, Any]] = []
    paths: list[str] = []
    for raw_output in list(contract_result.get("output_files") or []):
        if not isinstance(raw_output, Mapping):
            continue
        supplier_name = str(raw_output.get("manufacturer") or "")
        contract = by_supplier.get(supplier_name, {})
        output_xlsx = str(raw_output.get("output_xlsx") or "")
        outputs.append(
            {
                "contract_id": contract.get("contract_id"),
                "supplier_name": supplier_name,
                "contract_no": raw_output.get("contract_no"),
                "output_xlsx": output_xlsx,
            }
        )
        if output_xlsx:
            paths.append(output_xlsx)
    return outputs, paths


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    requested_batch_no = str(arguments.get("batch_no") or "").strip().upper()
    raw_gross_margin = arguments.get("gross_margin")
    gross_margin = (
        DEFAULT_GROSS_MARGIN
        if raw_gross_margin in (None, "")
        else str(raw_gross_margin).strip()
    )
    template_path = Path(
        str(arguments.get("contract_template_xlsx") or "")
    ).expanduser()
    batch_id = ""
    batch_no = requested_batch_no
    revision_id = ""
    version_no: int | None = None
    generated: dict[str, Any] | None = None
    formal: dict[str, Any] | None = None
    contract_result: dict[str, Any] | None = None
    try:
        if not requested_batch_no:
            raise _error("batch_no_required", "必须提供 ERP 采购批次号")
        snapshot = _fetch_snapshot(requested_batch_no)
        (
            batch_id,
            batch_no,
            revision_id,
            version_no,
            business_date,
            contracts,
        ) = _validate_snapshot_identity(
            snapshot,
            requested_batch_no=requested_batch_no,
        )
        if contracts:
            contract_workbook.validate_contract_template(
                template_path,
                [str(contract.get("supplier_name") or "") for contract in contracts],
            )
        generated, request_payload, erp_result = (
            workbooks.generate_purchase_batch_workbooks_from_snapshot(
                snapshot,
                gross_margin=gross_margin,
                today=business_date,
            )
        )
        formal, contract_result = workbooks.render_formal_purchase_artifacts(
            generated,
            erp_result,
            request_payload=request_payload,
            contract_template_xlsx=template_path,
            business_date=business_date,
        )
        contract_outputs, contract_paths = _contract_outputs(
            contracts,
            contract_result,
        )
        restock_paths = list(formal.get("restock_xlsx_paths") or [])
        warnings = [
            *list(formal.get("warnings") or []),
            *list(contract_result.get("warnings") or []),
        ]
        return {
            "success": True,
            "status": "completed",
            "mode": "regenerated",
            "result_schema": RESULT_SCHEMA,
            "batch_id": batch_id,
            "batch_no": batch_no,
            "revision_id": revision_id,
            "version_no": version_no,
            "business_date": business_date.isoformat(),
            "gross_margin": formal.get("gross_margin") or gross_margin,
            "contract_template_xlsx": str(template_path),
            "artifact_summary": {
                "delivery_count": len(list(formal.get("delivery_nos") or [])),
                "restock_count": len(restock_paths),
                "contract_count": len(contract_paths),
                "deliverable_file_count": 1 + len(restock_paths) + len(contract_paths),
            },
            "purchase_summary_xlsx": formal.get("purchase_summary_xlsx"),
            "restock_xlsx_paths": restock_paths,
            "contract_xlsx_paths": contract_paths,
            "contracts": contract_outputs,
            "warnings": warnings,
            "source": SOURCE,
        }
    except (erp_purchase_batch.PurchaseBatchClientError, erp_http.ErpHttpError) as exc:
        return {
            "success": False,
            "batch_id": batch_id,
            "batch_no": batch_no,
            "revision_id": revision_id,
            "version_no": version_no,
            "gross_margin": gross_margin,
            "contract_template_xlsx": str(template_path),
            "exception": _exception_text(exc),
            "error": erp_purchase_batch.client_error_payload(exc),
            "source": SOURCE,
        }
    except Exception as exc:  # noqa: BLE001 - preserve real render and filesystem errors
        attached_generated = getattr(exc, "generated_artifacts", None)
        if generated is None and isinstance(attached_generated, dict):
            generated = attached_generated
        attached_formal = getattr(exc, "formal_artifacts", None)
        if formal is None and isinstance(attached_formal, dict):
            formal = attached_formal
        partial_contracts = getattr(exc, "output_files", None)
        if not isinstance(partial_contracts, list):
            partial_contracts = list((contract_result or {}).get("output_files") or [])
        partial_contract_paths = [
            str(item.get("output_xlsx") or "")
            for item in partial_contracts
            if isinstance(item, Mapping) and item.get("output_xlsx")
        ]
        artifact_source = formal or generated or {}
        return {
            "success": False,
            "status": "artifact_regeneration_failed",
            "batch_id": batch_id,
            "batch_no": batch_no,
            "revision_id": revision_id,
            "version_no": version_no,
            "gross_margin": gross_margin,
            "contract_template_xlsx": str(template_path),
            "purchase_summary_xlsx": artifact_source.get("purchase_summary_xlsx"),
            "restock_xlsx_paths": list(
                artifact_source.get("restock_xlsx_paths") or []
            ),
            "contract_xlsx_paths": partial_contract_paths,
            "exception": _exception_text(exc),
            "error": {
                "code": "purchase_files_regeneration_failed",
                "message": _exception_text(exc),
            },
            "source": SOURCE,
        }


__all__ = ["DEFAULT_GROSS_MARGIN", "RESULT_SCHEMA", "SOURCE", "run"]
