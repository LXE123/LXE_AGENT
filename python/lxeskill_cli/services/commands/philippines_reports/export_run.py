"""Collect PH8805 and PH1 sources and generate the two Philippine reports."""

from services.philippines_reports.workflow import export_reports


def run(arguments):
    return run_with_events(arguments, lambda _event: None)


def run_with_events(arguments, on_event):
    if not isinstance(arguments, dict) or set(arguments) - {"resume_id"}:
        return {"success": False, "status": "failed", "artifacts": [], "error": {
            "code": "invalid_arguments", "message": "菲律宾报表只接受续跑编号 resume_id，仓库固定使用 PH8805 与 PH1",
        }}
    return export_reports(on_event, resume_id=arguments.get("resume_id"))
