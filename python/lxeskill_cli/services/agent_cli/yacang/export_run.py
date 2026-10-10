from services.yacang.workflow import run as export_reports
from services.agent_cli._shared.report_names import YACANG_REPORTS, public_reports, selected_reports


def run(arguments):
    try:
        unknown = set(arguments) - {"report", "warehouse", "created_from", "created_to"}
        if unknown:
            raise ValueError(f"Unknown options: {', '.join(sorted(unknown))}")
        params = {"reports": selected_reports(arguments.get("report"), YACANG_REPORTS)}
        if "warehouse" in arguments:
            params["warehouses"] = arguments["warehouse"]
        if "created_from" in arguments or "created_to" in arguments:
            if not arguments.get("created_from") or not arguments.get("created_to"):
                raise ValueError("--created-from and --created-to must be provided together")
            params["created_date"] = {"start_date": arguments["created_from"], "end_date": arguments["created_to"]}
    except ValueError as exc:
        return {"success": False, "status": "failed", "artifacts": [], "error": {"code": "invalid_arguments", "message": str(exc)}}
    return public_reports(export_reports({"params": params}), YACANG_REPORTS)

__all__ = ['run']
