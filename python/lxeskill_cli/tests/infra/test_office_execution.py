"""Exercise real launcher/child/grandchild lifetimes without a production workbook."""

import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

import pytest

from shared.office.execution import run_kit_bounded


@pytest.fixture
def fake_kit(tmp_path, monkeypatch):
    cli = tmp_path / "中文 fake kit.py"
    # A Windows venv redirector has its own child cleanup. Use the base
    # interpreter to model Node without accidentally testing that cleanup.
    monkeypatch.setenv("LXE_OFFICE_NODE", sys._base_executable)
    monkeypatch.setenv("LXE_OFFICE_CLI", str(cli))
    source = str(Path(__file__).resolve().parents[2])
    monkeypatch.setenv("PYTHONPATH", os.pathsep.join(filter(None, [source, os.environ.get("PYTHONPATH", "")])))
    return cli


def test_bounded_kit_preserves_arguments_streams_and_sets_deadline(fake_kit):
    fake_kit.write_text(
        "import json,sys\nprint(json.dumps(sys.argv[1:]))\n"
        "print('actual Kit error',file=sys.stderr)\nsys.exit(7)\n", encoding="utf-8",
    )
    arguments = ["recalculate", "--input", "中文 input.xlsx", "--output", "输出 file.xlsx"]
    result = run_kit_bounded(arguments, timeout_seconds=300)
    assert result.returncode == 7
    assert json.loads(result.stdout) == [*arguments, "--timeout-ms", "300000"]
    assert result.stderr == "actual Kit error\n"


@pytest.mark.parametrize("timeout", [0, -1, float("nan"), float("inf"), 2_147_484])
def test_invalid_deadline_does_not_start_kit(fake_kit, timeout):
    fake_kit.write_text("raise AssertionError('must not execute')\n", encoding="utf-8")
    with pytest.raises(ValueError, match="timeout_seconds"):
        run_kit_bounded(["recalculate"], timeout_seconds=timeout)


def _tree_script(fake_kit):
    # The intermediate process either hangs or exits, while its child keeps
    # inherited pipes open (the timeout case subprocess.run cannot clean up).
    fake_kit.write_text('''import os,signal,subprocess,sys,time
from pathlib import Path
mode, directory = sys.argv[2:4]
root = Path(directory)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
if mode == "leaf":
    (root / "leaf.pid").write_text(str(os.getpid()))
    while True:
        (root / "heartbeat").write_text(str(time.monotonic_ns()))
        time.sleep(.02)
closed = mode == "exit-closed"
child = subprocess.Popen([sys.executable, __file__, "recalculate", "leaf", directory],
    stdout=subprocess.DEVNULL if closed else None, stderr=subprocess.DEVNULL if closed else None,
    close_fds=False)
(root / "kit.pid").write_text(str(os.getpid()))
deadline = time.monotonic() + 5
while not (root / "heartbeat").exists() and time.monotonic() < deadline:
    time.sleep(.01)
print("actual native diagnostic before timeout", file=sys.stderr, flush=True)
if mode.startswith("exit"):
    sys.exit(0)
while True: time.sleep(.02)
''', encoding="utf-8")


def _assert_heartbeat_stopped(path):
    assert path.exists(), "the descendant must actually have started"
    time.sleep(.1)  # Allow a process already scheduled at kill time to finish.
    saved = path.read_bytes()
    time.sleep(.15)
    assert path.read_bytes() == saved, "Office descendant remained alive after cleanup"


