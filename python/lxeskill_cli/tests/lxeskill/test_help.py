from __future__ import annotations

import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

import pytest
from lxeskill import cli
from lxeskill.business import load_catalog
from lxeskill.help import BUILTINS


@pytest.mark.parametrize('arguments', [
    [], ['--help'], ['-h'], ['help'], ['help', 'fba'], ['help', 'replenishment'],
    ['help', 'operations'], ['help', 'common'], ['mabang', '--help'], ['mabang', 'delivery', '--help'],
    ['mabang', 'delivery', 'export', '--help'], ['mabang', 'delivery', 'export', '--delivery-no', 'SP1', '--help'],
    *[[*name.split(), '--help'] for name in BUILTINS],
    ['datasets', '--help'], ['help', 'mabang', 'delivery', 'export'],
])
def test_help_never_initializes_runtime_or_executes_business(arguments, monkeypatch, capsys):
    def forbidden(*args, **kwargs):
        pytest.fail('help must not initialize workspace/logging, execute business or contact a server')
    for name in ['activate_project_workspace', 'setup_logging', '_run_entry', '_run_doctor']:
        monkeypatch.setattr(cli, name, forbidden)
    monkeypatch.delenv('MABANG_ACCOUNT', raising=False)
    monkeypatch.delenv('MABANG_PASSWORD', raising=False)
    assert cli.main(arguments) == 0
    result = capsys.readouterr()
    assert result.out.strip()
    assert not result.err


@pytest.mark.parametrize('group,expected,excluded', [
    ('fba', ['mabang delivery export', 'fba customs fill'], ['mabang store msku export']),
    ('replenishment', ['mabang store msku export', 'yacang reports export', 'shangman login prepare'], ['mabang delivery export']),
    ('operations', ['amazon listing analyze', 'amazon reviews analyze'], ['mabang delivery export']),
])
def test_business_navigation_keeps_collection_with_its_business(group, expected, excluded, capsys):
    assert cli.main(['help', group]) == 0
    output = capsys.readouterr().out
    for command in expected:
        assert command in output
    for command in excluded:
        assert command not in output
    assert 'synthetic-performer' not in output
    assert 'replenishment settings' not in output


def test_catalog_help_examples_are_valid_command_line_arguments():
    # These parse examples without executing any business command or accessing accounts.
    for entry in load_catalog().values():
        info = entry['help']
        assert info['group'] in {'fba', 'replenishment', 'operations', 'common'}
        assert info['summary'] and info['examples']
        for example in info['examples']:
            words = shlex.split(example)
            assert words[:1 + len(entry['command_path'])] == ['lxeskill', *entry['command_path']]
            arguments = cli._arguments_from_flags(entry, words[1 + len(entry['command_path']):])
            assert set(entry['input_schema'].get('required', [])) <= arguments.keys()
            for name, value in arguments.items():
                field = entry['input_schema']['properties'][name]
                if 'enum' in field:
                    assert value in field['enum']


def test_unknown_help_target_is_error_and_internal_help_remains_explicit(capsys):
    assert cli.main(['mabang', 'missing', '--help']) == cli.EXIT_USAGE
    assert json.loads(capsys.readouterr().out)['error']['code'] == 'unknown_command'
    assert cli.main(['vietnam', 'replenishment', 'settings', '--help']) == 0
    assert capsys.readouterr().out.strip()


def test_help_and_discovery_work_without_a_writable_data_root(tmp_path):
    blocked = tmp_path / 'not-a-directory'
    blocked.write_text('sentinel')
    workspace = tmp_path / 'workspace'
    workspace.mkdir()
    env = {**os.environ, 'LXE_DATA_ROOT': str(blocked), 'LXE_WORKSPACE_ROOT': str(workspace),
           'LOCAL_LOGS_ENABLED': '1', 'PYTHONDONTWRITEBYTECODE': '1', 'MABANG_ACCOUNT': '', 'MABANG_PASSWORD': ''}
    for arguments in [['--help'], ['help', 'fba'], ['mabang', '--help'], ['doctor', '--help'],
                      ['mabang', 'delivery', 'export', '--help'], ['list'], ['describe', 'mabang', 'delivery', 'export'], ['datasets', 'list']]:
        result = subprocess.run([sys.executable, '-B', '-m', 'lxeskill', *arguments], env=env,
                                cwd=workspace, text=True, capture_output=True, encoding='utf-8', timeout=15)
        assert result.returncode == 0, result.stderr
        assert result.stdout
        assert result.stderr == ''
    assert list(workspace.iterdir()) == []
    assert blocked.read_text() == 'sentinel'


@pytest.mark.parametrize('arguments', [['help', '--help'], ['replenish', 'template', 'list', '--help']])
def test_help_command_and_positional_arguments_are_not_executed(arguments, monkeypatch, capsys):
    monkeypatch.setattr(cli, '_run_entry', lambda *args: pytest.fail('help cannot execute'))
    assert cli.main(arguments) == 0
    assert 'lxeskill' in capsys.readouterr().out
