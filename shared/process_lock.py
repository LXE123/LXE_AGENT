from __future__ import annotations

import os
import time
from contextlib import contextmanager
from pathlib import Path
from typing import BinaryIO, Iterator


class InterProcessLockTimeout(TimeoutError):
    pass


def _try_lock(stream: BinaryIO) -> bool:
    stream.seek(0)
    if os.name == "nt":
        import msvcrt

        try:
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False

    import fcntl

    try:
        fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False


def _unlock(stream: BinaryIO) -> None:
    stream.seek(0)
    if os.name == "nt":
        import msvcrt

        msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        return

    import fcntl

    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


@contextmanager
def interprocess_lock(
    path: str | Path,
    *,
    timeout_seconds: float = 180.0,
    poll_seconds: float = 0.1,
) -> Iterator[None]:
    lock_path = Path(path).expanduser().resolve()
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + max(0.0, float(timeout_seconds))
    with lock_path.open("a+b") as stream:
        if stream.seek(0, os.SEEK_END) == 0:
            stream.write(b"0")
            stream.flush()
        while not _try_lock(stream):
            if time.monotonic() >= deadline:
                raise InterProcessLockTimeout(f"timed out waiting for lock: {lock_path}")
            time.sleep(max(0.01, float(poll_seconds)))
        try:
            yield
        finally:
            _unlock(stream)


__all__ = ["InterProcessLockTimeout", "interprocess_lock"]
