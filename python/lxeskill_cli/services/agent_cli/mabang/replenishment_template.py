from __future__ import annotations

from typing import Any

from services.agent_cli._shared.json_cli import exception_text as _exception_text
from services.mabang.amazon.fba import replenishment_template as template_service


def _success_payload(arguments: dict[str, Any]) -> dict[str, Any]:
    command = str(arguments.get("command") or "")
    if command == "list":
        return template_service.templates_payload()
    if command == "list-params":
        return {
            "success": True,
            "groups": template_service.list_parameter_groups(),
            "source": template_service.SOURCE,
        }
    if command == "show":
        template = template_service.get_template(
            str(arguments.get("template") or template_service.DEFAULT_TEMPLATE_NAME)
        )
        return {
            "success": True,
            "template": template.to_payload(),
            "source": template_service.SOURCE,
        }
    if command == "export":
        template_name = str(arguments.get("template") or template_service.DEFAULT_TEMPLATE_NAME).strip()
        template = template_service.get_template(template_name)
        xlsx_path = template_service.export_template_xlsx(template_name)
        return {
            "success": True,
            "template_name": template.name,
            "template_version": template.version,
            "xlsx_path": str(xlsx_path),
            "deliverable_xlsx_path": str(xlsx_path),
            "source": template_service.SOURCE,
        }
    if command == "validate-file":
        xlsx_path = str(arguments.get("xlsx") or "").strip()
        result = template_service.validate_template_xlsx(xlsx_path)
        return {
            "success": True,
            "template_name": result.template.name,
            "template_version": result.template.version,
            "warnings": list(result.warnings),
            "xlsx_path": xlsx_path,
            "source": template_service.SOURCE,
        }
    if command == "import":
        xlsx_path = str(arguments.get("xlsx") or "").strip()
        result = template_service.import_template_xlsx(xlsx_path, name=str(arguments.get("name") or ""))
        return {
            "success": True,
            "template_name": result.template.name,
            "template_version": result.template.version,
            "warnings": list(result.warnings),
            "xlsx_path": xlsx_path,
            "source": template_service.SOURCE,
        }
    if command == "replace":
        xlsx_path = str(arguments.get("xlsx") or "").strip()
        template_name = str(arguments.get("template") or "").strip()
        result, old_version = template_service.replace_template_xlsx(xlsx_path, template_name=template_name)
        return {
            "success": True,
            "template_name": result.template.name,
            "old_version": old_version,
            "new_version": result.template.version,
            "warnings": list(result.warnings),
            "xlsx_path": xlsx_path,
            "source": template_service.SOURCE,
        }
    if command == "rename":
        old_name = str(arguments.get("template") or "").strip()
        new_name = str(arguments.get("name") or "").strip()
        result = template_service.rename_template(old_name, new_name=new_name)
        return {
            "success": True,
            "old_name": old_name,
            "new_name": result.name,
            "template_version": result.version,
            "source": template_service.SOURCE,
        }
    raise ValueError(f"未知命令: {command}")


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — the catalog input_schema is the argument contract."""
    command = str(arguments.get("command") or "")
    try:
        return _success_payload(arguments)
    except Exception as exc:  # noqa: BLE001 — failure context belongs in the payload
        return {
            "success": False,
            "command": command,
            "exception": _exception_text(exc),
        }
