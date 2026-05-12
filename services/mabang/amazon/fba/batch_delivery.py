from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from shared.config import config
from shared.infra.net import erp_http_session, external_http_session

from ...auth import get_fba_free_token
from ...errors import MabangAuthError, MabangBusinessError, MabangRequestError

DEFAULT_BATCH_DELIVERY_LIST_URL = (
    "https://api-private.mabangerp.com/fba/api/v1/shippBatchDelivery/getBatchDeliveryList"
)
DEFAULT_TASK_PUSH_URL = "https://api-private.mabangerp.com/fba/api/v1/taskreport/push"
DEFAULT_TASK_LIST_URL = "https://api-private.mabangerp.com/fba/api/v1/taskreport/list"
DEFAULT_TASK_DOWNLOAD_URL = "https://api-private.mabangerp.com/fba/api/v1/taskreport/download"
DEFAULT_ORIGIN = "https://amz1-private.mabangerp.com"
DEFAULT_REFERER = "https://amz1-private.mabangerp.com/"
DEFAULT_OUTPUT_DIR = Path("artifacts") / "mabang_fba_delivery"
SIMPLE_TASK_CONFIG_ID = "amz-fba-batch-delivery"
AUTH_FAIL_STATUS = {401, 403}
PENDING_TASK_STATUS_CODES = {0, 1}
PENDING_TASK_STATUS_TEXTS = {"待处理", "处理中", "处理中", "排队中", "生成中", "执行中"}
DONE_TASK_STATUS_TEXT = "处理完成"


class BatchDeliveryApiError(MabangBusinessError):
    pass


class BatchDeliveryApiAuthError(BatchDeliveryApiError, MabangAuthError):
    pass


class BatchDeliveryTimeoutError(BatchDeliveryApiError):
    pass


@dataclass(frozen=True)
class BatchDeliveryTask:
    task_id: int
    file_hash: str
    file_name: str
    task_status: int | None
    task_status_text: str
    raw: dict[str, Any]


@dataclass(frozen=True)
class BatchDeliveryDownloadInfo:
    task_id: int
    file_hash: str
    file_name: str
    download_url: str
    raw: dict[str, Any]


@dataclass(frozen=True)
class BatchDeliveryCsvResult:
    delivery_no: str
    delivery_id: int
    task_id: int
    file_hash: str
    file_name: str
    csv_path: str
    source: str = "mabang_fba_delivery"

    def to_payload(self) -> dict[str, Any]:
        return {
            "success": True,
            "delivery_no": self.delivery_no,
            "delivery_id": self.delivery_id,
            "task_id": self.task_id,
            "file_hash": self.file_hash,
            "file_name": self.file_name,
            "csv_path": self.csv_path,
            "source": self.source,
        }


def _configured_text(name: str, default: str) -> str:
    return str(getattr(config, name, default) or default).strip()


def _authorization_value(token: str) -> str:
    text = str(token or "").strip()
    if not text:
        return ""
    if text.lower().startswith("bearer "):
        return text
    return f"Bearer {text}"


def _request_headers(token: str, *, json_content: bool = True) -> dict[str, str]:
    headers = {
        "Authorization": _authorization_value(token),
        "Accept": "application/json, text/plain, */*",
        "ProjectId": "erp",
        "Origin": _configured_text("FBA_DELIVERY_API_ORIGIN", DEFAULT_ORIGIN),
        "Referer": _configured_text("FBA_DELIVERY_API_REFERER", DEFAULT_REFERER),
        "lang": "zh",
    }
    if json_content:
        headers["Content-Type"] = "application/json"
    return headers


def normalize_delivery_no(value: Any) -> str:
    return str(value or "").strip().upper()


def _require_delivery_no(value: Any) -> str:
    delivery_no = normalize_delivery_no(value)
    if not delivery_no:
        raise ValueError("delivery_no 不能为空")
    if not delivery_no.startswith("SP"):
        raise ValueError(f"delivery_no 格式无效: {delivery_no}")
    return delivery_no


