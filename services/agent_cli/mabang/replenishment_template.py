from __future__ import annotations

import argparse
import json
import sys
from typing import Any

from services.agent_cli._shared.json_output import configure_utf8_stdio
from services.mabang.amazon.fba import replenishment_template as template_service


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ValueError(str(message or "").strip() or "参数解析失败")


def _write_json(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(dict(payload or {}), ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _exception_text(exc: Exception) -> str:
    message = str(exc or "").strip()
    return message or exc.__class__.__name__


def build_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(
        prog="python -m services.agent_cli.mabang.replenishment_template"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("list")
    subparsers.add_parser("list-params")

    show_parser = subparsers.add_parser("show")
    show_parser.add_argument("--template", default=template_service.DEFAULT_TEMPLATE_NAME)

    export_parser = subparsers.add_parser("export")
    export_parser.add_argument("--template", default=template_service.DEFAULT_TEMPLATE_NAME)

    validate_parser = subparsers.add_parser("validate-file")
    validate_parser.add_argument("--xlsx", required=True)

    import_parser = subparsers.add_parser("import")
    import_parser.add_argument("--xlsx", required=True)
    import_parser.add_argument("--name", default="")

    replace_parser = subparsers.add_parser("replace")
    replace_parser.add_argument("--template", required=True)
    replace_parser.add_argument("--xlsx", required=True)

    rename_parser = subparsers.add_parser("rename")
    rename_parser.add_argument("--template", required=True)
    rename_parser.add_argument("--name", required=True)

    return parser


def _success_payload_for_args(args: argparse.Namespace) -> dict[str, Any]:
    command = str(getattr(args, "command", "") or "")
    if command == "list":
        return template_service.templates_payload()
    if command == "list-params":
        return {
            "success": True,
            "groups": template_service.list_parameter_groups(),
            "source": template_service.SOURCE,
        }
    if command == "show":
        template = template_service.get_template(getattr(args, "template", ""))
        return {
            "success": True,
            "template": template.to_payload(),
            "source": template_service.SOURCE,
        }
    if command == "export":
        template_name = str(getattr(args, "template", "") or "").strip()
        template = template_service.get_template(template_name)
        xlsx_path = template_service.export_template_xlsx(template_name)
        return {
            "success": True,
            "template_name": template.name,
            "template_version": template.version,
            "xlsx_path": str(xlsx_path),
            "source": template_service.SOURCE,
        }
    if command == "validate-file":
        xlsx_path = str(getattr(args, "xlsx", "") or "").strip()
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
        xlsx_path = str(getattr(args, "xlsx", "") or "").strip()
        result = template_service.import_template_xlsx(xlsx_path, name=getattr(args, "name", ""))
        return {
            "success": True,
            "template_name": result.template.name,
            "template_version": result.template.version,
            "warnings": list(result.warnings),
            "xlsx_path": xlsx_path,
            "source": template_service.SOURCE,
        }
    if command == "replace":
        xlsx_path = str(getattr(args, "xlsx", "") or "").strip()
        template_name = str(getattr(args, "template", "") or "").strip()
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
        old_name = str(getattr(args, "template", "") or "").strip()
        new_name = str(getattr(args, "name", "") or "").strip()
        result = template_service.rename_template(old_name, new_name=new_name)
        return {
            "success": True,
            "old_name": old_name,
            "new_name": result.name,
            "template_version": result.version,
            "source": template_service.SOURCE,
        }
    raise ValueError(f"未知命令: {command}")


def main(argv: list[str] | None = None) -> int:
    configure_utf8_stdio()
    command = ""
    try:
        args = build_parser().parse_args(argv)
        command = str(getattr(args, "command", "") or "")
        payload = _success_payload_for_args(args)
    except Exception as exc:
        payload = {
            "success": False,
            "command": command,
            "exception": _exception_text(exc),
        }

    _write_json(payload)
    return 0 if bool(payload.get("success")) else 1


if __name__ == "__main__":
    raise SystemExit(main())
