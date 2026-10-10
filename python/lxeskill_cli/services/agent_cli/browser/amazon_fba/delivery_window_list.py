"""Read the FBA shipment delivery window (送达时段) from the Amazon shipment hub table.

Scope: **read only**.  This module never clicks, types, scrolls or submits; the
only page script it runs is a ``deepQuerySelectorAll`` read.

Why this is not a guessed selector
----------------------------------
The Amazon shipment hub renders the table with semantic ``data-*`` attributes,
so the read is anchored on attributes the page itself uses as its own keys
(verified against a real 25-row page):

    <div data-cell-type="Text" data-column-id="deliveryWindow"
         data-hub-key="shipment_hub" data-row-id="FBA19NDSQ2SK">
      <span data-atom-id="primary">9月6日 - 2026年9月12日</span>
    </div>

- the row key *is* the FBA shipment id (``data-row-id``),
- the column is named (``data-column-id``), not a hashed CSS class,
- every ``(column, row)`` pair is unique, so there is nothing to disambiguate.

The obfuscated class names next to them (``Display-module__Display___C7y9t``)
are deliberately unused.

Known limits (stated, not hidden)
---------------------------------
- **Pagination is not handled.**  Only the rows currently rendered are read;
  ``data.page_row_count`` reports how many that was.
- **Shadow DOM does not survive "Copy outerHTML".**  The cells here are light
  DOM, so this is fine today; if a future page moves them into a shadow root,
  the evidence must be re-taken with a screenshot or a live read.
- **Only the Chinese window format is understood.**  Anything else is reported
  as ``unparsed`` and fails the run rather than being guessed at.

Argument contract (the catalog ``input_schema`` is the source of truth):

- ``store_id`` (required) — the Ziniao store to drive
- ``page_url`` (required) — absolute http(s) Amazon shipment hub URL; the site
  (US/UK/DE/AU/CA/JP) is carried by the URL, so there is no separate ``site``
- ``shipment_ids`` (optional) — restrict the result to these FBA shipment ids
- ``timeout_sec`` (optional, default 60) — wait for the SPA shipment rows to
  render after navigation, from 1 to 600 seconds
- ``plan_only`` (optional, default false) — validate and return the plan without
  touching any browser
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Mapping, Sequence

from services.agent_cli._shared.browser_session import browser_session
from services.browser.browser.shadow_dom import SHADOW_DOM_HELPERS_JS
from services.browser.workflows.amazon_fba_common import workflow_output_dir

# --------------------------------------------------------------------------
# Page contract — the only browser-side knowledge in this module.
# --------------------------------------------------------------------------

#: ``data-hub-key`` of the FBA shipment list table.
SHIPMENT_HUB_KEY = "shipment_hub"
#: Column id holding the FBA shipment id (the row key repeats it).
SHIPMENT_ID_COLUMN = "shipmentId"
#: Column id holding the delivery window.
DELIVERY_WINDOW_COLUMN = "deliveryWindow"
#: Attribute selector for the primary value inside a cell.
PRIMARY_ATOM_SELECTOR = '[data-atom-id="primary"]'
#: Every body cell of the shipment hub table.
SHIPMENT_HUB_CELL_SELECTOR = f'[data-hub-key="{SHIPMENT_HUB_KEY}"][data-row-id]'

_READ_CELLS_SCRIPT = r"""
function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

const cellSelector = arguments[0];
const wanted = String(arguments[1] || '').split(',');
const atomSelector = arguments[2];

const isWanted = {};
for (const column of wanted) {
  if (column) isWanted[column] = true;
}

