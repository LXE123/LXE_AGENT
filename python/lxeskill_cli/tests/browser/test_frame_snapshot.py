from __future__ import annotations

import copy
import json
import shutil
import subprocess
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from services.browser.browser import actions, snapshot
from services.browser.browser.frames import diagnostic_url, frame_error, frame_ref, parse_frame_ref
from services.browser.tools import dispatcher, executor, verification
from services.browser.workflows.amazon_fba_common import WorkflowBrowserSession


class Element:
    def __init__(self, driver, document, aid):
        self.driver = driver
        self.document = document
        self.aid = aid

    def click(self):
        assert self.driver.current is self.document
        self.driver.operations.append(("click", self.document["title"], self.aid))
        if self.document.get("click_error"):
            raise RuntimeError(self.document["click_error"])

    def clear(self):
        assert self.driver.current is self.document
        self.document["value"] = ""

    def send_keys(self, text):
        assert self.driver.current is self.document
        self.driver.operations.append(("type", self.document["title"], self.aid, text))
        self.document["value"] = text
        if self.document.get("type_error"):
            raise RuntimeError(self.document["type_error"])


def document(title="root", *, children=(), error="", refs=("aid-1",)):
    return {
        "title": title, "children": list(children), "error": error, "refs": list(refs),
        "document_id": "", "value": "", "text": title,
    }


class Driver:
    def __init__(self, root):
        self.root = root
        self.current = root
        self.switch_to = self
        self.operations = []
        self.extracted = []
        self.resets = 0

    def default_content(self):
        self.resets += 1
        self.current = self.root

    def frame(self, element):
        if element not in self.current["children"]:
            raise RuntimeError("stale frame element")
        self.current = element

    def find_element(self, by, selector):
        aid = selector.split('"')[1]
        if aid not in self.current["refs"]:
            raise RuntimeError(f"not found: {selector}")
        return Element(self, self.current, aid)

    def execute_script(self, script, *args):
        if "LXE_FRAME_LIST" in script:
            return [
                {"element": child, "index": index, "src": f"https://other.test/{child['title']}", "name": child["title"]}
                for index, child in enumerate(self.current["children"])
            ]
        if "LXE_FRAME_DOCUMENT_ID" in script:
            if args[0] and not self.current["document_id"]:
                self.current["document_id"] = args[0]
            return self.current["document_id"]
        if "scrollIntoView" in script:
            assert self.current is args[0].document
            return None
        if "arguments[0].click();" in script:
            return args[0].click()
        if "return deepQuerySelector('[data-aid=" in script:
            if args[0] in self.current["refs"]:
                return Element(self, self.current, args[0])
            return None
        if "const aid = arguments[0]" in script:
            aid = args[0]
            if aid not in self.current["refs"]:
                return {}
            return {"aid": aid, "tag": "input", "text": "查询", "value": self.current["value"]}
        raise AssertionError(f"unexpected script: {script[:80]}")

    def extract(self, *, element_limit, text_limit):
        self.extracted.append(self.current["title"])
        if self.current["error"]:
            raise RuntimeError(self.current["error"])
        elements = [{"aid": aid, "tag": "input", "text": "查询", "value": self.current["value"]} for aid in self.current["refs"]]
        return {
            "url": f"https://other.test/{self.current['title']}",
            "title": self.current["title"],
            "visible_text": self.current["text"],
            "text_lines": [self.current["text"]],
            "headings": [self.current["title"]],
            "interactive_elements": elements[:element_limit],
            # Nested adapter refs must share the canonical budget and namespace.
            "row_action_menus": [{"actions": copy.deepcopy(elements)}],
        }


@pytest.fixture
def extraction(monkeypatch):
    monkeypatch.setattr(snapshot, "_execute_page_snapshot", lambda driver, **kwargs: driver.extract(**kwargs))
    monkeypatch.setattr(actions.time, "sleep", lambda seconds: None)


def test_top_level_snapshot_keeps_legacy_refs(extraction):
    driver = Driver(document())
    result = snapshot.build_page_snapshot(driver)
    assert result["frames"] == []
    assert result["title"] == "root"
    assert result["interactive_elements"][0]["aid"] == "aid-1"
    assert driver.current is driver.root