def _int_value(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _today_text(report_date: str | date | None = None) -> str:
    if isinstance(report_date, date):
        return report_date.isoformat()
    text = str(report_date or "").strip()
    if text:
        return text
    return date.today().isoformat()


async def _read_api_json(resp: Any, *, action: str) -> dict[str, Any]:
    status_code = int(getattr(resp, "status", 0) or 0)
    text = await resp.text()

    if status_code in AUTH_FAIL_STATUS:
        raise BatchDeliveryApiAuthError(f"{action}鉴权失败(status={status_code})")
    if status_code >= 400:
        msg = text[:300] if text else "empty response"
        raise MabangRequestError(f"{action}请求失败(status={status_code}): {msg}")

    data: Any = None
    if text:
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            data = None
    if data is None:
        try:
            data = await resp.json(content_type=None)
        except Exception:
            data = None
    if not isinstance(data, dict):
        raise BatchDeliveryApiError(f"{action}返回非JSON对象")

    code = data.get("code")
    if str(code) != "200":
        msg = str(data.get("msg") or "unknown").strip()
        if str(code) in {"401", "403"}:
            raise BatchDeliveryApiAuthError(f"{action}鉴权失败(code={code}, msg={msg})")
        raise BatchDeliveryApiError(f"{action}业务异常(code={code}, msg={msg})")
    return data


def _delivery_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    data = payload.get("data")
    rows = data.get("data") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise BatchDeliveryApiError("发货单列表数据格式异常")
    return [row for row in rows if isinstance(row, dict)]


def _pick_delivery_row(payload: dict[str, Any], delivery_no: str) -> dict[str, Any]:
    target = normalize_delivery_no(delivery_no)
    matches = [
        row
        for row in _delivery_rows(payload)
        if normalize_delivery_no(row.get("delivery_no")) == target
    ]
    if not matches:
        raise BatchDeliveryApiError(f"未查询到FBA发货单: delivery_no={target}")
    if len(matches) > 1:
        raise BatchDeliveryApiError(f"查询到多个FBA发货单: delivery_no={target}, count={len(matches)}")
    return matches[0]


def extract_delivery_id(payload: dict[str, Any], delivery_no: str) -> int:
    row = _pick_delivery_row(payload, delivery_no)
    delivery_id = _int_value(row.get("id"))
    if not delivery_id or delivery_id <= 0:
        raise BatchDeliveryApiError(f"发货单缺少有效 id: delivery_no={normalize_delivery_no(delivery_no)}")
    return delivery_id


async def fetch_batch_delivery_list(delivery_no: str, *, token: str | None = None) -> dict[str, Any]:
    target = _require_delivery_no(delivery_no)
    active_token = str(token or "").strip() or await get_fba_free_token()
    api_url = _configured_text("FBA_DELIVERY_LIST_API_URL", DEFAULT_BATCH_DELIVERY_LIST_URL)
    payload = {
        "status": "0",
        "page": 1,
        "prePage": 20,
        "delivery_no": target,
    }
    async with erp_http_session.post(api_url, json=payload, headers=_request_headers(active_token)) as resp:
        return await _read_api_json(resp, action="查询FBA发货单")


async def create_delivery_export_task(
    delivery_id: int,
    *,
    token: str | None = None,
    report_date: str | date | None = None,
) -> int:
    normalized_id = int(delivery_id or 0)
    if normalized_id <= 0:
        raise ValueError("delivery_id 必须是正整数")

    active_token = str(token or "").strip() or await get_fba_free_token()
    date_text = _today_text(report_date)
    api_url = _configured_text("FBA_DELIVERY_TASK_PUSH_URL", DEFAULT_TASK_PUSH_URL)
    payload = {
        "reportEndDate": date_text,
        "reportStartDate": date_text,
        "simpleTaskConfigId": SIMPLE_TASK_CONFIG_ID,
        "reportParams": {
            "status": "0",
            "page": 1,
            "prePage": 20,
            "ids": [normalized_id],
            "export_type": "1",
            "currency_type": "1",
            "entry_type": "",
        },
    }
    async with erp_http_session.post(api_url, json=payload, headers=_request_headers(active_token)) as resp:
        response = await _read_api_json(resp, action="创建FBA发货单导出任务")

    data = response.get("data")
    task_id = _int_value(data.get("taskId") if isinstance(data, dict) else None)
    if not task_id or task_id <= 0:
        raise BatchDeliveryApiError("创建FBA发货单导出任务返回缺少 taskId")
    return task_id


def _task_list_params() -> list[tuple[str, str]]:
    return [
        ("page", "1"),
        ("perPage", "20"),
        ("searchContent", ""),
        ("timeType", "createTime"),
        ("taskType", "1"),
        ("taskStatus", ""),
        ("orderByField[]", "createTime"),
        ("orderByType[]", "desc"),
    ]


async def fetch_task_report_row(task_id: int, *, token: str | None = None) -> dict[str, Any] | None:
    normalized_task_id = int(task_id or 0)
    if normalized_task_id <= 0:
        raise ValueError("task_id 必须是正整数")

    active_token = str(token or "").strip() or await get_fba_free_token()
    api_url = _configured_text("FBA_DELIVERY_TASK_LIST_URL", DEFAULT_TASK_LIST_URL)
    async with erp_http_session.get(
        api_url,
        params=_task_list_params(),
        headers=_request_headers(active_token, json_content=False),
    ) as resp:
        response = await _read_api_json(resp, action="查询FBA发货单导出任务")

    data = response.get("data")
    rows = data.get("list") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise BatchDeliveryApiError("导出任务列表数据格式异常")
    for row in rows:
        if not isinstance(row, dict):
            continue
        if _int_value(row.get("taskId")) == normalized_task_id:
            return row
    return None


def _task_status_summary(row: dict[str, Any] | None) -> str:
    if not row:
        return "not_found"
    task_status = row.get("taskStatus")
    task_status_text = str(row.get("taskStatusText") or "").strip()
    err_message = str(row.get("errMessage") or "").strip()
    parts = [f"taskStatus={task_status}", f"taskStatusText={task_status_text or '-'}"]
    if err_message:
        parts.append(f"errMessage={err_message}")
    return ", ".join(parts)


def _is_task_done(row: dict[str, Any]) -> bool:
    status_code = _int_value(row.get("taskStatus"))
    status_text = str(row.get("taskStatusText") or "").strip()
    return status_code == 2 or status_text == DONE_TASK_STATUS_TEXT


def _is_task_pending(row: dict[str, Any]) -> bool:
    status_code = _int_value(row.get("taskStatus"))
    status_text = str(row.get("taskStatusText") or "").strip()
    return status_code in PENDING_TASK_STATUS_CODES or status_text in PENDING_TASK_STATUS_TEXTS


def _is_task_failed(row: dict[str, Any]) -> bool:
    if _is_task_done(row) or _is_task_pending(row):
        return False
    return True


def _normalize_completed_task(row: dict[str, Any], *, expected_task_id: int) -> BatchDeliveryTask:
    task_id = _int_value(row.get("taskId"))
    if task_id != int(expected_task_id):
        raise BatchDeliveryApiError(f"导出任务ID不匹配: expected={expected_task_id}, actual={task_id}")

    file_hash = str(row.get("fileHash") or "").strip()
    if not file_hash:
        raise BatchDeliveryApiError(f"导出任务完成但缺少 fileHash: taskId={expected_task_id}")
    return BatchDeliveryTask(
        task_id=task_id,
        file_hash=file_hash,
        file_name=str(row.get("fileName") or "").strip(),
        task_status=_int_value(row.get("taskStatus")),
        task_status_text=str(row.get("taskStatusText") or "").strip(),
        raw=dict(row),
    )


async def wait_for_delivery_task(
    task_id: int,
    *,
    token: str | None = None,
    timeout_sec: float = 180,
    poll_interval_sec: float = 3,
) -> BatchDeliveryTask:
    normalized_task_id = int(task_id or 0)
    if normalized_task_id <= 0:
        raise ValueError("task_id 必须是正整数")

    safe_timeout = max(0.0, float(timeout_sec))
    safe_interval = max(0.1, float(poll_interval_sec))
    deadline = asyncio.get_running_loop().time() + safe_timeout
    last_summary = "not_found"

    while True:
        row = await fetch_task_report_row(normalized_task_id, token=token)
        if row is not None:
            last_summary = _task_status_summary(row)
            if _is_task_done(row):
                return _normalize_completed_task(row, expected_task_id=normalized_task_id)
            if _is_task_failed(row):
                raise BatchDeliveryApiError(
                    f"FBA发货单导出任务失败(taskId={normalized_task_id}): {last_summary}"
                )

        now = asyncio.get_running_loop().time()
        if now >= deadline:
            break
        await asyncio.sleep(min(safe_interval, max(0.0, deadline - now)))

    raise BatchDeliveryTimeoutError(
        f"导出任务超时(taskId={normalized_task_id}, timeout={safe_timeout:g}s, last_status={last_summary})"
    )


def _normalize_download_info(
    payload: dict[str, Any],
    *,
    expected_task_id: int,
    expected_file_hash: str,
) -> BatchDeliveryDownloadInfo:
    data = payload.get("data")
    if not isinstance(data, dict):
        raise BatchDeliveryApiError("下载地址数据格式异常")

    task_id = _int_value(data.get("taskId"))
    if task_id != int(expected_task_id):
        raise BatchDeliveryApiError(f"下载地址任务ID不匹配: expected={expected_task_id}, actual={task_id}")

    file_hash = str(data.get("fileHash") or expected_file_hash or "").strip()
    if not file_hash:
        raise BatchDeliveryApiError(f"下载地址缺少 fileHash: taskId={expected_task_id}")

    download_url = str(data.get("downloadUrl") or "").strip()
    if not download_url:
        raise BatchDeliveryApiError(f"下载地址缺少 downloadUrl: taskId={expected_task_id}")

    return BatchDeliveryDownloadInfo(
        task_id=task_id,
        file_hash=file_hash,
        file_name=str(data.get("fileName") or f"fba_delivery_{expected_task_id}.csv").strip(),
        download_url=download_url,
        raw=dict(data),
    )


async def request_download_info(
    task_id: int,
    file_hash: str,
    *,
    token: str | None = None,
) -> BatchDeliveryDownloadInfo:
    normalized_task_id = int(task_id or 0)
    if normalized_task_id <= 0:
        raise ValueError("task_id 必须是正整数")
    normalized_hash = str(file_hash or "").strip()
    if not normalized_hash:
        raise BatchDeliveryApiError(f"下载发货单CSV缺少 fileHash: taskId={normalized_task_id}")

    active_token = str(token or "").strip() or await get_fba_free_token()
    api_url = _configured_text("FBA_DELIVERY_TASK_DOWNLOAD_URL", DEFAULT_TASK_DOWNLOAD_URL)
    params = {
        "taskId": str(normalized_task_id),
        "fileHash": normalized_hash,
    }
    async with erp_http_session.get(
        api_url,
        params=params,
        headers=_request_headers(active_token, json_content=False),
    ) as resp:
        response = await _read_api_json(resp, action="获取FBA发货单下载地址")
    return _normalize_download_info(
        response,
        expected_task_id=normalized_task_id,
        expected_file_hash=normalized_hash,
    )


def _safe_file_part(value: Any) -> str:
    text = str(value or "").strip()
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", text)
    return text.strip("._-") or "delivery"


def _resolve_output_dir(output_dir: str | Path | None = None) -> Path:
    if output_dir is not None:
        path = Path(output_dir)
    else:
        configured = getattr(config, "FBA_DELIVERY_CSV_DIR", "")
        path = Path(str(configured or DEFAULT_OUTPUT_DIR))
    path.mkdir(parents=True, exist_ok=True)
    return path


async def download_csv_from_url(
    download_url: str,
    *,
    delivery_no: str,
    task_id: int,
    output_dir: str | Path | None = None,
) -> Path:
    url = str(download_url or "").strip()
    if not url:
        raise ValueError("download_url 不能为空")

    target_dir = _resolve_output_dir(output_dir)
    target_path = target_dir / f"{_safe_file_part(delivery_no)}_{int(task_id)}.csv"
    headers = {"Accept": "text/csv,application/octet-stream,*/*"}
    async with external_http_session.get(url, headers=headers) as resp:
        status_code = int(getattr(resp, "status", 0) or 0)
        body = await resp.read()
        if status_code >= 400:
            msg = body.decode("utf-8", errors="replace")[:300] if body else "empty response"
            raise MabangRequestError(f"下载FBA发货单CSV失败(status={status_code}): {msg}")
        if not body:
            raise BatchDeliveryApiError("下载FBA发货单CSV返回空文件")

    target_path.write_bytes(body)
    return target_path


async def download_fba_delivery_csv(
    delivery_no: str,
    *,
    timeout_sec: float = 180,
    poll_interval_sec: float = 3,
    report_date: str | date | None = None,
    output_dir: str | Path | None = None,
) -> BatchDeliveryCsvResult:
    target = _require_delivery_no(delivery_no)
    token = await get_fba_free_token()

    list_payload = await fetch_batch_delivery_list(target, token=token)
    delivery_id = extract_delivery_id(list_payload, target)
    task_id = await create_delivery_export_task(delivery_id, token=token, report_date=report_date)
    task = await wait_for_delivery_task(
        task_id,
        token=token,
        timeout_sec=timeout_sec,
        poll_interval_sec=poll_interval_sec,
    )
    download_info = await request_download_info(task.task_id, task.file_hash, token=token)
    csv_path = await download_csv_from_url(
        download_info.download_url,
        delivery_no=target,
        task_id=download_info.task_id,
        output_dir=output_dir,
    )
    return BatchDeliveryCsvResult(
        delivery_no=target,
        delivery_id=delivery_id,
        task_id=download_info.task_id,
        file_hash=download_info.file_hash,
        file_name=download_info.file_name,
        csv_path=str(csv_path),
    )


__all__ = [
    "BatchDeliveryApiAuthError",
    "BatchDeliveryApiError",
    "BatchDeliveryCsvResult",
    "BatchDeliveryDownloadInfo",
    "BatchDeliveryTask",
    "BatchDeliveryTimeoutError",
    "create_delivery_export_task",
    "download_csv_from_url",
    "download_fba_delivery_csv",
    "extract_delivery_id",
    "fetch_batch_delivery_list",
    "fetch_task_report_row",
    "normalize_delivery_no",
    "request_download_info",
    "wait_for_delivery_task",
]
