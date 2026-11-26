"""Collect VN8806 and VN1 and deliver the two merged reports."""
from services.philippines_reports.workflow import ReportScope, export_reports


VIETNAM = ReportScope("越南", "VN8806", "VN1", 12831, "越南VN1仓", "vietnam_reports")


def run(arguments):
    return run_with_events(arguments, lambda _event: None)


def run_with_events(arguments, on_event):
    if not isinstance(arguments, dict) or set(arguments) - {"resume_id"}:
        return {"success": False, "status": "failed", "artifacts": [], "error": {
            "code": "invalid_arguments", "message": "越南报表只接受续跑编号 resume_id，仓库固定使用 VN8806 与 VN1",
        }}
    return export_reports(on_event, resume_id=arguments.get("resume_id"), scope=VIETNAM)
