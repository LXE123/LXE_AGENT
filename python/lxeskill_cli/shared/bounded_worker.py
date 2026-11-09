"""Supervise a gated Python worker and its descendants under one deadline."""

from contextlib import contextmanager
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
            # Let the worker stop its children and remove scratch files first.
            process.send_signal(signal.SIGTERM)
            try:
                return process.communicate(timeout=cleanup_seconds)
            except subprocess.TimeoutExpired:
                pass
    finally:
        # Always cover descendants, even if the intermediate process exited.
        _kill_tree(process, job)
    return process.communicate(timeout=cleanup_seconds)


def enter_worker() -> None:
    if sys.stdin.buffer.read(1) != b"1":
        raise SystemExit("Supervisor closed the start gate")
    if sys.argv[1:2] == ["--windows-job"]:
        from ._windows_job import ProcessJob

        job = ProcessJob(existing_name=sys.argv[2])
        try:
            job.assign(os.getpid())
        finally:
            job.close()
        del sys.argv[1:3]


def run_worker(
    module: str, arguments: list[str], *, input_text: str = "", timeout_seconds: float,
    cleanup_seconds: float = 1,
) -> subprocess.CompletedProcess[str]:
    """Workers must call enter_worker() before spawning children."""
    command = [sys.executable, "-m", module, *arguments]
    job = None
    process = None
    with _cancellation():
        try:
            if os.name == "nt":
                from ._windows_job import ProcessJob

                job = ProcessJob()
                command[3:3] = ["--windows-job", job.name]
            process = subprocess.Popen(
                command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", errors="replace", start_new_session=os.name != "nt",
            )
            try:
                stdout, stderr = process.communicate(
                    input="1" + input_text, timeout=timeout_seconds,
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
