from __future__ import annotations

import hashlib
import os
import uuid
from contextlib import ExitStack
from datetime import datetime
from pathlib import Path

from shared.datasets import dataset_dir
from shared.process_lock import interprocess_lock
from .client import FIELDS, FILTERS, TmsClient, TmsError, diagnostic
from .workbooks import atomic_bytes, coverage, read_workbook, write_merged


def page_data(body, requested_page):
    payload = next((p for p in (body, body.get("data"), body.get("pop"))
                    if isinstance(p, dict) and "datas" in p and "totalNum" in p), None)
    if payload is None:
        raise TmsError("invalid_page", f"列表响应缺少 datas/totalNum: {body}")
    total = payload["totalNum"]
    if isinstance(total, bool) or not str(total).isdigit():
        raise TmsError("invalid_total", f"无效 totalNum: {total!r}")
    for p in (payload, body.get("pop"), payload.get("pop")):
        if not isinstance(p, dict):
            continue
        for key in ("page", "pageNo", "pageNum", "currentPage"):
            if key in p and str(p[key]) != str(requested_page):
                raise TmsError("page_mismatch", f"请求页 {requested_page}，实际 {key}={p[key]!r}")
    rows = payload["datas"]
    if not isinstance(rows, list) or len(rows) > 1000:
        raise TmsError("invalid_page", f"datas 不是最多 1000 条的数组: {rows}")
    ids = []
    for row in rows:
        value = row.get("id") if isinstance(row, dict) else None
        if isinstance(value, bool) or not isinstance(value, (str, int)) or not str(value).strip():
            raise TmsError("invalid_id", f"列表记录缺少有效 id: {row}")
        ids.append(str(value))
    return int(total), rows, ids


def run(arguments):
    return run_with_events(arguments, lambda event: None)


def run_with_events(arguments, on_event):
    account, password = os.getenv("LXE_MABANG_TMS_ACCOUNT", "").strip(), os.getenv("LXE_MABANG_TMS_PASSWORD", "")
    client, folder, headers = None, None, None
    rows, batches, artifacts = [], [], []
    seen, exported = set(), set()
    total, failure, failure_page = None, None, None
    locks = ExitStack()
    try:
        if arguments:
            raise TmsError("invalid_arguments", "此命令不接受参数")
        if not account or not password:
            raise TmsError("credentials_missing", "请在桌面马帮 TMS 设置中配置账号和密码")
        account_id = hashlib.sha256(account.encode()).hexdigest()
        root = dataset_dir("mabang_tms_exports", account_id)
        root.mkdir(parents=True, exist_ok=True)
        locks.enter_context(interprocess_lock(root / ".export.lock", timeout_seconds=0))
        folder = root / uuid.uuid4().hex
        folder.mkdir()
        client = TmsClient(account, password)
        client.login()
        on_event({"stage": "authenticated", "message": "马帮 TMS：登录成功"})
        for page in range(1, 101):
            failure_page = page
            client.check_budget()
            current_total, records, ids = page_data(client.list_page(page), page)
            if current_total > 100_000:
                raise TmsError("record_limit", f"接口总数 {current_total} 超过 100000 条上限")
            if total is None:
                total = current_total
            elif total != current_total:
                raise TmsError("total_changed", f"接口总数从 {total} 变为 {current_total}")
            if len(set(ids)) != len(ids) or seen.intersection(ids):
                raise TmsError("duplicate_id", f"第 {page} 页出现重复接口记录 ID")
            if not ids and len(seen) != total:
                raise TmsError("early_empty_page", f"第 {page} 页提前为空，已读取 {len(seen)}/{total}")
            if len(seen) + len(ids) > total:
                raise TmsError("total_exceeded", f"累计记录数超过接口总数 {total}")
            seen.update(ids)
            if not ids:
                break
            content = client.download(client.export([r["id"] for r in records]))
            batch_headers, batch_rows, extension = read_workbook(content)
            if headers is not None and batch_headers != headers:
                raise TmsError("header_mismatch", f"第 {page} 批表头变化: {batch_headers}; 之前为 {headers}")
            coverage(records, batch_headers, batch_rows)
            raw = folder / f"原始-第{page:03d}批.{extension}"
            atomic_bytes(raw, content)
            headers = batch_headers
            rows.extend(batch_rows)
            exported.update(ids)
            batches.append({"page": page, "record_count": len(ids), "row_count": len(batch_rows), "raw_path": str(raw)})
            on_event({"stage": "downloaded", "message": f"马帮 TMS：第 {page} 批已校验，累计 {len(exported)}/{total} 条接口记录"})
            client.check_budget()
            if len(seen) == total:
                break
        else:
            raise TmsError("page_limit", f"达到 100 页上限，已读取 {len(seen)}/{total}")
    except Exception as exc:
        failure = {"code": getattr(exc, "code", "export_failed"), "message":
                   client.safe(f"{type(exc).__name__}: {exc}") if client else diagnostic(f"{type(exc).__name__}: {exc}", (account, password))}
    finally:
        if client:
            client.close()
        # Publication remains protected by the account lock.
        try:
            if headers is not None:
                label = "部分导出" if failure else "合并"
                path = folder / f"马帮TMS-商品-{label}-{datetime.now():%Y%m%d-%H%M%S}.xlsx"
                write_merged(path, headers, rows)
                artifacts.append({"path": str(path.resolve()), "row_count": len(rows), "sheet_names": ["商品"], "kind": label})
        except Exception as exc:
            message = diagnostic(f"{type(exc).__name__}: {exc}", (account, password))
            if failure:
                failure["publication_error"] = message
            else:
                failure = {"code": "publication_failed", "message": message}
        finally:
            locks.close()
    sku_index = headers.index("库存SKU") if headers else None
    warehouse_index = headers.index("仓库") if headers else None
    result = {"success": failure is None, "status": "partial_success" if failure and artifacts else "failed" if failure else "completed",
              "filters": FILTERS, "warehouse_scope": "current_account_all", "requested_fields": FIELDS,
              "headers": list(headers or []), "reported_total": total, "read_unique_ids": len(seen),
              "exported_unique_ids": len(exported), "remaining_records": total - len(exported) if total is not None else None,
              "completed_batches": len(batches), "batches": batches, "row_count": len(rows),
              "distinct_skus": len({r[sku_index] for r in rows}) if headers else 0,
              "warehouses": sorted({r[warehouse_index] for r in rows}) if headers else [],
              "artifacts": artifacts, "auth_refresh_required": False}
    if failure:
        result.update(error=failure, failed_page=failure_page)
    return result