const out = [];
for (const cell of Array.from(deepQuerySelectorAll(cellSelector) || [])) {
  const column = String(cell.getAttribute('data-column-id') || '');
  if (!isWanted[column]) continue;
  const rowId = String(cell.getAttribute('data-row-id') || '').trim();
  if (!rowId) continue;
  const atom = deepQuerySelector(atomSelector, cell);
  out.push({
    rowId: rowId,
    column: column,
    text: cleanText(atom ? atom.textContent : cell.textContent),
    cellText: cleanText(cell.textContent),
  });
}
return out;
"""

# --------------------------------------------------------------------------
# Parsing contract.
# --------------------------------------------------------------------------

#: ``FBA`` + at least 7 alphanumerics, e.g. ``FBA19S7JLCB5``.
FBA_SHIPMENT_ID_PATTERN = re.compile(r"^FBA[A-Z0-9]{7,}$")

WINDOW_PARSED = "parsed"
WINDOW_MISSING = "missing"
WINDOW_UNPARSED = "unparsed"
WINDOW_INCONSISTENT = "inconsistent"

#: Rows whose window the caller must look at before trusting the result.
_PROBLEM_STATUSES = frozenset({WINDOW_UNPARSED, WINDOW_INCONSISTENT})

#: A Chinese date with an optional year, e.g. ``2026年9月12日`` or ``9月6日``.
_CN_DATE = re.compile(r"^(?:(\d{4})\s*年)?\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日$")
#: Start/end separators seen in the hub, e.g. ``9月6日 - 2026年9月12日``.
_WINDOW_SEPARATOR = re.compile(r"\s*(?:-|–|—|~|～|至|to)\s*", re.IGNORECASE)
_FULLWIDTH_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")
_WHITESPACE = re.compile(r"\s+")

DEFAULT_TIMEOUT_SECONDS = 60
MAX_TIMEOUT_SECONDS = 600
POLL_INTERVAL_SECONDS = 0.2


class DeliveryWindowArgumentError(ValueError):
    """Argument contract violation. Reported through the payload, never raised."""


def _clean_text(value: object) -> str:
    return _WHITESPACE.sub(" ", str(value or "").translate(_FULLWIDTH_DIGITS)).strip()


def _empty_window(raw: str, status: str, reason: str = "") -> dict[str, Any]:
    return {
        "raw": raw,
        "status": status,
        "reason": reason,
        "start_date": "",
        "end_date": "",
        "span_days": None,
        "start_year_inferred": False,
    }


def parse_cn_date(text: object) -> dict[str, Any] | None:
    """Parse one Chinese date; ``year`` is ``None`` when the page omitted it."""
    match = _CN_DATE.match(_clean_text(text))
    if not match:
        return None
    year_text, month_text, day_text = match.groups()
    month, day = int(month_text), int(day_text)
    if not 1 <= month <= 12 or not 1 <= day <= 31:
        return None
    return {"year": int(year_text) if year_text else None, "month": month, "day": day}


def parse_delivery_window(text: object) -> dict[str, Any]:
    """Parse a delivery-window cell into a start/end date plus a status.

    The hub renders the start date without a year, so the year is inferred from
    the end date: a start month later than the end month means the window
    crosses a year boundary.  An unparseable value is reported as ``unparsed``
    rather than guessed, because guessing here would silently produce a wrong
    window — exactly the failure this module exists to avoid.
    """
    raw = _clean_text(text)
    if not raw:
        return _empty_window("", WINDOW_MISSING)

    parts = [part for part in _WINDOW_SEPARATOR.split(raw) if part]
    if len(parts) != 2:
        return _empty_window(
            raw, WINDOW_UNPARSED, f"无法拆成起止两段（得到 {len(parts)} 段）"
        )

    start = parse_cn_date(parts[0])
    end = parse_cn_date(parts[1])
    if start is None or end is None:
        return _empty_window(raw, WINDOW_UNPARSED, "不是已支持的中文日期格式（X月X日）")
    if start["year"] is None and end["year"] is None:
        return _empty_window(raw, WINDOW_UNPARSED, "起止两端都没有年份，无法确定年份")

    inferred = False
    if start["year"] is None:
        start["year"] = (
            end["year"] - 1 if start["month"] > end["month"] else end["year"]
        )
        inferred = True
    if end["year"] is None:
        end["year"] = (
            start["year"] + 1 if end["month"] < start["month"] else start["year"]
        )
        inferred = True

    try:
        start_date = _dt.date(start["year"], start["month"], start["day"])
        end_date = _dt.date(end["year"], end["month"], end["day"])
    except ValueError as exc:  # e.g. 2月30日
        return _empty_window(raw, WINDOW_UNPARSED, f"日期不存在: {exc}")

    if start_date > end_date:
        return _empty_window(
            raw,
            WINDOW_INCONSISTENT,
            f"开始日期晚于结束日期（{start_date.isoformat()} > {end_date.isoformat()}）",
        )

    return {
        "raw": raw,
        "status": WINDOW_PARSED,
        "reason": "",
        "start_date": start_date.isoformat(),
        "end_date": end_date.isoformat(),
        "span_days": (end_date - start_date).days + 1,
        "start_year_inferred": inferred,
    }


def build_rows(cells: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Group the raw cell reads into one row per ``data-row-id``.

    Duplicate ``(column, row)`` cells are counted and surfaced instead of being
    silently merged: the real page has exactly one cell per pair, so a duplicate
    means the page changed and the read should not be trusted blindly.
    """
    order: list[str] = []
    shipment_text: dict[str, str] = {}
    window_text: dict[str, str] = {}
    seen_pairs: dict[tuple[str, str], int] = {}

    for cell in cells:
        row_id = str(cell.get("rowId") or "").strip()
        column = str(cell.get("column") or "").strip()
        if not row_id or not column:
            continue
        if row_id not in order:
            order.append(row_id)
        pair = (column, row_id)
        seen_pairs[pair] = seen_pairs.get(pair, 0) + 1

        payload = _clean_text(cell.get("text"))
        if column == SHIPMENT_ID_COLUMN:
            shipment_text.setdefault(row_id, payload)
        elif column == DELIVERY_WINDOW_COLUMN:
            window_text.setdefault(row_id, payload)

    rows = [
        {
            "fba_shipment_id": row_id,
            "row_id_is_fba_shipment_id": bool(FBA_SHIPMENT_ID_PATTERN.match(row_id)),
            "shipment_cell_text": shipment_text.get(row_id, ""),
            "delivery_window": parse_delivery_window(window_text.get(row_id, "")),
        }
        for row_id in order
    ]
    duplicate_pairs = [
        {"column": column, "row_id": row_id, "count": count}
        for (column, row_id), count in seen_pairs.items()
        if count > 1
    ]
    return {"rows": rows, "duplicate_pairs": duplicate_pairs}


