import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from lxeskill import cli
from services.browser.scripts import command, worker
from services.browser.scripts.page import BrowserOperations


class FixtureDriver:
    """Execute the actual Selenium script body in a fresh JS realm per call."""
    def __init__(self, downloads):
        self.downloads = downloads
        self.url = ""
        self.uploaded = ""

    def get(self, url):
        self.url = url

    def set_page_load_timeout(self, seconds):
        assert seconds > 0

    set_script_timeout = set_page_load_timeout

    def execute_script(self, source, selector):
        assert "deepQuerySelectorAll" in source and selector == "#upload"
        return [SimpleNamespace(send_keys=lambda path: setattr(self, "uploaded", path))]

    def execute_async_script(self, source, params):
        payload = json.dumps(dict(source=source, params=params, url=self.url))
        program = """
const { source, params, url } = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
global.document = { querySelector: () => ({ textContent: url }) };
new Function(source)(params, value => process.stdout.write(JSON.stringify(value)));
"""
        output = subprocess.run(["node", "-e", program], input=payload, text=True,
                                capture_output=True, check=True, timeout=5)
        return json.loads(output.stdout)


def test_control_runs_across_pages_and_returns_archived_download(tmp_path, capfd):
    downloads = tmp_path / "download"
    downloads.mkdir()
    (downloads / "old.txt").write_text("old")
    (downloads / "incomplete.crdownload").touch()
    script = tmp_path / "控制 脚本.js"
    script.write_text("""
console.log("controller diagnostic");
const {execFileSync} = await import("node:child_process");
execFileSync(process.execPath, ["-e", "process.stdout.write('child diagnostic')"], {stdio: ["ignore", "inherit", "inherit"]});
await browser.navigate(params.first);
const first = await browser.evaluate(() => deepQuerySelector("span").textContent);
await browser.navigate(params.second);
const second = await browser.runScriptFile("./页面.js", {message: params.message});
await browser.uploadFile("#upload", "./上传.txt");
const path = await browser.download(async () => {
  const fs = await import("node:fs/promises");
  await fs.writeFile(params.newDownload, "report contents");
});
return { first, second, path };
""", encoding="utf-8")
    (tmp_path / "页面.js").write_text(
        'await Promise.resolve(); return [document.querySelector("span").textContent, params.message];',
        encoding="utf-8")
    (tmp_path / "上传.txt").touch()
    driver = FixtureDriver(downloads)
    operations = BrowserOperations(driver, downloads=downloads, output=tmp_path, deadline=time.monotonic() + 20)
    result = worker.run_control(shutil.which("node"), str(script),
                                dict(first="A", second="B", message="中文", newDownload=str(downloads / "r.txt")),
                                operations)
    assert result == dict(first="A", second=["B", "中文"], path=operations.downloaded_files[0])
    assert driver.uploaded == str(tmp_path / "上传.txt")
    assert Path(result["path"]).read_text() == "report contents"
    assert Path(result["path"]).parent != downloads
    log = capfd.readouterr().err
    assert "controller diagnostic" in log and "child diagnostic" in log


@pytest.mark.parametrize(("body", "error"), [
    ("await browser.evaluate(() => { throw new Error('page failure xyz') })", "page failure xyz"),
    ("return await browser.evaluate(() => ({ n: Infinity }))", "cannot be represented as JSON"),
    ("return 1n", "cannot be represented as JSON"),
    ("return myMissingVariable", "myMissingVariable is not defined"),
    ("process.exit(7)", "exited with code 7"),
])
def test_control_preserves_actual_error(tmp_path, body, error):
    script = tmp_path / "workflow.js"
    script.write_text(body)
    ops = BrowserOperations(FixtureDriver(tmp_path), downloads=tmp_path, output=tmp_path,
                            deadline=time.monotonic() + 10)
    with pytest.raises(RuntimeError, match=error):
        worker.run_control(shutil.which("node"), str(script), {}, ops)


