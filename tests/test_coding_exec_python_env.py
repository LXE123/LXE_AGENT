from __future__ import annotations

import asyncio
import os

import pytest

from agent_runtime.tools import coding_tools
from agent_runtime.tools.process_sessions import (
    clear_exec_sessions_for_tests,
    decode_process_output,
    run_exec_command,
)


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


def test_decode_process_output_falls_back_to_gbk():
    assert decode_process_output("临时文件".encode("gbk")) == "临时文件"


def test_exec_windows_rejects_redundant_powershell_command(monkeypatch):
    monkeypatch.setattr(coding_tools.os, "name", "nt")

    with pytest.raises(coding_tools.ToolExecutionError) as exc_info:
        coding_tools._reject_redundant_windows_powershell_command(
            'powershell -NoProfile -Command "Get-Date"'
        )

    message = str(exc_info.value)
    assert "已经在 PowerShell 中" in message
    assert "只传 PowerShell 脚本体" in message
    assert "修复示例: Get-Date" in message


def test_exec_windows_rejects_redundant_pwsh_c(monkeypatch):
    monkeypatch.setattr(coding_tools.os, "name", "nt")

    with pytest.raises(coding_tools.ToolExecutionError, match="powershell/pwsh -Command"):
        coding_tools._reject_redundant_windows_powershell_command('pwsh -c "Get-Date"')


def test_exec_windows_rejects_redundant_encoded_command(monkeypatch):
    monkeypatch.setattr(coding_tools.os, "name", "nt")

    with pytest.raises(coding_tools.ToolExecutionError, match="EncodedCommand"):
        coding_tools._reject_redundant_windows_powershell_command(
            "powershell.exe -EncodedCommand RwBlAHQALQBEAGEAdABlAA=="
        )


def test_exec_windows_allows_direct_powershell_body(monkeypatch):
    monkeypatch.setattr(coding_tools.os, "name", "nt")

    coding_tools._reject_redundant_windows_powershell_command("Get-Date")


def test_exec_windows_allows_powershell_file(monkeypatch):
    monkeypatch.setattr(coding_tools.os, "name", "nt")

    coding_tools._reject_redundant_windows_powershell_command(
        r"powershell -File scripts\foo.ps1"
    )


def test_exec_windows_does_not_reject_powershell_text_inside_command(monkeypatch):
    monkeypatch.setattr(coding_tools.os, "name", "nt")

    coding_tools._reject_redundant_windows_powershell_command(
        'Write-Output "powershell -Command Get-Date"'
    )


def test_exec_redundant_powershell_check_is_windows_only(monkeypatch):
    monkeypatch.setattr(coding_tools.os, "name", "posix")

    coding_tools._reject_redundant_windows_powershell_command(
        'powershell -Command "Get-Date"'
    )


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


@pytest.mark.skipif(os.name != "nt", reason="PowerShell exec behavior is Windows-only")
def test_exec_windows_powershell_chinese_output_is_readable():
    payload = _run_exec('Write-Output "临时文件"')

    assert payload["status"] == "completed"
    assert "临时文件" in str(payload.get("output") or "")


@pytest.mark.skipif(os.name != "nt", reason="PowerShell exec behavior is Windows-only")
def test_exec_windows_powershell_object_formatting_stays_readable():
    payload = _run_exec(
        r'[PSCustomObject]@{Type="临时文件"; Path="C:\Temp"} | Format-Table -AutoSize'
    )

    output = str(payload.get("output") or "")
    assert payload["status"] == "completed"
    assert "Type" in output
    assert "Path" in output
    assert "临时文件" in output
    assert r"C:\Temp" in output


@pytest.mark.skipif(os.name != "nt", reason="PowerShell exec behavior is Windows-only")
def test_exec_windows_python_chinese_output_is_readable():
    payload = _run_exec('python -c "print(\'临时文件\')"')

    assert payload["status"] == "completed"
    assert "临时文件" in str(payload.get("output") or "")


@pytest.mark.skipif(os.name != "nt", reason="PowerShell exec behavior is Windows-only")
def test_exec_windows_powershell_stderr_chinese_is_readable_and_fails():
    payload = _run_exec('Write-Error "错误信息"')

    output = str(payload.get("output") or "")
    assert payload["status"] == "failed"
    assert payload["exit_code"] != 0
    assert "错误信息" in output


@pytest.mark.skipif(os.name != "nt", reason="PowerShell exec behavior is Windows-only")
def test_exec_windows_native_exit_code_is_preserved():
    payload = _run_exec("cmd /c exit 7")

    assert payload["status"] == "failed"
    assert payload["exit_code"] == 7


@pytest.mark.skipif(os.name != "nt", reason="PowerShell exec behavior is Windows-only")
def test_exec_windows_stale_last_exit_code_does_not_poison_success():
    payload = _run_exec('cmd /c exit 7; Write-Output "ok"')

    assert payload["status"] == "completed"
    assert payload["exit_code"] == 0
    assert "ok" in str(payload.get("output") or "")


@pytest.mark.skipif(os.name != "nt", reason="PowerShell exec behavior is Windows-only")
def test_exec_windows_powershell_command_failure_returns_nonzero():
    payload = _run_exec("Get-NotARealCommand")

    assert payload["status"] == "failed"
    assert payload["exit_code"] != 0


def test_exec_injects_agent_session_env():
    payload = _run_exec(
        'python -c "import os; print(os.environ.get(\'LXE_AGENT_SESSION_ID\', \'\'))"',
        owner_session_id="session_for_test",
    )

    assert payload["status"] == "completed"
    assert "session_for_test" in str(payload.get("output") or "")


def test_exec_injects_response_route_env():
    payload = _run_exec(
        'python -c "import os; print(os.environ.get(\'LXE_RESPONSE_ROUTE_ID\', \'\'))"',
        response_route_id="route_for_test",
    )

    assert payload["status"] == "completed"
    assert "route_for_test" in str(payload.get("output") or "")


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
