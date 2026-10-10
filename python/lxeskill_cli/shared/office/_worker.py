"""Private launcher: wait until the host owns our process tree before starting Kit."""

import os
import sys

from .__main__ import main


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
    raise SystemExit(main())
