"""Keep full SKU validation findings outside bounded desktop/CLI error messages."""

from __future__ import annotations

import os
from pathlib import Path
from tempfile import NamedTemporaryFile

from shared.repository import state_root
from services.yacang.errors import safe_remote_detail

from .asset_contract import SkuMapValidationError


# Leave room for the existing 2,000/4,096-character downstream error limits.
_MESSAGE_LIMIT = 1800


def validation_diagnostic(exc: BaseException) -> str:
    """Preserve real errors; save every finding when the inline message is too big."""
    secrets = tuple(os.environ.get(name, "") for name in ("LXE_YACANG_MOBILE", "LXE_YACANG_PASSWORD"))

    def redacted(value: str) -> str:
        return safe_remote_detail(value, secrets=secrets, limit=max(len(value), 2000))

    cause: BaseException | None = exc
    while cause is not None and not isinstance(cause, SkuMapValidationError):
        cause = cause.__cause__
    if cause is None:
        return safe_remote_detail(f"{type(exc).__name__}: {exc}", secrets=secrets)

    summary = redacted(cause.summary)
    lines = [redacted(issue.describe()) for issue in cause.issues]
    message = summary + "\n" + "\n".join(lines)
    if len(message) <= _MESSAGE_LIMIT:
        return message

    report: Path | None = None
    try:
        directory = state_root() / "tmp" / "sku-map-validation"
        directory.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory,
                                prefix="sku-map-errors-", suffix=".txt", delete=False) as stream:
            report = Path(stream.name)
            stream.write(redacted(f"输入文件: {cause.path}\n") + message + "\n")
        location = f"完整错误报告: {report}"
    except OSError as report_error:
        if report is not None:
            try:
                report.unlink(missing_ok=True)
            except OSError:
                pass
        location = "完整错误报告写入失败: " + safe_remote_detail(
            f"{type(report_error).__name__}: {report_error}", secrets=secrets, limit=400,
        )

    prefix = summary + "\n" + redacted(location) + "\n以下仅预览部分错误（长文本可能截断）："
    preview = []
    remaining = _MESSAGE_LIMIT - len(prefix) - 80
    for line in lines[:10]:
        if remaining < 100:
            break
        detail = safe_remote_detail(line, secrets=secrets, limit=min(350, remaining - 20))
        preview.append(detail)
        remaining -= len(detail) + 1
    return prefix + "\n" + "\n".join(preview) + f"\n预览 {len(preview)}/{len(lines)} 项。"