def test_nested_frames_get_distinct_refs_and_keep_top_identity(extraction):
    grandchild = document("nested")
    first = document("first", children=[grandchild])
    driver = Driver(document(children=[first, document("sibling")]))
    result = snapshot.build_page_snapshot(driver)
    elements = result["interactive_elements"]
    assert len({item["aid"] for item in elements}) == 4
    assert [item["frame_path"] for item in elements] == [[], [0], [0, 0], [1]]
    assert result["title"] == "root"
    assert "nested" in result["visible_text"]
    assert [item["path"] for item in result["frames"]] == [[0], [0, 0], [1]]
    assert result["row_action_menus"][2]["actions"][0]["aid"] == elements[2]["aid"]
    assert driver.current is driver.root
    # Separate CLI attachments can recover the same DOM marker, with no local DB.
    again = snapshot.build_page_snapshot(driver)
    assert [item["aid"] for item in again["interactive_elements"]] == [item["aid"] for item in elements]


def test_unreadable_frame_retains_actual_error_and_continues_siblings(extraction):
    driver = Driver(document(children=[document("broken", error="detached frame: actual detail"), document("healthy")]))
    result = snapshot.build_page_snapshot(driver)
    assert result["frames"][0]["error"] == "detached frame: actual detail"
    assert result["frames"][1]["title"] == "healthy"
    assert [item["frame_path"] for item in result["interactive_elements"]] == [[], [1]]
    assert driver.current is driver.root
    assert "detached frame: actual detail" in dispatcher._format_snapshot_summary(result, full=True)


def test_snapshot_budgets_are_shared_including_adapter_refs(extraction):
    driver = Driver(document(children=[document("child", refs=("aid-1", "aid-2")), document("last")]))
    result = snapshot.build_page_snapshot(driver, element_limit=2, text_limit=7)
    assert len(result["interactive_elements"]) == 2
    assert len(result["visible_text"]) == 7
    assert sum(map(len, result["text_lines"])) <= 7
    assert result["row_action_menus"][-1]["actions"] == []


def test_frame_limit_reports_truncation(extraction):
    driver = Driver(document(children=[document("first"), document("second")]))
    result = snapshot.build_page_snapshot(driver, frame_limit=1)
    assert driver.extracted == ["root", "first"]
    assert result["frames_truncated"] is True
    assert "frame traversal truncated" in dispatcher._format_snapshot_summary(result, full=False)


def test_frame_diagnostics_redact_url_credentials_and_mark_long_errors():
    assert diagnostic_url("https://user:secret@example.test/orders?token=secret#private") == "https://example.test/orders"
    assert diagnostic_url("data:text/html,<secret>") == "data:[redacted]"
    message = frame_error(RuntimeError("frame failed at https://user:secret@example.test/a?token=secret details"))
    assert message == "frame failed at https://example.test/a details"
    assert frame_error(RuntimeError("x" * 2200)).endswith(" ... [truncated]")


def test_disappeared_element_in_existing_frame_never_acts_on_top(extraction, tmp_path):
    leaf = document("leaf")
    driver = Driver(document(children=[leaf]))
    before = snapshot.build_page_snapshot(driver)
    ref = before["interactive_elements"][1]["aid"]
    leaf["refs"].clear()
    with pytest.raises(RuntimeError, match="element not found"):
        actions.execute_browser_action(driver, {"action": "click", "aid": ref}, output_dir=tmp_path, before_snapshot=before)
    assert driver.operations == []
    assert driver.current is driver.root


@pytest.mark.parametrize("action", ["click", "type"])
def test_actions_enter_nested_frame_and_restore_top(extraction, tmp_path, action):
    leaf = document("leaf")
    driver = Driver(document(children=[document("outer", children=[leaf])]))
    before = snapshot.build_page_snapshot(driver)
    ref = before["interactive_elements"][-1]["aid"]
    result = actions.execute_browser_action(driver, {"action": action, "aid": ref, "text": "FBA19PWM5L6T"}, output_dir=tmp_path, before_snapshot=before)
    assert driver.operations[0][:3] == (action, "leaf", "aid-1")
    assert driver.current is driver.root
    assert result["resolved_action"]["aid"] == ref
    if action == "type":
        assert leaf["value"] == "FBA19PWM5L6T"


@pytest.mark.parametrize("change", ["reorder", "replace", "navigate", "remove"])
def test_stale_frame_ref_cannot_act_on_sibling_or_new_document(extraction, tmp_path, change):
    first, second = document("first"), document("second")
    driver = Driver(document(children=[first, second]))
    before = snapshot.build_page_snapshot(driver)
    ref = before["interactive_elements"][1]["aid"]
    if change == "reorder":
        driver.root["children"].reverse()
    elif change == "replace":
        driver.root["children"][0] = document("replacement")
    elif change == "navigate":
        first["document_id"] = ""
    else:
        driver.root["children"].clear()
    with pytest.raises(RuntimeError, match="frame document changed|no longer exists"):
        actions.execute_browser_action(driver, {"action": "click", "aid": ref}, output_dir=tmp_path, before_snapshot=before)
    assert driver.operations == []
    assert driver.current is driver.root


