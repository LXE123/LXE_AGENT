from __future__ import annotations

import asyncio
import os

import pytest

from agent_runtime.tools import coding_tools
from agent_runtime.tools.process_sessions import clear_exec_sessions_for_tests, run_exec_command


def _expected_project_python() -> str:
    if os.name == "nt":
        executable = coding_tools.WORKSPACE_ROOT / ".venv" / "Scripts" / "python.exe"
        return f'& "{executable}"'
    else:
        executable = coding_tools.WORKSPACE_ROOT / ".venv" / "bin" / "python"
        return f'"{executable}"'


def _run_exec(command: str, **kwargs):
    async def _run():
        try:
            return await run_exec_command(
                command=command,
                cwd=str(coding_tools.WORKSPACE_ROOT),
                timeout=10,
                yield_ms=10_000,
                **kwargs,
            )
        finally:
            await clear_exec_sessions_for_tests()

    return asyncio.run(_run())


def test_exec_normalizes_python_launchers_to_project_venv():
    assert (
        coding_tools._normalize_project_python_command("python3 -m services.example")
        == f"{_expected_project_python()} -m services.example"
    )
    assert (
        coding_tools._normalize_project_python_command("python -m services.example")
        == f"{_expected_project_python()} -m services.example"
    )
    assert (
        coding_tools._normalize_project_python_command("pip install aiohttp")
        == f"{_expected_project_python()} -m pip install aiohttp"
    )


def test_exec_rejects_wrong_project_python_version():
    with pytest.raises(RuntimeError, match="项目只允许使用 .venv Python"):
        coding_tools._normalize_project_python_command("py -3.11 -m services.example")


def test_exec_child_env_prefers_project_venv_for_bare_python():
    payload = _run_exec('python -c "import sys; print(sys.prefix)"')

    assert payload["status"] == "completed"
    assert ".venv" in str(payload.get("output") or "")


def test_exec_runs_normalized_python_command():
    normalized = coding_tools._normalize_project_python_command(
        'python -c "import sys; print(sys.prefix)"'
    )
    payload = _run_exec(normalized)

    assert payload["status"] == "completed"
    assert ".venv" in str(payload.get("output") or "")


@pytest.mark.skipif(os.name != "nt", reason="PowerShell exec behavior is Windows-only")
def test_exec_windows_powershell_herestring_preserves_multiline_tsv():
    command = """$inputText = @'
A\tB\tC
D\tE\tF
'@
python -c "import sys; value = sys.argv[1]; print(len(value.splitlines())); print('TAB=' + str(chr(9) in value))" $inputText
"""

    payload = _run_exec(command)

    assert payload["status"] == "completed"
    output = str(payload.get("output") or "")
    assert "2" in output
    assert "TAB=True" in output


def test_exec_injects_agent_session_env():
    payload = _run_exec(
        'python -c "import os; print(os.environ.get(\'LXE_AGENT_SESSION_ID\', \'\'))"',
        owner_session_id="session_for_test",
    )

    assert payload["status"] == "completed"
    assert "session_for_test" in str(payload.get("output") or "")


def test_exec_does_not_rewrite_uv_run_commands():
    command = 'uv run --frozen python -c "print(\'uv-ok\')"'

    assert coding_tools._normalize_project_python_command(command) == command
    payload = _run_exec(command)

    assert payload["status"] == "completed"
    assert "uv-ok" in str(payload.get("output") or "")


@pytest.mark.skipif(os.name != "nt", reason="cmd /c compatibility path is Windows-only")
def test_exec_windows_allows_explicit_cmd_syntax():
    payload = _run_exec("cmd /c echo cmd-ok")

    assert payload["status"] == "completed"
    assert "cmd-ok" in str(payload.get("output") or "")


def test_exec_nonzero_exit_code_fails_with_output():
    payload = _run_exec('python -c "import sys; print(\'before-exit\'); sys.exit(7)"')

    assert payload["status"] == "failed"
    assert payload["exit_code"] == 7
    assert "before-exit" in str(payload.get("output") or "")
