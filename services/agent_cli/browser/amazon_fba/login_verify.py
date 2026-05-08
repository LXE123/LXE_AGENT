from __future__ import annotations

import argparse
from typing import Any, Callable

from services.agent_cli._shared.browser_session import browser_session
from services.agent_cli._shared.context_json import context_payload, merge_context_payloads
from services.agent_cli._shared.json_output import configure_utf8_stdio, write_result_event
from services.agent_cli.browser.amazon_fba._shared import (
    exception_text,
    finalize_fba_cli_process,
    normalize_result,
    not_ready_result,
    resolve_agent_session_id,
    result_with_details,
)
from services.browser.workflows.amazon_fba_common import selected_store as _selected_store
from services.browser.workflows.amazon_fba_common import workflow_output_dir as _workflow_output_dir
from services.browser.workflows.amazon_fba_login_verify import run_login_verify_workflow


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="login_verify", allow_abbrev=False)
    parser.add_argument("--store-id")
    parser.add_argument("--timeout-sec", type=int, default=180)
    return parser


def _validate_args(args: argparse.Namespace) -> tuple[dict[str, str], int]:
    store_id = str(getattr(args, "store_id", "") or "").strip()
    if not store_id:
        raise RuntimeError("缺少 store_id")
    timeout_sec = max(30, int(getattr(args, "timeout_sec", 180) or 180))
    return {"store_id": store_id}, timeout_sec


def run_login_verify(
    *,
    context: dict[str, str],
    timeout_sec: int = 180,
    workflow_runner: Callable[..., dict[str, Any]] = run_login_verify_workflow,
) -> dict[str, Any]:
    store_id = str(dict(context or {}).get("store_id") or "").strip()
    base_context = {"store_id": store_id}
    if not store_id:
        return not_ready_result(
            context=base_context,
            exception="缺少 store_id",
        )

    agent_session_id = resolve_agent_session_id()
    if not agent_session_id:
        return not_ready_result(
            context=base_context,
            exception="缺少 LXE_AGENT_SESSION_ID",
        )

    try:
        with browser_session(
            session_id=agent_session_id,
            context=base_context,
            output_dir=_workflow_output_dir(agent_session_id),
        ) as session:
            session_context = merge_context_payloads(
                base_context,
                context_payload(**_selected_store(session)),
            )
            payload = workflow_runner(
                session=session,
                payload={
                    "store_id": store_id,
                    "timeout_sec": timeout_sec,
                },
                event_writer=lambda _payload: None,
            )
    except Exception as exc:
        return result_with_details(
            params_ready=True,
            finished=False,
            exception=exception_text(exc),
            context=base_context,
        )
    return normalize_result(
        payload,
        fallback_context=session_context,
        include_file_path=False,
    )


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    try:
        parser = _build_parser()
        args = parser.parse_args(argv)
        raw_context = context_payload()

        try:
            context, timeout_sec = _validate_args(args)
            raw_context = merge_context_payloads(context)
        except Exception as exc:
            payload = not_ready_result(
                context=raw_context,
                exception=exception_text(exc),
            )
            write_result_event(payload)
            return 1

        payload = run_login_verify(
            context=context,
            timeout_sec=timeout_sec,
        )
        write_result_event(payload)
        return 0 if bool(payload.get("finished")) else 1
    finally:
        finalize_fba_cli_process()


if __name__ == "__main__":
    raise SystemExit(main())
