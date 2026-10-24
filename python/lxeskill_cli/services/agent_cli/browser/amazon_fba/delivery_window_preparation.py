"""Session-local dry-run evidence; never a source of browser truth or approval."""

from __future__ import annotations

import json
import os
import re
import uuid
from pathlib import Path
from typing import Any, Mapping, Sequence

MAX_RECEIPT_BYTES = 2 * 1024 * 1024
_ID = re.compile(r"^[0-9a-f]{32}$")


def validate_id(value: object) -> str:
    preparation_id = str(value or "").strip()
    if not _ID.fullmatch(preparation_id):
        raise ValueError("dry_run_id 必须是本会话成功 dry-run 返回的 32 位准备编号")
    return preparation_id


def signature(plan: Mapping[str, Any]) -> dict[str, Any]:
    return {key: plan[key] for key in (
        "store_id", "page_url", "shipment_ids", "target_date", "target_window", "target_handle"
    )}


def binding(observation: Mapping[str, Any]) -> dict[str, Any]:
    window = observation["current_window_read"]["window"]
    return {
        "store_id": observation["store_id"],
        "shipment_id": observation["shipment_id"],
        "window_handle": observation["window_handle"],
        "page_url": observation["page_url"],
        "workflow_id": observation["workflow_id"],
        "current_window": {key: window[key] for key in ("start_date", "end_date")},
        "deadline": observation["grace"]["deadline"],
    }


def create(
    output_dir: str | Path, plan: Mapping[str, Any], shipments: Sequence[Mapping[str, Any]],
    *, preparation_id: str | None = None,
) -> str:
    """Only the caller's fully successful, safely cancelled dry-run reaches here."""
    if plan["apply"] or not shipments or any(
        item["status"] not in {"dry_run_ready", "already_target"} for item in shipments
    ):
        raise ValueError("不能从未完成的 dry-run 创建准备证据")
    preparation_id = validate_id(preparation_id) if preparation_id else uuid.uuid4().hex
    receipt = {
        "version": 1, "dry_run_id": preparation_id, "plan": signature(plan),
        "shipments": {item["fba_shipment_id"]: binding(item["observations"][0]) for item in shipments},
    }
    serialized = json.dumps(receipt, ensure_ascii=False)
    if len(serialized.encode("utf-8")) > MAX_RECEIPT_BYTES:
        raise ValueError(f"dry-run 准备证据超过 {MAX_RECEIPT_BYTES} bytes")
    directory = Path(output_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"delivery-window-preparation-{preparation_id}.json"
    if path.exists():
        raise FileExistsError(f"dry-run 准备证据已存在：{path}")
    temporary = path.with_suffix(".tmp")
    with temporary.open("x", encoding="utf-8") as stream:
        stream.write(serialized)
        stream.flush()
        os.fsync(stream.fileno())
    # Readers only see complete evidence after its contents reach the disk.
    os.replace(temporary, path)
    return preparation_id


def load(output_dir: str | Path, plan: Mapping[str, Any]) -> dict[str, Any]:
    preparation_id = validate_id(plan.get("dry_run_id"))
    path = Path(output_dir) / f"delivery-window-preparation-{preparation_id}.json"
    with path.open("rb") as stream:
        raw = stream.read(MAX_RECEIPT_BYTES + 1)
    if len(raw) > MAX_RECEIPT_BYTES:
        raise ValueError(f"dry-run 准备证据超过 {MAX_RECEIPT_BYTES} bytes")
    receipt = json.loads(raw)
    if not isinstance(receipt, dict) or receipt.get("version") != 1 or receipt.get("dry_run_id") != preparation_id:
        raise ValueError("dry-run 准备证据结构或编号不匹配")
    if receipt.get("plan") != signature(plan):
        raise ValueError("店铺、页面、货件顺序或目标日期与 dry-run 不一致，需重新预演并核对")
    evidence = receipt.get("shipments")
    if not isinstance(evidence, dict) or set(evidence) != set(plan["shipment_ids"]):
        raise ValueError("dry-run 准备证据缺少目标货件")
    for shipment_id, item in evidence.items():
        if not isinstance(item, dict) or item.get("shipment_id") != shipment_id or item.get("store_id") != plan["store_id"]:
            raise ValueError("dry-run 准备证据的货件身份不一致")
        if not all(item.get(key) for key in ("window_handle", "page_url", "workflow_id", "deadline", "current_window")):
            raise ValueError("dry-run 准备证据的页面上下文不完整")
    if path.with_suffix(".claimed").exists():
        raise ValueError("此 dry-run 准备编号已执行过；提交结果未知时仅执行 action=readback")
    return receipt


def claim(output_dir: str | Path, preparation_id: str) -> None:
    """One attempt per preparation, including concurrent CLI calls and failures."""
    path = Path(output_dir) / f"delivery-window-preparation-{validate_id(preparation_id)}.claimed"
    with path.open("x", encoding="utf-8") as stream:
        stream.write("execution started; use readback for uncertain submission results\n")
        stream.flush()
        os.fsync(stream.fileno())
