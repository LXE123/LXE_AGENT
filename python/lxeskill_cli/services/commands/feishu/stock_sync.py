"""Expose Feishu stock-list synchronization through lxeskill."""

from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from typing import Any

from services import feishu_stock_sync as sync


def _redact(text: str) -> str:
    for secret in (sync.APP_ID, sync.APP_SECRET, sync.FOLDER_TOKEN, sync._TOKEN):
        if secret:
            text = text.replace(secret, "[已隐藏]")
    return text


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    destination = arguments.get("destination")
    workers = arguments.get("workers", 1)
    if not isinstance(destination, str) or not destination.strip():
        return {"success": False, "status": "failed", "error": {"code": "invalid_arguments", "message": "需要指定保存目录"}}
    if not isinstance(workers, int) or isinstance(workers, bool) or not 1 <= workers <= 16:
        return {"success": False, "status": "failed", "error": {"code": "invalid_arguments", "message": "workers 必须在 1 到 16 之间"}}

    output = StringIO()
    try:
        with redirect_stdout(output):
            success = sync.sync_stock_lists(destination, workers)
    except Exception as exc:
        return {"success": False, "status": "failed", "error": {"code": type(exc).__name__, "message": _redact(str(exc))}, "log": _redact(output.getvalue())}

    log = _redact(output.getvalue())
    completed = [str(Path(destination) / name) for name in sync.MAPPING if f"处理完成 {name}:" in log]
    result = {"success": success, "status": "completed" if success else "failed", "files": completed, "log": log}
    if not success:
        result["error"] = {"code": "sync_failed", "message": "部分文件同步失败，请查看运行日志"}
    return result
