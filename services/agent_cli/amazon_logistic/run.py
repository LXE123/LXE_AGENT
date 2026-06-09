from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any

from services.agent_cli._shared.json_output import configure_utf8_stdio
from services.amazon.amazon_logistic.artifacts.renderer import (
    build_multi_channel_pricing_markdown,
    build_single_channel_pricing_markdown,
)
from services.amazon.amazon_logistic.artifacts.store import save_artifacts
from services.amazon.amazon_logistic.input.validator import (
    VALID_SHIPMENT_PATTERN,
    normalize_consignment_no,
    normalize_shipment_no,
)
from services.amazon.amazon_logistic.remote_client import quote_pricing
from services.amazon.amazon_logistic.sources.consignment_excel import load_pricing_boxes_from_local_excel
from shared.infra.net import close_all_network_clients
from shared.runtime_core.utils import send_file_to_current_session

from . import defaults


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(str(message or "").strip() or "参数解析失败")


def _result(*, success: bool, message: str, exception: str = "") -> dict[str, str | bool]:
    return {
        "success": bool(success),
        "message": str(message or "").strip(),
        "exception": str(exception or "").strip(),
    }


def _exception_text(exc: Exception) -> str:
    message = str(exc or "").strip()
    return message or exc.__class__.__name__


def _resolve_agent_session_id() -> str:
    return str(os.environ.get("LXE_AGENT_SESSION_ID") or "").strip()


def _resolve_response_route_id() -> str:
    return str(os.environ.get("LXE_RESPONSE_ROUTE_ID") or "").strip()


def _configure_emit() -> None:
    return None


