"""Bounded Office execution for callers that need captured output and tree cleanup."""

from contextlib import contextmanager
import math
import os
import signal
import subprocess
import sys
import threading


@contextmanager
def _cancellation():
    previous = {}

    def cancel(signum, _frame):
        # Repeated cancellation must not interrupt the bounded cleanup below.
        for registered in previous:
            signal.signal(registered, signal.SIG_IGN)
        if signum == signal.SIGINT:
            raise KeyboardInterrupt
        raise SystemExit(128 + signum)

    try:
        if threading.current_thread() is threading.main_thread():
            for signum in (signal.SIGINT, signal.SIGTERM):
                previous[signum] = signal.signal(signum, cancel)
        yield
    finally:
        for signum, handler in previous.items():
            signal.signal(signum, handler)


def _kill_tree(process, job) -> None:
    if job is not None:
        job.terminate()
        # Also covers the venv redirector and a still-gated, unassigned worker.
        if process.poll() is None:
            process.kill()
    else:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def _stop(process, job, cleanup_seconds):
    try:
        if os.name != "nt" and process.poll() is None:
            # Let Kit abort its native helper and remove scratch files first.
            process.send_signal(signal.SIGTERM)
            try:
                return process.communicate(timeout=cleanup_seconds)
            except subprocess.TimeoutExpired:
                pass
    finally:
        # Always cover descendants, even if the intermediate process exited.
        _kill_tree(process, job)
    return process.communicate(timeout=cleanup_seconds)


def run_kit_bounded(
    arguments: list[str], *, timeout_seconds: float, cleanup_seconds: float = 5,
) -> subprocess.CompletedProcess[str]:
    """Give Kit an explicit deadline, then allow bounded cleanup before forcing exit.

    POSIX uses a private session; Windows uses a kill-on-close job. The gated
    worker joins the Windows job itself before it can start any children.
    This does not change the transparent public ``python -m shared.office`` CLI.
    """
    if not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 2_147_483.647:
        raise ValueError("Office timeout_seconds must be positive and fit a 32-bit millisecond timer")
    if not math.isfinite(cleanup_seconds) or cleanup_seconds <= 0:
        raise ValueError("Office cleanup_seconds must be finite and positive")
    command = [
        sys.executable, "-m", "shared.office._worker", *arguments,
        "--timeout-ms", str(max(1, math.ceil(timeout_seconds * 1000))),
    ]
    job = None
    process = None
    with _cancellation():
        try:
            if os.name == "nt":
                from ._windows_job import OfficeJob

                job = OfficeJob()
                command[3:3] = ["--windows-job", job.name]
            process = subprocess.Popen(
                command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace", start_new_session=os.name != "nt",
            )
            try:
                stdout, stderr = process.communicate(
                    input="1", timeout=timeout_seconds + cleanup_seconds,
                )
            except subprocess.TimeoutExpired as error:
                stdout, stderr = _stop(process, job, cleanup_seconds)
                process = None  # Already reaped, and its descendants terminated.
                error.output, error.stderr = stdout, stderr
                raise
            return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
        finally:
            try:
                if process is not None:
                    if process.poll() is None:
                        _stop(process, job, cleanup_seconds)
                    else:
                        _kill_tree(process, job)
                    for stream in (process.stdin, process.stdout, process.stderr):
                        if stream is not None:
                            stream.close()
            finally:
                if job is not None:
                    job.close()