def test_failed_type_restores_top_and_batch_stops_before_next_action(extraction, monkeypatch, tmp_path):
    leaf = document("leaf")
    leaf["type_error"] = "actual send_keys failure"
    driver = Driver(document(children=[leaf]))
    ref = snapshot.build_page_snapshot(driver)["interactive_elements"][1]["aid"]
    session = WorkflowBrowserSession(driver=driver, output_dir=tmp_path)

    @contextmanager
    def attached(*args, **kwargs):
        yield session

    monkeypatch.setattr(executor, "_page_workflow_session", attached)
    result = executor.execute_browser_tool(SimpleNamespace(session_id="test"), tool_name="ziniao_page", arguments={
        "store_id": "store-1", "steps": [
            {"action": "browser_type", "ref": ref, "text": "FBA19PWM5L6T"},
            {"action": "browser_click", "ref": ref},
        ],
    })
    assert result.payload["completed"] is False
    assert result.payload["failed_step"] == 1
    assert result.payload["failure_reason"] == "actual send_keys failure"
    assert len(driver.operations) == 1
    assert result.after_snapshot["title"] == "root"
    assert driver.current is driver.root


def test_snapshot_failure_in_top_document_propagates_and_resets(extraction):
    driver = Driver(document(error="actual top script failure"))
    with pytest.raises(RuntimeError, match="actual top script failure"):
        snapshot.build_page_snapshot(driver)
    assert driver.current is driver.root


def test_verification_never_falls_back_to_sibling_frame():
    ref = frame_ref([0], "a" * 32, "aid-1")
    sibling = {"aid": frame_ref([1], "b" * 32, "aid-1"), "frame_path": [1], "frame_document_id": "b" * 32, "text": "查询"}
    assert verification.matching_element_from_snapshot({"interactive_elements": [sibling]}, ref, {"text": "查询"}) == {}
    assert parse_frame_ref(ref) == ([0], "a" * 32, "aid-1")


def test_real_extraction_js_preserves_chinese_text_and_never_reuses_aids():
    class Capture:
        def execute_script(self, script, *args):
            self.script = script
            return {}

    capture = Capture()
    snapshot._execute_page_snapshot(capture, element_limit=80, text_limit=4000)
    # Execute the actual shipped extraction JS against a small DOM fixture.
    # No browser automation framework, network or production page is involved.
    harness = """
const input = JSON.parse(await Bun.stdin.text());
const nodes = [];
const document = {
  title: '威飒', body: {innerText: '订单查询\\n转单号\\n1234'},
  querySelectorAll(selector) {
    if (selector === '*') return nodes;
    if (selector === '[data-aid]') return nodes.filter(el => el.getAttribute('data-aid'));
    if (selector.startsWith('button, a, input, select, textarea,')) return nodes;
    return [];
  }, querySelector() { return null; }
};
class Element {
  tagName = 'BUTTON'; innerText = '订单查询'; textContent = '订单查询'; id = '';
  attrs = {};
  getAttribute(key) { return this.attrs[key] || ''; }
  setAttribute(key, value) { this.attrs[key] = value; }
  hasAttribute(key) { return key in this.attrs; }
  getBoundingClientRect() { return {width: 10, height: 10, top: 0, left: 0}; }
  closest() { return null; }
  getRootNode() { return document; }
  querySelectorAll() { return []; }
  querySelector() { return null; }
}
const window = {
  location: {href: 'http://wsaexp.nextsls.com/wos'},
  getComputedStyle() { return {display: 'block', visibility: 'visible', opacity: '1'}; }
};
const run = new Function('document', 'window', 'Element', 'ShadowRoot', 'return function(){' + input.script + '}')(document, window, Element, class {});
nodes.push(new Element());
const first = run(80, 4000);
nodes[0] = new Element();
const second = run(80, 4000);
console.log(JSON.stringify({first, second}));
"""
    bun = shutil.which("bun")
    assert bun, "bun is required for the browser extraction JS regression test"
    process = subprocess.run([bun, "-e", harness], input=json.dumps({"script": capture.script}), text=True, capture_output=True, timeout=10)
    assert process.returncode == 0, process.stderr
    result = json.loads(process.stdout)
    assert result["first"]["text_lines"] == ["订单查询", "转单号"]
    assert result["first"]["interactive_elements"][0]["aid"] != result["second"]["interactive_elements"][0]["aid"]
