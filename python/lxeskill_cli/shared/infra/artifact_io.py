import os
from datetime import datetime
from typing import Optional

from shared.logging import get_logger

logger = get_logger(__name__)


REPORT_IO_PREFIX = "[ReportIO]"


def build_timestamped_path(base_dir: str, prefix: str, ext: str) -> str:
    os.makedirs(base_dir, exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return os.path.join(base_dir, f"{prefix}_{timestamp}.{ext}")


def write_text(text: str, path: str) -> Optional[str]:
    try:
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        return path
    except Exception as error:
        logger.error(f"{REPORT_IO_PREFIX} 写入文本失败: {error}")
        return None


__all__ = ["build_timestamped_path", "write_text"]