def collect_problems(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Rows whose result must not be trusted without a human look."""
    problems: list[dict[str, Any]] = []
    for row in rows:
        entry = dict(row or {})
        window = dict(entry.get("delivery_window") or {})
        if not entry.get("row_id_is_fba_shipment_id"):
            problems.append(
                {
                    "fba_shipment_id": str(entry.get("fba_shipment_id") or ""),
                    "kind": "row_id_not_fba_shipment_id",
                    "detail": "data-row-id 不是 FBA 货件号形态，货件列表的键可能已改变",
                }
            )
            continue
        status = str(window.get("status") or "")
        if status in _PROBLEM_STATUSES:
            problems.append(
                {
                    "fba_shipment_id": str(entry.get("fba_shipment_id") or ""),
                    "kind": status,
                    "detail": f"{window.get('raw') or '(空)'} — {window.get('reason') or ''}".strip(),
                }
            )
    return problems


def select_rows(
    rows: Sequence[Mapping[str, Any]],
    targets: Sequence[str],
) -> dict[str, Any]:
    """Filter to ``targets`` (page order preserved) and report what was absent."""
    if not targets:
        return {"selected": [dict(row) for row in rows], "unmatched": []}
    wanted = set(targets)
    present = {str(row.get("fba_shipment_id") or "") for row in rows}
    selected = [dict(row) for row in rows if str(row.get("fba_shipment_id") or "") in wanted]
    return {
        "selected": selected,
        "unmatched": [target for target in targets if target not in present],
    }


def plan_read(arguments: Mapping[str, Any]) -> dict[str, Any]:
    """Validate and normalize the argument contract. Pure; no side effects."""
    args = dict(arguments or {})

    store_id = str(args.get("store_id") or "").strip()
    if not store_id:
        raise DeliveryWindowArgumentError("store_id 不能为空：需要紫鸟店铺的 store_id")

    page_url = str(args.get("page_url") or "").strip()
    if not re.match(r"^https?://", page_url, re.IGNORECASE):
        raise DeliveryWindowArgumentError(
            f"page_url 必须是绝对 http(s) 地址（Amazon 货件列表页），收到: {page_url or '(空)'}"
        )

    raw_ids = args.get("shipment_ids")
    if raw_ids is None or (isinstance(raw_ids, str) and not raw_ids.strip()):
        shipment_ids: list[str] = []
    elif isinstance(raw_ids, (list, tuple, set)):
        shipment_ids = [str(item or "").strip().upper() for item in raw_ids if str(item or "").strip()]
    else:
        shipment_ids = [
            part.strip().upper()
            for part in re.split(r"[\s,，;；|]+", str(raw_ids))
            if part.strip()
        ]
    shipment_ids = list(dict.fromkeys(shipment_ids))
    invalid = [item for item in shipment_ids if not FBA_SHIPMENT_ID_PATTERN.match(item)]
    if invalid:
        raise DeliveryWindowArgumentError(
            "shipment_ids 含非法 FBA 货件编号: "
            + ", ".join(invalid)
            + "（正确形如 FBA19S7JLCB5；不要传买家订单号 123-1234567-1234567）"
        )

    raw_timeout = args.get("timeout_sec", DEFAULT_TIMEOUT_SECONDS)
    try:
        timeout_sec = int(raw_timeout)
    except (TypeError, ValueError) as exc:
        raise DeliveryWindowArgumentError(
            f"timeout_sec 必须是整数秒，收到: {raw_timeout!r}"
        ) from exc
    if not 1 <= timeout_sec <= MAX_TIMEOUT_SECONDS:
        raise DeliveryWindowArgumentError(
            f"timeout_sec 必须在 1-{MAX_TIMEOUT_SECONDS} 秒之间，收到: {timeout_sec}"
        )

    return {
        "store_id": store_id,
        "page_url": page_url,
        "shipment_ids": shipment_ids,
        "timeout_sec": timeout_sec,
        "plan_only": bool(args.get("plan_only", False)),
    }


# --------------------------------------------------------------------------
# Page read.
# --------------------------------------------------------------------------


def read_hub_cells(driver: Any) -> list[dict[str, Any]]:
    """Read the shipment-id and delivery-window cells of the hub table.

    Channel wiring only: this proves Selenium calls the Shadow-DOM-aware read
    with the hub selector.  It cannot prove the selector matches a live page —
    only a live page can do that.
    """
    payload = driver.execute_script(
        SHADOW_DOM_HELPERS_JS + _READ_CELLS_SCRIPT,
        SHIPMENT_HUB_CELL_SELECTOR,
        f"{SHIPMENT_ID_COLUMN},{DELIVERY_WINDOW_COLUMN}",
        PRIMARY_ATOM_SELECTOR,
    )
    if not isinstance(payload, list):
        return []
    cells: list[dict[str, Any]] = []
    for item in payload:
        if isinstance(item, Mapping):
            cells.append(dict(item))
    return cells


def wait_for_hub_cells(
    driver: Any,
    *,
    timeout_seconds: float,
    shipment_ids: Sequence[str] = (),
    poll_interval_seconds: float = POLL_INTERVAL_SECONDS,
) -> list[dict[str, Any]]:
    """Wait for rows, and for every requested shipment when a filter is given."""
    deadline = time.monotonic() + max(0.0, float(timeout_seconds))
    wanted = {str(item or "").strip() for item in shipment_ids if str(item or "").strip()}
    last_cells: list[dict[str, Any]] = []
    while True:
        cells = read_hub_cells(driver)
        if cells:
            last_cells = cells
            present = {str(item.get("rowId") or "").strip() for item in cells}
            if not wanted or wanted.issubset(present):
                return cells
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return last_cells
        time.sleep(min(max(0.01, float(poll_interval_seconds)), remaining))


def _write_read_artifact(
    output_dir: str | Path,
    plan: Mapping[str, Any],
    selection: Mapping[str, Any],
    *,
    page_row_count: int,
    duplicate_pairs: Sequence[Mapping[str, Any]],
) -> str:
    target_dir = Path(output_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"amazon-delivery-window-{int(time.time())}.json"
    payload = {
        "page_url": plan.get("page_url"),
        "store_id": plan.get("store_id"),
        "requested_shipment_ids": list(plan.get("shipment_ids") or []),
        "page_row_count": int(page_row_count),
        "unmatched": list(selection.get("unmatched") or []),
        "duplicate_pairs": [dict(item) for item in duplicate_pairs],
        "read_at": _dt.datetime.now().isoformat(timespec="seconds"),
        "rows": list(selection.get("selected") or []),
    }
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return str(target.resolve())


def _payload(
    *,
    success: bool,
    finished: bool,
    exception: str = "",
    notice: str = "",
    file_path: Sequence[Mapping[str, str]] | None = None,
    data: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "success": bool(success),
        "finished": bool(finished),
        # This Amazon/Ziniao workflow does not use Mabang credentials.  The
        # generic CLI must not suggest `lxeskill auth refresh` for its errors.
        "auth_refresh_required": False,
        "exception": str(exception or "").strip(),
        "notice": str(notice or "").strip(),
        "file_path": [dict(item) for item in list(file_path or [])],
        "data": dict(data or {}),
    }


def _summarize(problems: Sequence[Mapping[str, Any]], limit: int = 5) -> str:
    shown = [
        f"{item.get('fba_shipment_id')}({item.get('kind')}: {item.get('detail')})"
        for item in list(problems)[:limit]
    ]
    text = "；".join(shown)
    if len(problems) > limit:
        text += f"；…另有 {len(problems) - limit} 行"
    return text


def _artifact_entries(artifact_path: str) -> list[dict[str, str]]:
    return [{"key": "delivery_window_list", "value": artifact_path}]


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — the catalog ``input_schema`` is the argument contract."""
    try:
        plan = plan_read(arguments)
    except DeliveryWindowArgumentError as exc:
        return _payload(success=False, finished=False, exception=str(exc))

    if plan["plan_only"]:
        return _payload(
            success=True,
            finished=True,
            notice="plan_only=true：仅校验参数，未接触任何页面。",
            data={"plan": plan, "page_row_count": 0, "rows": [], "problems": [], "unmatched": []},
        )

    session_id = str(os.environ.get("LXE_AGENT_SESSION_ID") or "").strip()
    if not session_id:
        return _payload(
            success=False,
            finished=False,
            exception="缺少 LXE_AGENT_SESSION_ID",
            data={"plan": plan},
        )

    try:
        with browser_session(
            session_id=session_id,
            context={"store_id": plan["store_id"]},
            output_dir=workflow_output_dir(session_id),
        ) as session:
            session.driver.get(plan["page_url"])
            cells = wait_for_hub_cells(
                session.driver,
                timeout_seconds=float(plan["timeout_sec"]),
                shipment_ids=plan["shipment_ids"],
            )
            built = build_rows(cells)
            selection = select_rows(built["rows"], plan["shipment_ids"])
            artifact_path = _write_read_artifact(
                session.output_dir,
                plan,
                selection,
                page_row_count=len(built["rows"]),
                duplicate_pairs=built["duplicate_pairs"],
            )
    except Exception as exc:  # noqa: BLE001 — real error text goes back to the caller as-is
        return _payload(
            success=False,
            finished=False,
            exception=f"{type(exc).__name__}: {exc}",
            data={"plan": plan},
        )

    files = _artifact_entries(artifact_path)
    base_data = {
        "plan": plan,
        "page_row_count": len(built["rows"]),
        "duplicate_pairs": built["duplicate_pairs"],
    }

    if not built["rows"]:
        return _payload(
            success=False,
            finished=False,
            exception=(
                f"页面等待 {plan['timeout_sec']} 秒后仍未读到货件行（0 行）；"
                f"选择器 {SHIPMENT_HUB_CELL_SELECTOR} 未命中。"
                "实际原因尚未确认，可能是页面未就绪、URL 不正确或页面结构已变；"
                "本命令不使用马帮认证，未执行任何修改。"
            ),
            file_path=files,
            data={**base_data, "rows": [], "problems": [], "unmatched": []},
        )

    problems = collect_problems(selection["selected"])
    if problems:
        return _payload(
            success=False,
            finished=False,
            exception=(
                f"有 {len(problems)} 行送达时段无法可信解析，未产出结果"
                "（可能是页面格式变了，请勿据此判断）："
                + _summarize(problems)
            ),
            file_path=files,
            data={**base_data, "rows": selection["selected"], "problems": problems,
                  "unmatched": selection["unmatched"]},
        )

    if selection["unmatched"]:
        return _payload(
            success=False,
            finished=False,
            exception=(
                f"指定的 {len(selection['unmatched'])} 个货件号未出现在当前页面："
                + ", ".join(selection["unmatched"])
                + f"（本页共读到 {len(built['rows'])} 行；不处理分页，也不猜测）。"
            ),
            file_path=files,
            data={**base_data, "rows": selection["selected"], "problems": [],
                  "unmatched": selection["unmatched"]},
        )

    selected = selection["selected"]
    missing = [
        row["fba_shipment_id"]
        for row in selected
        if str((row.get("delivery_window") or {}).get("status")) == WINDOW_MISSING
    ]
    notice = f"读到 {len(selected)} 个货件的送达时段（本页共 {len(built['rows'])} 行）"
    if missing:
        notice += f"；其中 {len(missing)} 个尚未分配送达时段"
    if built["duplicate_pairs"]:
        notice += f"；注意有 {len(built['duplicate_pairs'])} 组重复单元格"

    return _payload(
        success=True,
        finished=True,
        notice=notice,
        file_path=files,
        data={**base_data, "rows": selected, "problems": [], "unmatched": []},
    )


__all__ = [
    "DELIVERY_WINDOW_COLUMN",
    "DEFAULT_TIMEOUT_SECONDS",
    "DeliveryWindowArgumentError",
    "FBA_SHIPMENT_ID_PATTERN",
    "PRIMARY_ATOM_SELECTOR",
    "SHIPMENT_HUB_CELL_SELECTOR",
    "SHIPMENT_HUB_KEY",
    "SHIPMENT_ID_COLUMN",
    "WINDOW_INCONSISTENT",
    "WINDOW_MISSING",
    "WINDOW_PARSED",
    "WINDOW_UNPARSED",
    "build_rows",
    "collect_problems",
    "parse_cn_date",
    "parse_delivery_window",
    "plan_read",
    "read_hub_cells",
    "run",
    "select_rows",
    "wait_for_hub_cells",
]
