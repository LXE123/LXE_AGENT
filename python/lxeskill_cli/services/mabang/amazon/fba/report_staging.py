"""Private, same-filesystem staging for complete replenishment workbooks."""
from __future__ import annotations

import shutil
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from shared.logging import get_logger

logger = get_logger(__name__)


@contextmanager
def staged_report_path(target: Path) -> Iterator[Path]:
    directory = Path(tempfile.mkdtemp(prefix=".replenishment-", dir=target.parent))
    try:
        yield directory / "report.xlsx"
    finally:
        try:
            shutil.rmtree(directory)
        except OSError as exc:
            # Cleanup must neither hide the original failure nor turn a published
            # report into a reported failure. Leftovers cannot match report names.
            logger.warning("备货临时目录清理失败: path=%s; %s: %s", directory, type(exc).__name__, exc)
