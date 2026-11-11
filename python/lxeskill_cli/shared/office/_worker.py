"""Private launcher: wait until the host owns our process tree before starting Kit."""

import sys

from shared.bounded_worker import enter_worker

from ._runtime import run_kit


if __name__ == "__main__":
    enter_worker()
    try:
        code = run_kit(sys.argv[1:])
    except (OSError, ValueError) as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        code = 1
    raise SystemExit(code)
