"""Merge explicitly supplied Philippine reports without accessing either ERP."""

from services.philippines_reports.workflow import merge_reports


def run(arguments):
    required = {"sales_file", "inventory_file", "tms_file"}
    if (not isinstance(arguments, dict) or set(arguments) != required
            or any(not isinstance(value, str) or not value.strip() for value in arguments.values())):
        return {"success": False, "status": "failed", "artifacts": [], "error": {
            "code": "invalid_arguments", "message": "必须提供 --sales-file、--inventory-file、--tms-file 三份完整 XLSX 路径",
        }}
    return merge_reports(**arguments)
