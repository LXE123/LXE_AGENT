"""Bounded Office execution for callers that need captured output and tree cleanup."""

import math
import subprocess

from shared.bounded_worker import run_worker


def run_kit_bounded(
    arguments: list[str], *, timeout_seconds: float, cleanup_seconds: float = 5,
) -> subprocess.CompletedProcess[str]:
    """Give Kit an explicit deadline, then allow bounded cleanup before forcing exit.

    POSIX uses a private session; Windows uses a kill-on-close job. The gated
    worker joins the Windows job itself before it can start any children.
    This is private to business workflows; models call Kit CLI directly.
    """
    if not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 2_147_483.647:
        raise ValueError("Office timeout_seconds must be positive and fit a 32-bit millisecond timer")
    if not math.isfinite(cleanup_seconds) or cleanup_seconds <= 0:
        raise ValueError("Office cleanup_seconds must be finite and positive")
    return run_worker(
        "shared.office._worker", [*arguments, "--timeout-ms", str(max(1, math.ceil(timeout_seconds * 1000)))],
        timeout_seconds=timeout_seconds + cleanup_seconds, cleanup_seconds=cleanup_seconds,
    )
