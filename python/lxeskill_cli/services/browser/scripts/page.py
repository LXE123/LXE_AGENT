from __future__ import annotations

import json
import shutil
import time
from pathlib import Path
from typing import Any
from uuid import uuid4

from services.browser.browser.actions import _is_incomplete_download, save_screenshot
from services.browser.browser.shadow_dom import SHADOW_DOM_HELPERS_JS


def download_snapshot(directory: Path) -> dict[str, tuple[int, int]]:
    snapshot = {}
    for entry in directory.iterdir():
        if entry.is_symlink():
            continue
        try:
            if entry.is_file():
                stat = entry.stat()
                snapshot[entry.name] = stat.st_mtime_ns, stat.st_size
        except FileNotFoundError:
            # Browsers rename temporary files while the directory is being read.
            continue
    return snapshot


class BrowserOperations:
    def __init__(self, driver, *, downloads: Path, output: Path, deadline: float):
        self.driver = driver
        self.downloads = downloads
        self.output = output
        self.deadline = deadline
        self.downloaded_files: list[str] = []
        self.screenshots: list[str] = []
        self.baseline: dict[str, tuple[int, int]] | None = None

    def remaining(self) -> float:
        seconds = self.deadline - time.monotonic()
        if seconds <= 0:
            raise TimeoutError("Browser script deadline exceeded")
        return seconds

    def execute(self, method: str, args: dict[str, Any]) -> Any:
        seconds = self.remaining()
        if method == "navigate":
            self.driver.set_page_load_timeout(seconds)
            self.driver.get(args["url"])
        elif method == "screenshot":
            path = save_screenshot(self.driver, self.output, prefix=f"page-{len(self.screenshots) + 1}")
            self.screenshots.append(path)
            return path
        elif method == "evaluate":
            self.driver.set_script_timeout(seconds)
            reply = self.driver.execute_async_script(SHADOW_DOM_HELPERS_JS + args["source"], args["params"])
            if "error" in reply:
                raise RuntimeError(reply["error"])
            return json.loads(reply["json"])
        elif method == "upload":
            path = Path(args["path"]).resolve(strict=True)
            if not path.is_file():
                raise ValueError(f"Expected a regular file: {path}")
            elements = self.driver.execute_script(
                SHADOW_DOM_HELPERS_JS + "return deepQuerySelectorAll(arguments[0]).filter("
                "el => el.tagName === 'INPUT' && el.type === 'file');", args["selector"])
            if len(elements) != 1:
                raise ValueError(f"Expected one file input for {args['selector']!r}, found {len(elements)}")
            elements[0].send_keys(str(path))
        elif method == "beginDownload":
            if self.baseline is not None:
                raise ValueError("Another download is in progress")
            self.baseline = download_snapshot(self.downloads)
        elif method == "finishDownload":
            return self._finish_download()
        elif method == "endDownload":
            self.baseline = None
        else:
            raise ValueError(f"Unknown browser method: {method}")
        return None

    def _finish_download(self) -> str:
        if self.baseline is None:
            raise ValueError("Missing download baseline")
        previous = None
        while True:
            remaining = self.remaining()
            current = download_snapshot(self.downloads)
            changed = {name: stat for name, stat in current.items() if self.baseline.get(name) != stat}
            completed = [name for name in changed if not _is_incomplete_download(name)]
            if len(completed) > 1:
                raise ValueError(f"Multiple download candidates: {', '.join(sorted(completed))}")
            if len(completed) == len(changed) == 1 and changed == previous:
                name = completed[0]
                target = self.output / uuid4().hex / name
                target.parent.mkdir()
                shutil.copyfile(self.downloads / name, target)
                self.downloaded_files.append(str(target))
                return str(target)
            previous = changed
            time.sleep(min(0.5, remaining))
