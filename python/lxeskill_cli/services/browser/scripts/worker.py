"""Own the paired driver and bounded JS/Python invocation for installed scripts."""

from __future__ import annotations

import json
import runpy
import subprocess
import sys
import time
from contextlib import contextmanager, redirect_stdout
from pathlib import Path
from uuid import uuid4

from services.browser.browser.selenium_runner import SeleniumRunner
from services.browser.core.driver_binary import driver_folder_path
from services.browser.store.store_driver_session import store_lock
from services.browser.store.ziniao_browser_client import ZiniaoBrowserClient
from services.browser.tools.driver_session import (
    detach_driver,
    select_first_normal_tab,
    select_unique_host_tab,
)
from shared.bounded_worker import enter_worker
from shared.process_lock import InterProcessLockTimeout

from .page import BrowserOperations


def running_info(client, store_id: str) -> dict:
    # Query the control API directly. The lifecycle client's discovery methods
    # can start a client or a store, which would replace the script's page.
    catalog = next((row for row in client.get_browser_list() if row.get("browserOauth") == store_id), None)
    if catalog is None:
        raise ValueError(f"Unknown browser store: {store_id}")
    matches = []
    for row in client.get_running_info():
        if row.get("browserOauth"):
            match = row["browserOauth"] == store_id
        else:
            match = bool(row.get("browserId")) and str(row["browserId"]) == str(catalog.get("browserId"))
        if match:
            matches.append(row)
    if len(matches) != 1:
        raise RuntimeError(f"Expected one running browser for {store_id}, found {len(matches)}")
    info = matches[0]
    for key in ("debuggingPort", "browserPath", "downloadPath"):
        if not info.get(key):
            raise RuntimeError(f"getRunningInfo is missing {key}")
    return info


@contextmanager
def running_browser(store_id: str, *, target_host: str = "", target_handle: str = ""):
    with store_lock(store_id, timeout_seconds=0):
        info = running_info(ZiniaoBrowserClient().client, store_id)
        driver = SeleniumRunner(driver_folder_path()).get_driver(info)
        try:
            if target_host:
                select_unique_host_tab(driver, target_host, target_handle=target_handle)
            else:
                select_first_normal_tab(driver)
            yield driver, Path(info["downloadPath"])
        finally:
            detach_driver(driver)


def run_control(node: str, script: str, params: dict, operations: BrowserOperations):
    token = uuid4().hex
    marker = f"\x1e{token}\x1e"
    command = [node, str(Path(__file__).with_name("control.mjs")), token]
    with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          encoding="utf-8", errors="strict") as process:
        def send(data):
            process.stdin.write(json.dumps(data, allow_nan=False) + "\n")
            process.stdin.flush()

        try:
            send({"script": script, "params": params})
            for line in process.stdout:
                log, separator, record = line.partition(marker)
                if log:
                    sys.stderr.write(log)
                if not separator:
                    continue
                frame = json.loads(record)
                if frame.get("done") is True:
                    if "error" in frame:
                        raise RuntimeError(frame["error"])
                    return frame["result"]
                try:
                    value = operations.execute(frame["method"], frame["args"])
                    response = {"result": value}
                except Exception as exc:
                    response = {"error": f"{type(exc).__name__}: {exc}"}
                send(response)
            raise RuntimeError(f"Node exited with code {process.wait()} without a result")
        finally:
            if process.poll() is None:
                process.kill()


def main(request: dict) -> dict:
    deadline = time.monotonic() + request["timeout"]
    target = {key: request[key] for key in ("target_host", "target_handle") if key in request}
    with running_browser(request["store_id"], **target) as (driver, downloads):
        operations = BrowserOperations(driver, downloads=downloads, output=Path(request["output"]),
                                       deadline=deadline, store_id=request["store_id"],
                                       session_id=request.get("session_id", ""),
                                       state_directory=Path(request.get("state_directory", request["output"])))
        if Path(request["script"]).suffix.lower() == ".py":
            # The existing supervised worker owns the connection and lifetime.
            # Add only the installed script's directory for its sibling modules.
            sys.path.insert(0, str(Path(request["script"]).parent))
            try:
                with redirect_stdout(sys.stderr):
                    namespace = runpy.run_path(request["script"])
                    result = namespace["run"](operations, request["params"])
            finally:
                sys.path.pop(0)
        else:
            result = run_control(request["node"], request["script"], request["params"], operations)
        return {"ok": True, "result": result, "downloads": operations.downloaded_files,
                "screenshots": operations.screenshots}


if __name__ == "__main__":
    enter_worker()
    try:
        reply = main(json.loads(sys.stdin.buffer.read()))
    except Exception as error:
        code = "store_busy" if isinstance(error, InterProcessLockTimeout) else "script_failed"
        reply = {"ok": False, "code": code, "error": f"{type(error).__name__}: {error}"}
    print(json.dumps(reply, allow_nan=False))
    raise SystemExit(0 if reply["ok"] else 1)