def test_ambiguous_download_does_not_deliver_an_unrelated_file(tmp_path):
    ops = BrowserOperations(None, downloads=tmp_path, output=tmp_path, deadline=time.monotonic() + 10)
    ops.execute("beginDownload", {})
    (tmp_path / "a.csv").touch()
    (tmp_path / "b.csv").touch()
    with pytest.raises(ValueError, match="a.csv, b.csv"):
        ops.execute("finishDownload", {})
    assert not ops.downloaded_files


def test_bad_webdriver_screenshot_is_not_published(tmp_path):
    driver = SimpleNamespace(get_screenshot_as_png=lambda: b"")
    ops = BrowserOperations(driver, downloads=tmp_path, output=tmp_path, deadline=time.monotonic() + 10)
    with pytest.raises(ValueError, match="PNG signature"):
        ops.execute("screenshot", {})
    assert not ops.screenshots
    assert not list(tmp_path.glob("*.png"))


def test_strict_attachment_uses_only_live_info_and_never_starts_browser(monkeypatch):
    rows = []
    client = SimpleNamespace(get_browser_list=lambda: [{"browserOauth": "abc", "browserId": 7}],
                             get_running_info=lambda: rows)
    monkeypatch.setattr(worker, "ZiniaoBrowserClient", lambda: SimpleNamespace(client=client))
    from contextlib import nullcontext
    monkeypatch.setattr(worker, "store_lock", lambda *args, **kwargs: nullcontext())
    with pytest.raises(RuntimeError, match="found 0"):
        with worker.running_browser("abc"):
            pytest.fail("Closed store attached")
    rows.append({"browserId": 7, "browserPath": "path", "debuggingPort": 1234, "downloadPath": "/tmp"})
    calls = []
    def attach(self, info):
        calls.append(info)
        raise RuntimeError("driver diagnostic abc")
    monkeypatch.setattr(worker.SeleniumRunner, "get_driver", attach)
    with pytest.raises(RuntimeError, match="driver diagnostic abc"):
        with worker.running_browser("abc"):
            pytest.fail("Broken driver attached")
    assert calls == rows


def test_cli_rejects_mode_and_invalid_timeout_before_connecting(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("LXE_AGENT_SESSION_ID", "test")
    monkeypatch.setenv("LXE_WORKSPACE_ROOT", str(tmp_path))
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path))
    args = ["browser", "script", "run", "--store-id", "fixture", "--script-file", "file.js"]
    assert cli.main([*args, "--mode", "page"]) != 0
    assert "unknown option: --mode" in json.loads(capsys.readouterr().out)["error"]["message"]
    assert cli.main([*args, "--timeout-sec", "0"]) != 0
    assert "timeout_sec" in json.loads(capsys.readouterr().out)["error"]["message"]