def _write_result(payload: dict[str, str | bool]) -> None:
    sys.stdout.write(json.dumps(dict(payload or {}), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(prog="python -m services.agent_cli.amazon_logistic.run")
    parser.add_argument("--input-text")
    parser.add_argument("--shipment-no")
    parser.add_argument("--consignment-no")
    parser.add_argument("--destination-address")
    return parser


def _normalize_destination_address(value: Any) -> str:
    return " ".join(str(value or "").split()).strip()


def _to_single_box_payload(box_record: dict[str, Any]) -> list[dict[str, str]]:
    return [
        {
            "gross_weight": str(box_record.get("gross_weight") or "").strip(),
            "length": str(box_record.get("length") or "").strip(),
            "width": str(box_record.get("width") or "").strip(),
            "height": str(box_record.get("height") or "").strip(),
        }
    ]


def _to_quote_boxes_payload(boxes_payload: list[dict[str, Any]]) -> list[dict[str, str]]:
    return [
        _to_single_box_payload(dict(item or {}))[0]
        for item in list(boxes_payload or [])
    ]


def _default_text(value: Any, fallback: str) -> str:
    return str(value or fallback).strip() or fallback


def _build_quote_payload(
    *,
    shipment_no: str,
    consignment_no: str,
    destination_address: str,
    boxes_payload: list[dict[str, Any]],
) -> dict[str, Any]:
    cargo_nature = _default_text(defaults.DEFAULT_CARGO_NATURE, "general").lower()
    return {
        "shipment_no": shipment_no,
        "consignment_no": consignment_no,
        "destination_address": destination_address,
        "transport_mode": _default_text(defaults.DEFAULT_TRANSPORT_MODE, "air").lower(),
        "cargo_nature": cargo_nature,
        "tax_included": _default_text(defaults.DEFAULT_TAX_INCLUDED, "any").lower(),
        "boxes": _to_quote_boxes_payload(boxes_payload),
        "top_n": 50,
        "allow_any_destination": True,
    }


async def _quote_single_shipment(
    *,
    shipment_no: str,
    consignment_no: str,
    destination_address: str,
    boxes_payload: list[dict[str, Any]],
) -> dict[str, Any]:
    response = await quote_pricing(
        _build_quote_payload(
            shipment_no=shipment_no,
            consignment_no=consignment_no,
            destination_address=destination_address,
            boxes_payload=boxes_payload,
        )
    )
    return {
        "shipment_no": shipment_no,
        "consignment_no": consignment_no,
        "destination_address": destination_address,
        "pricing_snapshots": list(response.get("pricing_snapshots") or []),
        "recommended": list(response.get("recommended") or []),
        "target_country": str(response.get("target_country") or "").strip(),
        "rejected_summary": dict(response.get("rejected_summary") or {}),
    }


def _parse_tsv_input(input_text: str) -> tuple[str, list[dict[str, str]]]:
    text = str(input_text or "")
    lines = [line for line in text.splitlines() if str(line or "").strip()]
    if not lines:
        raise ValueError("input_text 不能为空")

    consignment_scope = ""
    seen_shipments: set[str] = set()
    rows: list[dict[str, str]] = []
    for index, raw_line in enumerate(lines, start=1):
        parts = [part.strip() for part in str(raw_line or "").split("\t")]
        if len(parts) != 3:
            raise ValueError(f"第{index}行必须正好包含 3 列（Tab 分隔）")

        raw_consignment_no, raw_shipment_no, raw_destination_address = parts
        consignment_no = normalize_consignment_no(raw_consignment_no)
        if not consignment_no:
            raise ValueError(f"第{index}行 consignment_no 不能为空")

        shipment_no = normalize_shipment_no(raw_shipment_no)
        if not shipment_no:
            raise ValueError(f"第{index}行 shipment_no 不能为空")
        if not VALID_SHIPMENT_PATTERN.match(shipment_no):
            raise ValueError(f"第{index}行 shipment_no 无效: {raw_shipment_no}")

        destination_address = _normalize_destination_address(raw_destination_address)
        if not destination_address:
            raise ValueError(f"第{index}行 destination_address 不能为空")

        if not consignment_scope:
            consignment_scope = consignment_no
        elif consignment_no != consignment_scope:
            raise ValueError(
                f"第{index}行 consignment_no 与整批不一致: expected={consignment_scope}, actual={consignment_no}"
            )

        if shipment_no in seen_shipments:
            raise ValueError(f"第{index}行 shipment_no 重复: {shipment_no}")
        seen_shipments.add(shipment_no)

        rows.append(
            {
                "line_no": str(index),
                "consignment_no": consignment_no,
                "shipment_no": shipment_no,
                "destination_address": destination_address,
            }
        )

    return consignment_scope, rows


async def _run_single_mode(
    *,
    session_id: str,
    response_route_id: str,
    shipment_no: str,
    consignment_no: str,
    destination_address: str,
) -> dict[str, str | bool]:
    _, boxes_payload = load_pricing_boxes_from_local_excel(consignment_no)
    if len(boxes_payload) != 1:
        raise RuntimeError(
            f"装箱单 {consignment_no} 解析到 {len(boxes_payload)} 个箱子；"
            "单票模式只接受单箱装箱单，多箱请使用 TSV 多票模式"
        )
    quote_result = await _quote_single_shipment(
        shipment_no=shipment_no,
        consignment_no=consignment_no,
        destination_address=destination_address,
        boxes_payload=boxes_payload,
    )
    markdown = build_single_channel_pricing_markdown(
        list(quote_result.get("pricing_snapshots") or []),
        shipment_no=shipment_no,
        consignment_no=consignment_no,
        destination_address=destination_address,
        limit=50,
    )
    markdown_path = save_artifacts(
        markdown,
        f"{shipment_no}_{consignment_no}",
        "channel_pricing",
    )
    await send_file_to_current_session(
        session_id,
        markdown_path,
        response_route_id=response_route_id,
    )
    return _result(
        success=True,
        message="已完成计算流程，文件已发送。",
        exception="",
    )


async def _run_batch_mode(
    *,
    session_id: str,
    response_route_id: str,
    consignment_no: str,
    rows: list[dict[str, str]],
) -> dict[str, str | bool]:
    _, shared_boxes_payload = load_pricing_boxes_from_local_excel(consignment_no)
    if len(rows) != len(shared_boxes_payload):
        raise RuntimeError(
            f"输入货件数量与装箱文件箱子数量不一致: rows={len(rows)}, boxes={len(shared_boxes_payload)}"
        )

    shipment_results: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        line_no = int(str(row.get("line_no") or "0") or 0)
        shipment_no = str(row.get("shipment_no") or "").strip()
        destination_address = str(row.get("destination_address") or "").strip()
        mapped_box = dict(shared_boxes_payload[index] or {})
        try:
            result = await _quote_single_shipment(
                shipment_no=shipment_no,
                consignment_no=consignment_no,
                destination_address=destination_address,
                boxes_payload=_to_single_box_payload(mapped_box),
            )
        except Exception as exc:
            raise RuntimeError(f"第{line_no}行 ({shipment_no}) 失败: {_exception_text(exc)}") from exc
        shipment_results.append(result)

    markdown = build_multi_channel_pricing_markdown(
        shipment_results,
        consignment_no=consignment_no,
        limit=50,
    )
    markdown_path = save_artifacts(
        markdown,
        f"batch_{consignment_no}",
        "channel_pricing",
    )
    await send_file_to_current_session(
        session_id,
        markdown_path,
        response_route_id=response_route_id,
    )
    return _result(
        success=True,
        message="已完成计算流程，文件已发送。",
        exception="",
    )


async def _run_async(args: argparse.Namespace) -> dict[str, str | bool]:
    input_text = str(getattr(args, "input_text", "") or "")
    shipment_no = str(getattr(args, "shipment_no", "") or "").strip()
    consignment_no = str(getattr(args, "consignment_no", "") or "").strip()
    destination_address = str(getattr(args, "destination_address", "") or "").strip()

    has_input_text = bool(str(input_text).strip())
    has_single_args = bool(shipment_no or consignment_no or destination_address)
    if has_input_text and has_single_args:
        raise ValueError("input_text 模式不能同时传 shipment_no / consignment_no / destination_address")

    if has_input_text:
        parsed_consignment_no, parsed_rows = _parse_tsv_input(input_text)
        session_id = _resolve_agent_session_id()
        if not session_id:
            raise RuntimeError("缺少 LXE_AGENT_SESSION_ID")
        return await _run_batch_mode(
            session_id=session_id,
            response_route_id=_resolve_response_route_id(),
            consignment_no=parsed_consignment_no,
            rows=parsed_rows,
        )

    if not shipment_no:
        raise ValueError("shipment_no 参数不能为空")
    if not consignment_no:
        raise ValueError("consignment_no 参数不能为空")
    if not destination_address:
        raise ValueError("destination_address 参数不能为空")
    session_id = _resolve_agent_session_id()
    if not session_id:
        raise RuntimeError("缺少 LXE_AGENT_SESSION_ID")

    return await _run_single_mode(
        session_id=session_id,
        response_route_id=_resolve_response_route_id(),
        shipment_no=shipment_no,
        consignment_no=consignment_no,
        destination_address=destination_address,
    )


def main() -> int:
    configure_utf8_stdio()
    parser = build_parser()
    result: dict[str, str | bool]

    try:
        args = parser.parse_args()
        _configure_emit()
        result = asyncio.run(_run_async(args))
    except Exception as exc:
        result = _result(
            success=False,
            message="物流优选流程失败",
            exception=_exception_text(exc),
        )
    finally:
        try:
            asyncio.run(close_all_network_clients())
        except Exception:
            pass

    _write_result(result)
    return 0 if bool(result.get("success")) else 1


if __name__ == "__main__":
    raise SystemExit(main())
