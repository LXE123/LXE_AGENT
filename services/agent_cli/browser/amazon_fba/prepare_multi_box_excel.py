from __future__ import annotations

from typing import Any, Callable

from services.agent_cli._shared.context_json import context_payload, merge_context_payloads
from services.agent_cli._shared.json_output import configure_utf8_stdio, write_result_event
from services.agent_cli.browser.amazon_fba._shared import (
    archive_selected_result_files,
    build_parser,
    exception_text,
    finalize_fba_cli_process,
    not_ready_result,
    run_direct_fba_workflow,
    validate_args,
)
from services.browser.workflows.amazon_fba_prepare_multi_box_excel import run_prepare_multi_box_excel_workflow


def run_prepare_multi_box_excel(
    *,
    context: dict[str, str],
    timeout_sec: int = 180,
    workflow_runner: Callable[..., dict[str, Any]] = run_prepare_multi_box_excel_workflow,
) -> dict[str, Any]:
    return run_direct_fba_workflow(
        context=context,
        timeout_sec=timeout_sec,
        workflow_runner=workflow_runner,
    )


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    try:
        parser = build_parser("prepare_multi_box_excel")
        args = parser.parse_args(argv)
        raw_context = context_payload()

        try:
            context, timeout_sec = validate_args(args)
            raw_context = merge_context_payloads(context)
        except Exception as exc:
            payload = not_ready_result(
                context=raw_context,
                exception=exception_text(exc),
            )
            write_result_event(payload)
            return 1

        payload = run_prepare_multi_box_excel(
            context=context,
            timeout_sec=timeout_sec,
        )
        payload = archive_selected_result_files(
            payload,
            allowed_keys=("step2_filled",),
            stage="prepare_multi_box_excel",
        )
        write_result_event(payload)
        return 0 if bool(payload.get("finished")) else 1
    finally:
        finalize_fba_cli_process()


if __name__ == "__main__":
    raise SystemExit(main())
