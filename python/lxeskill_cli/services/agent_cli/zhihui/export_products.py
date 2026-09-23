from __future__ import annotations

from collections.abc import Callable
import contextlib
from hashlib import sha256
import os
from pathlib import Path
from typing import Any
from uuid import uuid4

from services.zhihui_tms.client import DEFAULT_MAX_HTTP_ATTEMPTS, ZhihuiTmsClient
from services.zhihui_tms.errors import redact_text
from services.zhihui_tms.planner import plan_product_export
from services.zhihui_tms.product_export import export_stockwarehouse_pages
from services.zhihui_tms.session import ZhihuiTmsSessionProvider
from services.zhihui_tms.xlsx_delivery import deliver_product_exports
from shared.process_lock import InterProcessLockTimeout, interprocess_lock
from shared.workspace import artifact_root


def _existing_delivery(output_dir: Path, date_label: str) -> list[dict[str, Any]]:
    if not output_dir.is_dir():
        return []
    partial = output_dir / f"智汇tms-商品-部分合并-{date_label}.xlsx"
    merged = output_dir / f"智汇tms-商品-合并-{date_label}.xlsx"
    if partial.is_file():
        return [{"path": str(partial.resolve()), "kind": "merged_partial", "page": None, "total_pages": None}]
    if merged.is_file():
        return [{"path": str(merged.resolve()), "kind": "merged", "page": None, "total_pages": None}]
    return []


def _account_lock_path(account: str) -> Path:
    data_root = Path(os.environ.get("LXE_DATA_ROOT", "").strip()).expanduser()
    lock_root = data_root if data_root.is_absolute() else artifact_root()
    account_hash = sha256(account.strip().casefold().encode("utf-8")).hexdigest()
    return lock_root / "locks" / "zhihui_tms" / f"{account_hash}.lock"


def _terminal_data(
    *,
    preview: bool = False,
    row_count: int | None = None,
    partial: bool | None = None,
    partial_pages: int | None = None,
    partial_rows: int | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "platform": "zhihui_tms",
        "country": "PH",
        "business_type": "product_export",
    }
    if preview:
        data["preview"] = True
    if row_count is not None:
        data["row_count"] = row_count
    if partial is not None:
        data["partial"] = partial
    if partial_pages is not None:
        data["partial_pages"] = partial_pages
    if partial_rows is not None:
        data["partial_rows"] = partial_rows
    return data


def _terminal_projection(data: dict[str, Any], *, code: str | None = None, message: str | None = None) -> dict[str, Any]:
    projection: dict[str, Any] = {"data": data}
    if code is not None and message is not None:
        projection["error"] = {"code": code, "message": message}
    return {"terminal_projection": projection}


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """Legacy internal entrypoint; public catalog uses action-specific wrappers."""
    return run_action(arguments, action="preview")


def run_with_events(
    arguments: dict[str, Any], on_event: Callable[[dict[str, Any]], None],
) -> dict[str, Any]:
    """Legacy internal entrypoint; public catalog uses action-specific wrappers."""
    return run_action(arguments, action="preview", on_event=on_event)


