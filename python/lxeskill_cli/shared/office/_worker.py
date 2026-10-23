"""Private launcher: wait until the host owns our process tree before starting Kit."""

import os
import sys

from ._runtime import run_kit


if __name__ == "__main__":
    if sys.stdin.buffer.read(1) != b"1":
        raise SystemExit("Office supervisor closed the start gate")
    if sys.argv[1:2] == ["--windows-job"]:
        from ._windows_job import OfficeJob

        # Join from the actual interpreter, not the Windows venv redirector.
        # No child can start before this succeeds; keep no inheritable job handle.
        job = OfficeJob(existing_name=sys.argv[2])
        try:
            job.assign(os.getpid())
        finally:
            job.close()
        del sys.argv[1:3]
    try:
        code = run_kit(sys.argv[1:])
    except (OSError, ValueError) as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        code = 1
    raise SystemExit(code)
