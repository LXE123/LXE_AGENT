from __future__ import annotations

import argparse
import asyncio
import os
from typing import Any, Callable

from services.agent_cli._shared.browser_session import browser_session
from services.agent_cli._shared.context_json import (
    context_payload,
    merge_context_payloads,
    parse_context_file_argument,
)
from services.agent_cli.browser.amazon_common.region_switch import normalize_site_code
from services.browser.workflows.amazon_fba_common import selected_store as _selected_store
from services.browser.workflows.amazon_fba_common import workflow_output_dir as _workflow_output_dir
from shared.infra.net import close_all_network_clients
from shared.logging import logger
from shared.runtime_core.utils import send_file_to_current_session


FixedFlowRunner = Callable[..., dict[str, Any]]
_FBA_CLI_EMIT_CONFIGURED = False


def build_parser(prog: str) -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog=prog, allow_abbrev=False)
    parser.add_argument("--context-file")
    parser.add_argument("--timeout-sec", type=int, default=180)
    return parser


def validate_args(args: argparse.Namespace) -> tuple[dict[str, str], int]:
    context = parse_context_file_argument(getattr(args, "context_file", ""))
    timeout_sec = max(30, int(getattr(args, "timeout_sec", 180) or 180))
    return context, timeout_sec


def exception_text(exc: Exception) -> str:
    message = str(exc).strip()
    return message or exc.__class__.__name__


def resolve_agent_session_id() -> str:
    return str(os.environ.get("LXE_AGENT_SESSION_ID") or "").strip()


def resolve_response_route_id() -> str:
    return str(os.environ.get("LXE_RESPONSE_ROUTE_ID") or "").strip()


def result_with_details(
    *,
    params_ready: bool,
    finished: bool,
    exception: str = "",
    notice: str = "",
    file_path: list[dict[str, str]] | None = None,
    context: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        "params_ready": bool(params_ready),
        "finished": bool(finished),
        "exception": str(exception or "").strip(),
        "notice": str(notice or "").strip(),
        "file_path": list(file_path or []),
        "context": merge_context_payloads(context),
    }


def not_ready_result(
    *,
    context: dict[str, str] | None = None,
    exception: str = "",
) -> dict[str, Any]:
    return result_with_details(
        params_ready=False,
        finished=False,
        exception=exception,
        context=context,
    )


def normalize_result(
    payload: dict[str, Any] | None,
    *,
    fallback_context: dict[str, str] | None = None,
    include_file_path: bool = True,
) -> dict[str, Any]:
    safe_payload = dict(payload or {})
    file_path = list(safe_payload.get("file_path") or []) if include_file_path else []
    return result_with_details(
        params_ready=bool(safe_payload.get("params_ready")),
        finished=bool(safe_payload.get("finished")),
        exception=str(safe_payload.get("exception") or "").strip(),
        notice=str(safe_payload.get("notice") or "").strip(),
        file_path=file_path,
        context=merge_context_payloads(fallback_context, safe_payload.get("context")),
    )


def ensure_emit_configured_for_fba_cli() -> None:
    global _FBA_CLI_EMIT_CONFIGURED
    if _FBA_CLI_EMIT_CONFIGURED:
        return
    _FBA_CLI_EMIT_CONFIGURED = True


def finalize_fba_cli_process() -> None:
    try:
        asyncio.run(close_all_network_clients())
    except Exception as exc:
        logger.warning("[FBA CLI] close_all_network_clients failed: %s", exc, exc_info=True)


def send_selected_result_files(
    payload: dict[str, Any] | None,
    *,
    allowed_keys: tuple[str, ...],
) -> dict[str, Any]:
    safe_payload = dict(payload or {})
    file_entries = list(safe_payload.get("file_path") or [])
    allowed = {str(key or "").strip() for key in allowed_keys if str(key or "").strip()}
    file_paths = [
        str(dict(item or {}).get("value") or "").strip()
        for item in file_entries
        if str(dict(item or {}).get("key") or "").strip() in allowed
        and str(dict(item or {}).get("value") or "").strip()
    ]

    safe_payload["file_path"] = []
    if not file_paths:
        return safe_payload

    ensure_emit_configured_for_fba_cli()
    session_id = resolve_agent_session_id()
    if not session_id:
        return safe_payload
    response_route_id = resolve_response_route_id()

    async def _send_all() -> list[str]:
        failed: list[str] = []
        for path in file_paths:
            try:
                await send_file_to_current_session(
                    session_id,
                    path,
                    response_route_id=response_route_id,
                )
            except Exception as exc:
                failed.append(f"{path} ({exception_text(exc)})")
        return failed

    failed_files = asyncio.run(_send_all())
    if not failed_files:
        return safe_payload

    notice = str(safe_payload.get("notice") or "").strip()
    failure_notice = f"文件已生成，但发送到群里失败：{'; '.join(failed_files)}"
    safe_payload["notice"] = f"{notice}；{failure_notice}" if notice else failure_notice
    return safe_payload


def run_direct_fba_workflow(
    *,
    context: dict[str, str],
    workflow_runner: FixedFlowRunner,
    timeout_sec: int = 180,
    include_file_path: bool = True,
) -> dict[str, Any]:
    base_context = merge_context_payloads(context)
    site = str(base_context.get("site") or "").strip()
    consignment_no = str(base_context.get("consignment_no") or "").strip()
    transport_mode = str(base_context.get("transport_mode") or "").strip()
    try:
        target_site = normalize_site_code(site)
    except Exception as exc:
        return not_ready_result(context=base_context, exception=exception_text(exc))
    normalized_context = merge_context_payloads(base_context, context_payload(site=target_site))

    agent_session_id = resolve_agent_session_id()
    if not agent_session_id:
        return not_ready_result(
            context=normalized_context,
            exception="缺少 LXE_AGENT_SESSION_ID",
        )

    try:
        with browser_session(
            session_id=agent_session_id,
            context=normalized_context,
            output_dir=_workflow_output_dir(agent_session_id),
        ) as session:
            session_context = merge_context_payloads(
                normalized_context,
                context_payload(**_selected_store(session)),
            )
            payload = workflow_runner(
                session=session,
                payload={
                    "site": target_site,
                    "consignment_no": consignment_no,
                    "transport_mode": transport_mode,
                    "timeout_sec": timeout_sec,
                },
                event_writer=lambda _payload: None,
            )
    except Exception as exc:
        return result_with_details(
            params_ready=True,
            finished=False,
            exception=exception_text(exc),
            context=normalized_context,
        )
    return normalize_result(
        payload,
        fallback_context=session_context,
        include_file_path=include_file_path,
    )


__all__ = [
    "build_parser",
    "exception_text",
    "finalize_fba_cli_process",
    "normalize_result",
    "not_ready_result",
    "result_with_details",
    "run_direct_fba_workflow",
    "ensure_emit_configured_for_fba_cli",
    "send_selected_result_files",
    "validate_args",
]
