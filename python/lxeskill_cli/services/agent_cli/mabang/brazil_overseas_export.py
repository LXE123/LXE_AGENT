from services.mabang.brazil_overseas.workflow import run as export_reports
from services.agent_cli._shared.report_names import BRAZIL_REPORTS, public_reports, selected_reports


def run(arguments):
    try:
        if set(arguments) != {"report"}:
            raise ValueError("Only --report is accepted and at least one report is required")
        reports = selected_reports(arguments["report"], BRAZIL_REPORTS)
    except ValueError as exc:
        return {"success": False, "status": "failed", "artifacts": [], "error": {"code": "invalid_arguments", "message": str(exc)}}
    return public_reports(export_reports({"params": {"reports": reports}}), BRAZIL_REPORTS)

__all__ = ['run']
