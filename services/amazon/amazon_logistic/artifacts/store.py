from __future__ import annotations

import os
from pathlib import Path

from shared.infra.artifact_io import build_timestamped_path, write_text
from shared.logging import logger


_DATA_DIR = Path("artifacts") / "amazon_fba_logistics"
_DATA_DIR.mkdir(parents=True, exist_ok=True)


def save_artifacts(
    pricing_details_markdown: str,
    run_key: str,
    pricing_slug: str,
) -> str:
    safe_run_key = str(run_key or "run").strip() or "run"
    safe_pricing_slug = str(pricing_slug or "channel_pricing").strip() or "channel_pricing"

    channel_pricing_md = build_timestamped_path(_DATA_DIR, f"{safe_run_key}_{safe_pricing_slug}", "md")
    written_md = write_text(pricing_details_markdown, channel_pricing_md)
    if not written_md:
        raise RuntimeError("物流优选 Markdown 写入失败")

    logger.info(
        "[FBA Logistics] artifact saved | markdown=%s",
        os.path.basename(written_md) if written_md else "-",
    )
    return written_md


__all__ = ["save_artifacts"]
