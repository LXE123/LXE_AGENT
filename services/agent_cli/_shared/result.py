from __future__ import annotations

from typing import Any


STATUS_UPLOADED_VALIDATED = "uploaded_validated"
STATUS_UPLOAD_VALIDATION_FAILED = "upload_validation_failed"
STATUS_EXECUTION_FAILED = "execution_failed"


def build_result(
    *,
    ok: bool,
    status: str,
    store_id: str = "",
    store_name: str = "",
    site: str = "",
    consignment_no: str = "",
    consignment_excel_path: str = "",
    template_path: str = "",
    filled_template_path: str = "",
    page_url: str = "",
    page_title: str = "",
    upload_status: str = "",
    upload_errors: list[str] | None = None,
    next_action: str = "",
    error: str = "",
) -> dict[str, Any]:
    return {
        "ok": bool(ok),
        "status": str(status or "").strip(),
        "store_id": str(store_id or "").strip(),
        "selected_store": {
            "store_id": str(store_id or "").strip(),
            "store_name": str(store_name or "").strip(),
        },
        "site": str(site or "").strip(),
        "consignment_no": str(consignment_no or "").strip(),
        "files": {
            "consignment_excel_path": str(consignment_excel_path or "").strip(),
            "template_path": str(template_path or "").strip(),
            "filled_template_path": str(filled_template_path or "").strip(),
        },
        "page": {
            "url": str(page_url or "").strip(),
            "title": str(page_title or "").strip(),
        },
        "upload": {
            "status": str(upload_status or "").strip(),
            "errors": [
                str(item or "").strip()
                for item in list(upload_errors or [])
                if str(item or "").strip()
            ],
        },
        "next_action": str(next_action or "").strip(),
        "error": str(error or "").strip(),
    }


__all__ = [
    "STATUS_EXECUTION_FAILED",
    "STATUS_UPLOADED_VALIDATED",
    "STATUS_UPLOAD_VALIDATION_FAILED",
    "build_result",
]