def test_cli_worker_envelope_and_store_busy(tmp_path):
    # Inject only the external client and driver into the gated worker. Exercise
    # the installed entry point, real lock, supervisor, and Node protocol together.
    (tmp_path / "sitecustomize.py").write_text('''
import sys
if "services.browser.scripts.worker" in sys.orig_argv:
    from pathlib import Path
    from types import SimpleNamespace as Obj
    from services.browser.store.ziniao_browser_client import ZiniaoBrowserClient
    from services.browser.browser.selenium_runner import SeleniumRunner
    info = dict(browserOauth="fixture", browserId=7, debuggingPort=1,
                browserPath="fixture", downloadPath=str(Path.cwd()))
    ZiniaoBrowserClient.client = property(lambda self: Obj(
        get_browser_list=lambda: [info], get_running_info=lambda: [info]))
    SeleniumRunner.get_driver = lambda self, info: Obj(window_handles=["test"], current_window_handle="test",
        current_url="https://fixture.invalid/", title="Fixture", switch_to=Obj(window=lambda handle: None),
        get_screenshot_as_png=lambda: Path("viewport.png").read_bytes())
''')
    viewport = tmp_path / "viewport.png"
    Image.new("RGB", (12, 8), color="blue").save(viewport)
    script = tmp_path / "控制 脚本.js"
    script.write_text("""
console.log('control stderr');
const first = await browser.screenshot();
const second = await browser.screenshot();
if (params.download) {
  const fs = await import('node:fs/promises');
  await browser.download(() => fs.copyFile('viewport.png', 'download.png'));
}
return { value: params.value, first, second };
""", encoding="utf-8")
    params = tmp_path / "参数.json"
    params.write_text(json.dumps({"value": "中文"}), encoding="utf-8")
    env = {**os.environ, "LXE_AGENT_SESSION_ID": "test", "LXE_DATA_ROOT": str(tmp_path),
           "LXE_WORKSPACE_ROOT": str(tmp_path), "PYTHONPATH": str(tmp_path),
           "PYTHONIOENCODING": "utf-8"}
    def invoke():
        run = subprocess.run([sys.executable, "-m", "lxeskill.cli", "browser", "script", "run",
                              "--store-id", "fixture", "--script-file", script.name,
                              "--params-file", params.name], cwd=tmp_path, env=env,
                             capture_output=True, encoding="utf-8", timeout=15)
        return run, json.loads(run.stdout)

    run, record = invoke()
    assert run.returncode == 0 and record["ok"], (record, run.stderr)
    result = record["data"]["result"]
    assert result["value"] == "中文"
    shots = [result["first"], result["second"]]
    assert shots[0] != shots[1]
    assert record["data"]["screenshots"] == record["files"] == shots
    assert record["data"]["downloads"] == []
    for path in shots:
        assert Path(path).is_absolute() and Path(path).suffix == ".png"
        assert Path(path).read_bytes() == viewport.read_bytes()
    assert "control stderr" in run.stderr
    params.write_text(json.dumps({"value": "中文", "download": True}), encoding="utf-8")
    run, record = invoke()
    assert run.returncode == 0 and record["ok"], (record, run.stderr)
    downloads = record["data"]["downloads"]
    assert len(downloads) == 1 and Path(downloads[0]).name == "download.png"
    assert len(record["data"]["screenshots"]) == 2
    assert record["files"] == downloads + record["data"]["screenshots"]
    from services.browser.store.store_driver_session import store_lock
    with pytest.MonkeyPatch.context() as environment:
        environment.setenv("LXE_DATA_ROOT", str(tmp_path))
        with store_lock("fixture"):
            run, record = invoke()
    assert run.returncode != 0 and record["error"]["code"] == "store_busy"


def test_deadline_reaps_real_control_script_and_releases_lock(tmp_path, monkeypatch):
    # The deadline must also bound a busy Node loop between browser calls.
    (tmp_path / "fixture_worker.py").write_text("""
import json, sys
from contextlib import contextmanager
from pathlib import Path
from services.browser.scripts import worker
from services.browser.store.store_driver_session import store_lock
from shared.bounded_worker import enter_worker
enter_worker()
request = json.loads(sys.stdin.buffer.read())
@contextmanager
def fixture_browser(store_id):
    with store_lock(store_id):
        yield None, Path('.')
worker.running_browser = fixture_browser
worker.main(request)
""")
    script = tmp_path / "loop.js"
    script.write_text("""
const fs = await import('node:fs');
fs.writeFileSync(params.marker, "running");
while (true) {
  const now = new Date();
  fs.utimesSync(params.marker, now, now);
}
""")
    marker = tmp_path / "heartbeat"
    params = tmp_path / "params.json"
    params.write_text(json.dumps({"marker": str(marker)}))
    monkeypatch.setenv("PYTHONPATH", str(tmp_path))
    monkeypatch.setenv("LXE_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr(command, "dataset_dir", lambda *p: tmp_path / "outputs")
    original = command.run_worker
    monkeypatch.setattr(command, "run_worker", lambda _, *a, **kw: original("fixture_worker", *a, **kw))
    with pytest.raises(command.ScriptFailure, match="exceeded 2s"):
        command.run_script(dict(store_id="fixture", script_file=str(script),
                                params_file=str(params), timeout_sec=2), "test")
    assert marker.stat().st_size
    last_change = marker.stat().st_mtime_ns
    time.sleep(.1)
    assert marker.stat().st_mtime_ns == last_change
    assert list((tmp_path / "outputs").iterdir()) == []
    from services.browser.store.store_driver_session import store_lock
    with store_lock("fixture", timeout_seconds=0):
        pass