def _cleanup_fixture_children(directory):
    # If supervision regresses, do not leave the deliberately hostile fixtures running.
    for name in ("leaf.pid", "kit.pid"):
        path = directory / name
        if path.exists():
            try:
                os.kill(int(path.read_text()), signal.SIGTERM if os.name == "nt" else signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            except OSError as error:
                # OpenProcess reports ERROR_INVALID_PARAMETER for an exited PID.
                if os.name != "nt" or error.winerror != 87:
                    raise


@pytest.mark.parametrize("mode", ["hang", "exit-inherited", "exit-closed"])
def test_owns_descendants_even_after_intermediate_exit(fake_kit, tmp_path, mode, monkeypatch):
    _tree_script(fake_kit)
    if os.name == "nt" and mode == "exit-inherited":
        # The *worker's* venv redirector also reaps descendants on normal exit.
        # Bypass it here so the inherited-pipe timeout exercises our watchdog.
        monkeypatch.setattr(sys, "executable", sys._base_executable)
    start = time.monotonic()
    try:
        if mode == "exit-closed":
            result = run_kit_bounded(["recalculate", mode, str(tmp_path)], timeout_seconds=2, cleanup_seconds=.3)
            assert result.returncode == 0
        else:
            with pytest.raises(subprocess.TimeoutExpired) as error:
                run_kit_bounded(["recalculate", mode, str(tmp_path)], timeout_seconds=2, cleanup_seconds=.3)
            assert "actual native diagnostic" in error.value.stderr
        assert time.monotonic() - start < 6
        _assert_heartbeat_stopped(tmp_path / "heartbeat")
    finally:
        _cleanup_fixture_children(tmp_path)


@pytest.mark.skipif(os.name == "nt", reason="Windows relies on Kit's own deadline and the job fallback")
def test_timeout_allows_graceful_kit_cleanup(fake_kit, tmp_path):
    marker = tmp_path / "cleaned"
    fake_kit.write_text(
        "import signal,sys,time\nfrom pathlib import Path\n"
        "def stop(*_):\n"
        " Path(sys.argv[2]).write_text('cleaned')\n"
        " print('native abort diagnostic',file=sys.stderr)\n sys.exit(23)\n"
        "signal.signal(signal.SIGTERM,stop)\nwhile True: time.sleep(.02)\n", encoding="utf-8",
    )
    with pytest.raises(subprocess.TimeoutExpired) as error:
        run_kit_bounded(["recalculate", str(marker)], timeout_seconds=.5, cleanup_seconds=.3)
    assert marker.read_text() == "cleaned"
    assert "native abort diagnostic" in error.value.stderr


def test_cleanup_does_not_stop_an_unrelated_process(fake_kit, tmp_path):
    _tree_script(fake_kit)
    other = tmp_path / "unrelated"
    other.mkdir()
    process = subprocess.Popen(
        [sys._base_executable, str(fake_kit), "recalculate", "leaf", str(other)],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    try:
        with pytest.raises(subprocess.TimeoutExpired):
            run_kit_bounded(["recalculate", "hang", str(tmp_path)], timeout_seconds=2, cleanup_seconds=.3)
        _assert_heartbeat_stopped(tmp_path / "heartbeat")
        before = (other / "heartbeat").read_bytes()
        time.sleep(.1)
        assert process.poll() is None
        assert (other / "heartbeat").read_bytes() != before
    finally:
        process.kill()
        process.wait(timeout=5)
        _cleanup_fixture_children(tmp_path)


@pytest.mark.skipif(os.name == "nt", reason="POSIX signal cancellation; Windows is tested with kill-on-close below")
def test_cancelling_supervisor_cleans_its_private_session(fake_kit, tmp_path):
    _tree_script(fake_kit)
    process = subprocess.Popen([
        sys.executable, "-c",
        "from shared.office.execution import run_kit_bounded; import sys; "
        "run_kit_bounded(['recalculate','hang',sys.argv[1]],timeout_seconds=60,cleanup_seconds=.3)",
        str(tmp_path),
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 5
        while not (tmp_path / "heartbeat").exists() and time.monotonic() < deadline:
            time.sleep(.01)
        assert (tmp_path / "heartbeat").exists()
        process.send_signal(signal.SIGTERM)
        process.communicate(timeout=5)
        assert process.returncode == 143
        _assert_heartbeat_stopped(tmp_path / "heartbeat")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        _cleanup_fixture_children(tmp_path)


@pytest.mark.skipif(os.name != "nt", reason="Uses native Windows job ownership")
def test_missing_job_does_not_start_kit(fake_kit, tmp_path):
    import uuid
    marker = tmp_path / "started"
    fake_kit.write_text("import sys\nfrom pathlib import Path\nPath(sys.argv[2]).touch()\n", encoding="utf-8")

    result = subprocess.run([
        sys.executable, "-m", "shared.office._worker", "--windows-job", f"Local\\missing-{uuid.uuid4()}",
        "recalculate", str(marker),
    ], input="1", capture_output=True, text=True, timeout=5)
    assert result.returncode != 0 and "WinError" in result.stderr
    assert not marker.exists()


@pytest.mark.skipif(os.name != "nt", reason="Uses native Windows kill-on-close")
def test_killing_windows_supervisor_closes_job_and_kills_descendants(fake_kit, tmp_path):
    _tree_script(fake_kit)
    process = subprocess.Popen([
        sys._base_executable, "-c",
        "from shared.office.execution import run_kit_bounded; import sys; "
        "run_kit_bounded(['recalculate','hang',sys.argv[1]],timeout_seconds=60,cleanup_seconds=.3)",
        str(tmp_path),
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 5
        while not (tmp_path / "heartbeat").exists() and time.monotonic() < deadline:
            time.sleep(.01)
        assert (tmp_path / "heartbeat").exists()
        process.kill()
        process.communicate(timeout=5)
        _assert_heartbeat_stopped(tmp_path / "heartbeat")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        _cleanup_fixture_children(tmp_path)