def run_action(
    arguments: dict[str, Any], *, action: str, on_event: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    return _run(arguments, action=action, on_event=on_event)


def _run(
    arguments: dict[str, Any], *, action: str, on_event: Callable[[dict[str, Any]], None] | None,
) -> dict[str, Any]:
    try:
        plan = plan_product_export(arguments, action=action)
    except (TypeError, ValueError) as exc:
        return {"success": False, "code": "tms_plan_invalid", "exception": str(exc), "artifacts": []}

    summary: dict[str, Any] = {
        "action": plan.action,
        "warehouse": plan.intent.warehouse,
        "export_kind": plan.intent.kind,
        "historical_metrics_available": plan.intent.historical_metrics_available,
        "date_label": plan.date_label,
        "page_size": plan.page_size,
        "max_pages": plan.max_pages,
        "max_records": plan.max_records,
        "max_requests": plan.max_requests,
        "max_http_attempts": DEFAULT_MAX_HTTP_ATTEMPTS,
        "max_runtime_seconds": plan.max_runtime,
        "artifacts": [],
    }
    if plan.action == "preview":
        return {
            "success": True,
            "artifacts": [],
            **_terminal_projection(_terminal_data(preview=True)),
        }

    if os.environ.get("ZHIHUI_TMS_PRODUCTION_ENABLED") != "1":
        code = "tms_production_disabled"
        message = "智汇 TMS 生产调用开关未启用"
        return {
            "success": False,
            "code": code,
            "exception": message,
            **summary,
            **_terminal_projection(_terminal_data(partial=False), code=code, message=message),
        }
    account = os.environ.get("ZHIHUI_TMS_ACCOUNT", "").strip()
    password = os.environ.get("ZHIHUI_TMS_PASSWORD", "")
    if not account or not password:
        code = "tms_credentials_missing"
        message = "智汇 TMS 运行时账号或密码未配置"
        return {
            "success": False,
            "code": code,
            "exception": message,
            **summary,
            **_terminal_projection(_terminal_data(partial=False), code=code, message=message),
        }

    output_dir = artifact_root() / "zhihui_tms" / uuid4().hex
    client: Any = None

    def emit(event: dict[str, Any]) -> None:
        if on_event is None:
            return
        stage = event.get("stage")
        page = event.get("page")
        page_records = event.get("page_records")
        total_records = event.get("total_records")
        total_pages = event.get("total_pages")
        rows = event.get("rows")
        messages = {
            "login_started": "智汇 TMS：正在登录",
            "authenticated": "智汇 TMS：登录成功",
            "listed": f"智汇 TMS：第{page}页读取{page_records}条，累计{total_records}条",
            "exported": f"智汇 TMS：第{page}页已请求导出{page_records}条",
            "delivery_started": f"智汇 TMS：开始下载{total_pages}页",
            "downloaded": f"智汇 TMS：第{page}/{total_pages}页已保存，{rows}行",
            "merged": f"智汇 TMS：{total_pages}页已合并，{rows}行",
        }
        message = messages.get(stage)
        if message is not None:
            on_event({**event, "message": message})

    try:
        with interprocess_lock(_account_lock_path(account), timeout_seconds=0):
            session_provider = ZhihuiTmsSessionProvider.from_environment()
            client = ZhihuiTmsClient(api_token=session_provider.read(account) or "")

            def authenticate_and_persist() -> None:
                session_provider.clear(account)
                emit({"stage": "login_started"})
                client.login(account, password)
                session_provider.write(account, client.api_token)
                emit({"stage": "authenticated"})

            client.set_authentication_recovery(authenticate_and_persist)
            if not client.api_token:
                authenticate_and_persist()
            export_result = export_stockwarehouse_pages(
                client,
                max_pages=plan.max_pages,
                max_records=plan.max_records,
                max_requests=plan.max_requests,
                max_runtime=plan.max_runtime,
                **({"on_event": emit} if on_event is not None else {}),
            )
            emit({"stage": "delivery_started", "total_pages": len(export_result.pages)})
            delivery = deliver_product_exports(
                client,
                export_result,
                output_dir=output_dir,
                date_label=plan.date_label,
                **({"on_event": emit} if on_event is not None else {}),
            )
            artifacts = [
                {"path": item.path, "kind": item.kind, "page": item.page, "total_pages": item.total_pages}
                for item in delivery.artifacts
            ]
            return {
                "success": True,
                **summary,
                "artifacts": artifacts,
                "total_records": export_result.total_records,
                "request_count": export_result.request_count,
                "http_attempt_count": getattr(client, "request_attempt_count", None),
                "total_rows": delivery.total_rows,
                **_terminal_projection(_terminal_data(row_count=delivery.total_rows)),
            }
    except InterProcessLockTimeout:
        code = "tms_export_busy"
        message = "智汇 TMS 商品导出正在执行，请等待当前任务结束"
        return {
            "success": False,
            **summary,
            "code": code,
            "exception": message,
            **_terminal_projection(_terminal_data(partial=False), code=code, message=message),
        }
    except Exception as exc:  # noqa: BLE001 — the CLI must return the observed redacted failure
        partial_artifacts = [
            {"path": item.path, "kind": item.kind, "page": item.page, "total_pages": item.total_pages}
            for item in getattr(exc, "partial_artifacts", ())
        ]
        artifacts = partial_artifacts or _existing_delivery(output_dir, plan.date_label)
        exception = redact_text(f"{type(exc).__name__}: {exc}", secrets=(account, password))
        partial = bool(artifacts)
        error_code = str(getattr(exc, "code", "tms_export_failed"))
        terminal_data = _terminal_data(
            partial=partial,
            partial_pages=getattr(exc, "partial_pages", None) if partial else None,
            partial_rows=getattr(exc, "partial_rows", None) if partial else None,
        )
        return {
            "success": False,
            **summary,
            "code": error_code,
            "exception": exception,
            "http_attempt_count": getattr(client, "request_attempt_count", None),
            "artifacts": artifacts,
            "partial_pages": getattr(exc, "partial_pages", None),
            "partial_rows": getattr(exc, "partial_rows", None),
            **_terminal_projection(
                terminal_data,
                code="tms_export_partial" if partial else error_code,
                message=exception,
            ),
        }
    finally:
        session = getattr(client, "session", None)
        close = getattr(session, "close", None)
        if callable(close):
            with contextlib.suppress(Exception):
                close()


__all__ = ["run", "run_action", "run_with_events"]
