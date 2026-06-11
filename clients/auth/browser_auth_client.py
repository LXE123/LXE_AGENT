from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path
from typing import Any

from shared.infra.net import build_child_env
from shared.logging import logger


class BrowserAuthClientError(RuntimeError):
    """Raised when the browser auth CLI fails."""


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _mask_account(account: str) -> str:
    text = str(account or "").strip()
    if len(text) <= 4:
        return text or "-"
    if len(text) <= 7:
        return f"{text[:2]}***{text[-2:]}"
    return f"{text[:3]}****{text[-4:]}"


def _reason_label(scope: str, require_wms_cookie_header: bool) -> str:
    normalized_scope = str(scope or "").strip().lower()
    if normalized_scope == "fba":
        if require_wms_cookie_header:
            return "获取装箱数据需要"
        return "获取货件数据需要"
    if normalized_scope == "erp":
        return "执行Amazon补货流程需要"
    if normalized_scope == "private_amz":
        return "获取Amazon后台Cookie需要"
    return "业务流程需要"


def _decode_subprocess_output(raw: bytes | str | None) -> str:
    if raw is None:
        return ""
    if isinstance(raw, bytes):
        return raw.decode("utf-8", errors="replace").strip()
    return str(raw).strip()


def _extract_protocol_payload(stdout_text: str) -> dict[str, Any]:
    lines = [line.strip() for line in str(stdout_text or "").splitlines() if line.strip()]
    if not lines:
        raise BrowserAuthClientError("browser_auth_service 协议错误: stdout 为空")
    protocol_line = lines[-1]
    try:
        payload = json.loads(protocol_line)
    except json.JSONDecodeError as exc:
        preview = str(stdout_text or "").strip()[-500:]
        raise BrowserAuthClientError(
            f"browser_auth_service 协议错误: stdout 最后一行不是 JSON: {exc}; stdout={preview}"
        ) from exc
    if not isinstance(payload, dict):
        raise BrowserAuthClientError("browser_auth_service 协议错误: stdout JSON 必须是 object")
    return payload


def ensure_auth_sync(
    scope: str,
    account: str = "",
    require_wms_cookie_header: bool = False,
) -> dict[str, Any]:
    masked_account = _mask_account(account)
    reason_label = _reason_label(scope, require_wms_cookie_header)
    logger.info(
        f"[BrowserAuthClient][{reason_label}] 调用 browser_auth_service: "
        f"scope={str(scope or '').strip()} account={masked_account} "
        f"require_wms_cookie_header={require_wms_cookie_header}"
    )
    command = [
        sys.executable,
        "-m",
        "browser_auth_service.main",
        "ensure",
        "--scope",
        str(scope or "").strip(),
    ]
    if str(account or "").strip():
        command.extend(["--account", str(account).strip()])
    if require_wms_cookie_header:
        command.append("--require-wms-cookie-header")

    completed = subprocess.run(
        command,
        cwd=str(_repo_root()),
        env=build_child_env(
            extra_env={
                "PYTHONIOENCODING": "utf-8",
                "PYTHONUTF8": "1",
            }
        ),
        capture_output=True,
    )

    stdout = _decode_subprocess_output(completed.stdout)
    stderr = _decode_subprocess_output(completed.stderr)

    payload = _extract_protocol_payload(stdout)

    if completed.returncode != 0 or not payload.get("success"):
        message = str(payload.get("message") or stderr or "browser_auth_service 执行失败").strip()
        logger.error(
            f"[BrowserAuthClient][{reason_label}] browser_auth_service 返回失败: "
            f"scope={str(scope or '').strip()} account={masked_account} message={message}"
        )
        raise BrowserAuthClientError(message)
    logger.info(
        f"[BrowserAuthClient][{reason_label}] browser_auth_service 返回成功: "
        f"scope={str(scope or '').strip()} account={masked_account} "
        f"source={payload.get('source')}"
    )
    return payload


async def ensure_auth(
    scope: str,
    account: str = "",
    require_wms_cookie_header: bool = False,
) -> dict[str, Any]:
    return await asyncio.to_thread(
        ensure_auth_sync,
        scope,
        account,
        require_wms_cookie_header,
    )
