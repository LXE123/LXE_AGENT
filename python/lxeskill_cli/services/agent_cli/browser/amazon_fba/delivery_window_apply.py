"""Change (apply) the FBA shipment delivery window (送达时段) on Amazon.

Scope: **read-verify first, write only when the caller says ``apply=true``**.

The whole point of this module is the order of operations: every fact it needs
(the hub row and lifecycle status belong to *this* shipment, the tracking page
is showing *this* shipment, the window is still editable, the calendar really
selected the week we asked for)
is read back and checked **before** the confirm button may be clicked.  When a
check fails the run stops with an explicit error that carries the page text it
read, so a human can see why.  Nothing is guessed: an unparseable page is a
failure, never a best effort.

Why the reads are ``driver.page_source`` + BeautifulSoup
-------------------------------------------------------
``delivery_window_list`` reads the hub table through injected JS because the
hub cells are stable ``data-*`` attributes.  Here the interesting elements are
the ones the page itself labels with ``data-testid`` (modal body, legend,
footer buttons), and the evidence for them is static HTML, so the *same* HTML
the test fixture holds is parsed by the production read path.  Clicking and
waiting still go through injected JS, because the calendar lives in a shadow
root and ``page_source`` cannot see into one.

Known limits (stated, not hidden)
---------------------------------
- **Shadow DOM is invisible to the reads.**  ``page_source`` does not contain
  shadow roots, so an element that moves into one is reported as missing (a
  loud failure) instead of being mis-read.  The calendar is therefore only ever
  *driven* through JS, never parsed from HTML.
- **Only the Chinese window / date formats are understood.**  Anything else
  fails as ``unparsed``.
- **Three page details are still unverified against a live page** (they fail
  loudly rather than silently, see ``docs/record/20261009-fba-delivery-window-apply.md``
  §6.2): the day-cell markup inside ``kat-calendar``, the month-paging parts
  inside it, and the condition that enables the confirm button.

Failure codes (``exception`` starts with the code)
--------------------------------------------------
``E1`` shipment-hub gate (row not on the page / ``orderStatus`` unreadable),
``E2`` tracking-detail page or shipment tab, ``E3``
the edit deadline (grace period), ``E4`` the modal never appeared, ``E5`` the
legend still shows another week, ``E6`` the confirm button is missing, still
disabled, or unclickable, ``E7`` the calendar (month header unreadable, paging
stuck, no day cell), ``E8`` the window read back after confirming is not the
target week, ``E9`` the current delivery window is unreadable (or the modal
shows a different window than the page did, which means the wrong shipment tab
was open).

Argument contract (the catalog ``input_schema`` is the source of truth):

- ``action`` (optional, default ``apply``) — ``discover`` scans every shipment
  tab in the seed shipment's STA workflow without opening the edit modal;
  ``apply`` keeps the existing verified write path
- ``store_id`` (required) — the Ziniao store to drive
- ``page_url`` (required) — absolute http(s) Amazon shipment **hub** URL; the
  site (US/UK/DE/AU/CA/JP) is carried by the URL, so there is no ``site`` key
- ``shipment_ids`` (required) — the FBA shipment ids to move, processed in the
  given order, each one independently
- ``target_date`` (required) — any day inside the wanted delivery week, e.g.
  ``2026-10-28`` or ``10.28``; the calendar week is Sunday→Saturday
- ``apply`` (optional, default false) — false stops right after the modal is
  read (dry run); true clicks the day cell and the confirm button
- ``timeout_sec`` (optional, default 60) — page-level waits
- ``plan_only`` (optional, default false) — validate the arguments only, never
  touch a browser

``shipment_ids`` and ``page_url`` are validated by ``delivery_window_list`` so
the read command and this write command cannot drift apart.
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import parse_qs, urljoin, urlsplit

from bs4 import BeautifulSoup, Comment, NavigableString, Tag

from services.agent_cli._shared.browser_session import browser_session
from services.agent_cli.browser.amazon_fba import delivery_window_list as dwl
from services.browser.browser.shadow_dom import SHADOW_DOM_HELPERS_JS
from services.browser.workflows.amazon_fba_common import workflow_output_dir

# --------------------------------------------------------------------------
# Page contract — the only browser-side knowledge in this module.
# --------------------------------------------------------------------------

#: Lifecycle status shown in the visible 状态 column (for example 正在接收).
ORDER_STATUS_COLUMN = "orderStatus"

#: Business-approved lifecycle status for delivery-window changes.  Inventory
#: progress (``unitStatus``) is deliberately not part of this gate.
EDITABLE_ORDER_STATUSES = frozenset({"已发货"})

#: Inventory-pipeline fraction (已入库/预计上架).  This is diagnostic only:
#: a live row can be ``orderStatus=正在接收`` while this value is ``516/516``.
UNIT_STATUS_COLUMN = "unitStatus"

#: Hub cell selector / primary atom selector — reused, not re-declared, so the
#: write path cannot silently disagree with the read path about the table.
SHIPMENT_HUB_CELL_SELECTOR = dwl.SHIPMENT_HUB_CELL_SELECTOR
PRIMARY_ATOM_SELECTOR = dwl.PRIMARY_ATOM_SELECTOR

#: Shipment detail page.  The ``origin`` comes from ``page_url``.
DETAIL_URL_TEMPLATE = "{origin}/fba/inbound-shipment/summary/{shipment_id}/contents"
#: Path marker of the STA (Send To Amazon) tracking workflow URL.
STA_HREF_MARKER = "/fba/sendtoamazon?wf="

SHIPMENT_INFO_DETAILS_SELECTOR = '[data-testid="shipment-info-details"]'
STA_LINK_SELECTOR = (
    f'{SHIPMENT_INFO_DETAILS_SELECTOR} kat-link[href*="{STA_HREF_MARKER}"]'
)
STA_LINK_ANY_SELECTOR = f'kat-link[href*="{STA_HREF_MARKER}"], a[href*="{STA_HREF_MARKER}"]'
TRACKING_TAB_SELECTOR = '[data-testid="shipment-tracking-tab"]'
STEP_VIEW_LINK_SELECTOR = '[data-testid="step-view-link"]'
EDIT_LINK_SELECTOR = '[data-testid="edit-delivery-window-link"]'
EDIT_TOOLTIP_SELECTOR = '[data-testid="edit-delivery-window-tooltip"]'
GRACE_SELECTOR = '[data-testid="edit-delivery-window-grace-period"]'
MODAL_BODY_SELECTOR = '[data-testid="edit-delivery-window-modal-body"]'
CALENDAR_SELECTOR = 'kat-calendar[data-testid="edit-delivery-window-calendar"]'
LEGEND_ITEM_SELECTOR = '[data-testid="delivery-window-modal-legend-item"]'
UPDATE_BUTTON_SELECTOR = '[data-testid="edit-delivery-window-modal-update-button"]'
CANCEL_BUTTON_SELECTOR = '[data-testid="edit-delivery-window-modal-cancel-button"]'

#: The legend marks the *chosen* week with this class on a child swatch, so the
#: class has to be looked for on descendants, not only on the legend item.
LEGEND_SELECTED_CLASS = "ac-delivery-window-modal-legend-selected"
LEGEND_SELECTED_LABEL = "已选择"

#: Label of the window that is live right now, inside the modal.
CURRENT_WINDOW_LABEL = "当前送达时段"
#: Label of the same value on the tracking page (colon variants are common).
PAGE_WINDOW_LABELS = ("送达时段", "送达时段:", "送达时段：")

#: Waits.  Module-level so tests can shrink them.
MODAL_TIMEOUT_SECONDS = 20
LEGEND_TIMEOUT_SECONDS = 10
MODAL_CLOSE_TIMEOUT_SECONDS = 30
MAX_MONTH_STEPS = 24
DEFAULT_TIMEOUT_SECONDS = 60
MAX_TIMEOUT_SECONDS = 600
_WAIT_INTERVAL_SECONDS = 0.5

ACTION_APPLY = "apply"
ACTION_DISCOVER = "discover"

#: Sleep indirection so tests can drive the timeout branches instantly.
_SLEEP: Callable[[float], None] = time.sleep

# --------------------------------------------------------------------------
# Parsing contract.
# --------------------------------------------------------------------------

WINDOW_PARSED = dwl.WINDOW_PARSED
WINDOW_MISSING = dwl.WINDOW_MISSING
WINDOW_UNPARSED = dwl.WINDOW_UNPARSED

_WHITESPACE = re.compile(r"\s+")
_FULLWIDTH_DIGITS = str.maketrans("０１２３４５６７８９", "0123456789")
#: ``FBA`` + 7 or more alphanumerics, found *inside* a longer text (dwl's
#: pattern is anchored because it validates a whole argument).
_FBA_ID_IN_TEXT = re.compile(r"FBA[A-Z0-9]{7,}")

#: ``2026-10-28`` / ``2026/10/28`` / ``2026.10.28`` / ``2026年10月28日``.
_TARGET_DATE_WITH_YEAR = re.compile(
    r"^(?P<year>\d{4})\s*[-/.年]\s*(?P<month>\d{1,2})\s*[-/.月]\s*(?P<day>\d{1,2})\s*日?$"
)
#: ``10.28`` / ``10-28`` / ``10/28`` / ``10月28日`` — month first, the Chinese
#: convention; a value like ``28.10`` is rejected instead of guessed at.
_TARGET_DATE_WITHOUT_YEAR = re.compile(
    r"^(?P<month>\d{1,2})\s*[-/.月]\s*(?P<day>\d{1,2})\s*日?$"
)

#: The whole "edit until" sentence, with or without the UTC time.
_GRACE_PHRASE = re.compile(
    r"在\s*(?P<year>\d{4})\s*年\s*(?P<month>\d{1,2})\s*月\s*(?P<day>\d{1,2})\s*日"
    r"\s*(?:[,，]\s*(?P<hour>\d{1,2})\s*:\s*(?P<minute>\d{2})\s*UTC)?\s*之前"
)

_UNIT_STATUS_FRACTION = re.compile(r"(\d+)\s*[/／]\s*(\d+)")

#: The same bar spelled out, e.g. ``已入库 600，预计上架 602``.
_UNIT_STATUS_LABELED = re.compile(r"已入库\s*(\d+)[\s\S]*?预计上架\s*(\d+)")

#: Month names used by the Katal calendars (``own_carrier`` uses the same set).
_MONTH_NAME_TO_NUMBER = {
    "一月": 1,
    "二月": 2,
    "三月": 3,
    "四月": 4,
    "五月": 5,
    "六月": 6,
    "七月": 7,
    "八月": 8,
    "九月": 9,
    "十月": 10,
    "十一月": 11,
    "十二月": 12,
}

#: Month names, longest first so ``十一月`` cannot be read as ``十`` + ``一月``.
_MONTH_NAME_ALTERNATION = "十二|十一|一|二|三|四|五|六|七|八|九|十"

#: ``2026年10月`` / ``2026年 10 月``.
_CALENDAR_MONTH_CN = re.compile(r"(?P<year>\d{4})\s*年\s*(?P<month>\d{1,2})\s*月")
#: ``10月 2026`` / ``10 月2026``.
_CALENDAR_MONTH_NUM_FIRST = re.compile(r"(?P<month>\d{1,2})\s*月\s*(?P<year>\d{4})")
#: ``十月 2026`` / ``十月2026``.
_CALENDAR_MONTH_NAME_FIRST = re.compile(
    rf"(?P<name>{_MONTH_NAME_ALTERNATION})\s*月?\s*年?\s*(?P<year>\d{{4}})"
)
#: ``2026年 十月`` / ``2026 十月`` (no digits for the month).
_CALENDAR_MONTH_YEAR_FIRST = re.compile(
    rf"(?P<year>\d{{4}})\s*年?\s*(?P<name>{_MONTH_NAME_ALTERNATION})\s*月?"
)


class DeliveryWindowApplyArgumentError(dwl.DeliveryWindowArgumentError):
    """Argument contract violation for the write command."""


def _clean(value: object) -> str:
    return _WHITESPACE.sub(" ", str(value or "")).strip()


def _normalize_digits(value: object) -> str:
    return str(value or "").translate(_FULLWIDTH_DIGITS)


def _label_key(value: object) -> str:
    """Label text with a trailing colon removed (both colon widths)."""
    return _clean(value).rstrip(":：")


# --------------------------------------------------------------------------
# Pure argument logic.
# --------------------------------------------------------------------------


def parse_target_date(text: object, *, today: _dt.date) -> _dt.date:
    """Parse the wanted delivery day.  Raises instead of guessing.

    A missing year is taken from ``today`` (the caller's business date); a
    first number greater than 12 is rejected, because ``28.10`` would be an
    ambiguous day/month order and guessing it could move the window a month.
    """
    raw = _clean(_normalize_digits(text))
    if not raw:
        raise DeliveryWindowApplyArgumentError("target_date 不能为空：需要目标送达周内的任意一天")

    match = _TARGET_DATE_WITH_YEAR.match(raw)
    if match is None:
        match = _TARGET_DATE_WITHOUT_YEAR.match(raw)
        if match is None:
            raise DeliveryWindowApplyArgumentError(
                f"target_date 无法识别: {raw}（支持 2026-10-28 / 2026/10/28 / 2026.10.28 / "
                "2026年10月28日 / 10.28 / 10-28 / 10/28 / 10月28日）"
            )

    groups = match.groupdict()
    month_text = groups.get("month") or ""
    month = int(month_text)
    day = int(groups["day"])
    if not 1 <= month <= 12:
        raise DeliveryWindowApplyArgumentError(
            f"target_date 的月份必须在 1-12: {raw}（本例按「月.日」解析；"
            "若你写的是「日.月」，请改成 2026-MM-DD 这种带年份的写法）"
        )
    year = int(groups["year"]) if groups.get("year") else today.year
    try:
        return _dt.date(year, month, day)
    except ValueError as exc:
        raise DeliveryWindowApplyArgumentError(f"target_date 不是一个真实日期: {raw}（{exc}）") from exc


def calendar_week_span(day: _dt.date) -> tuple[_dt.date, _dt.date]:
    """Sunday→Saturday week that contains ``day`` (the Amazon delivery week)."""
    offset = (day.weekday() + 1) % 7  # Sunday -> 0 ... Saturday -> 6
    start = day - _dt.timedelta(days=offset)
    return start, start + _dt.timedelta(days=6)


def format_cn_window(start: _dt.date, end: _dt.date) -> str:
    """The page's own format, e.g. ``2026年10月25日 - 2026年10月31日``."""
    return (
        f"{start.year}年{start.month}月{start.day}日"
        f" - {end.year}年{end.month}月{end.day}日"
    )


def window_matches(window: Mapping[str, Any] | None, start: _dt.date, end: _dt.date) -> bool:
    """True only for a fully parsed window whose two ends are exactly right."""
    if not isinstance(window, Mapping):
        return False
    if str(window.get("status")) != WINDOW_PARSED:
        return False
    return (
        str(window.get("start_date")) == start.isoformat()
        and str(window.get("end_date")) == end.isoformat()
    )


def parse_grace_period(text: object, *, now: _dt.datetime) -> dict[str, Any]:
    """Parse 「在 <日期>[, HH:MM UTC] 之前」 into an absolute UTC deadline.

    The tracking page shows the time, the modal's info banner usually does not;
    a missing time is read as 00:00 UTC and flagged with
    ``assumed_midnight_utc`` so the report never pretends it was shown.
    """
    raw = _clean(text)
    if not raw:
        return {
            "raw": "",
            "status": WINDOW_MISSING,
            "reason": "页面上没有可编辑截止时间的文案",
            "deadline": "",
            "editable": None,
            "assumed_midnight_utc": False,
        }

    match = _GRACE_PHRASE.search(_normalize_digits(raw))
    if match is None:
        return {
            "raw": raw,
            "status": WINDOW_UNPARSED,
            "reason": "无法识别截止时间（需要「在 YYYY年M月D日[, HH:MM UTC] 之前」）",
            "deadline": "",
            "editable": None,
            "assumed_midnight_utc": False,
        }

    hour_text = match.group("hour")
    minute_text = match.group("minute")
    assumed = hour_text is None
    hour = int(hour_text) if hour_text else 0
    minute = int(minute_text) if minute_text else 0
    try:
        deadline = _dt.datetime(
            int(match.group("year")),
            int(match.group("month")),
            int(match.group("day")),
            hour,
            minute,
            tzinfo=_dt.timezone.utc,
        )
    except ValueError as exc:
        return {
            "raw": raw,
            "status": WINDOW_UNPARSED,
            "reason": f"截止时间不是一个真实时刻: {exc}",
            "deadline": "",
            "editable": None,
            "assumed_midnight_utc": assumed,
        }

    moment = now if now.tzinfo is not None else now.replace(tzinfo=_dt.timezone.utc)
    return {
        "raw": raw,
        "status": WINDOW_PARSED,
        "reason": "",
        "deadline": deadline.isoformat(),
        "editable": moment < deadline,
        "assumed_midnight_utc": assumed,
    }


def parse_unit_status(text: object) -> dict[str, Any]:
    """Parse the ``unitStatus`` fraction: received < expected means not received.

    The column is the page's own 已入库/预计上架 bar (``data-cell-type="Fraction"``).
    ``expected <= 0`` cannot prove anything, so it is reported as unparsed
    rather than "not received".
    """
    raw = _clean(text)
    if not raw:
        return {
            "raw": "",
            "status": WINDOW_MISSING,
            "reason": "unitStatus 单元格为空",
            "received": None,
            "expected": None,
            "unreceived": None,
        }

    normalized = _normalize_digits(raw)
    match = _UNIT_STATUS_FRACTION.search(normalized)
    if match is None:
        # The bar is sometimes spelled out instead of rendered as "X/Y".
        match = _UNIT_STATUS_LABELED.search(normalized)
    if match is None:
        return {
            "raw": raw,
            "status": WINDOW_UNPARSED,
            "reason": "unitStatus 里没有「已入库/预计上架」形式的 X/Y 数字",
            "received": None,
            "expected": None,
            "unreceived": None,
        }

    received, expected = int(match.group(1)), int(match.group(2))
    if expected <= 0:
        return {
            "raw": raw,
            "status": WINDOW_UNPARSED,
            "reason": f"预计上架数量为 {expected}，无法判断货件是否已接收",
            "received": received,
            "expected": expected,
            "unreceived": None,
        }

    return {
        "raw": raw,
        "status": WINDOW_PARSED,
        "reason": "",
        "received": received,
        "expected": expected,
        "unreceived": received < expected,
    }


def parse_calendar_month_label(label: object) -> tuple[int, int]:
    """Parse a calendar month header into ``(year, month)``.

    Deliberately *not* ``own_carrier._parse_calendar_month_label``: that one
    only accepts a month *name* before the year (``十月 2026``) and raises on
    the standard Chinese ``2026年10月`` (verified by running it).  Both orders
    are accepted here because the Katal calendar's header format is still
    unverified against a live page.
    """
    text = _clean(_normalize_digits(label)).replace(" ", "")
    if not text:
        raise DeliveryWindowApplyArgumentError("日历月份标题为空")

    for pattern in (_CALENDAR_MONTH_CN, _CALENDAR_MONTH_NUM_FIRST):
        match = pattern.search(text)
        if match:
            month = int(match.group("month"))
            if 1 <= month <= 12:
                return int(match.group("year")), month

    for pattern in (_CALENDAR_MONTH_NAME_FIRST, _CALENDAR_MONTH_YEAR_FIRST):
        match = pattern.search(text)
        if match:
            name = f"{match.group('name')}月"
            month = _MONTH_NAME_TO_NUMBER.get(name)
            if month:
                return int(match.group("year")), month

    raise DeliveryWindowApplyArgumentError(f"无法解析日历月份标题: {label}")


def select_tracking_tab(tabs: Sequence[Mapping[str, Any]], shipment_id: str) -> dict[str, Any]:
    """Pick the single tracking tab belonging to ``shipment_id``.

    Two tabs carrying the same id is a hard stop: it means the page no longer
    identifies a shipment uniquely, so the plan's row could be the wrong one.
    """
    wanted = _clean(shipment_id).upper()
    matches = [tab for tab in tabs if wanted in [str(item).upper() for item in tab.get("fba_ids") or []]]
    if not matches:
        return {
            "status": "not_found",
            "reason": f"追踪详情里没有找到 {wanted} 的分页",
            "index": None,
            "tab_count": len(tabs),
        }
    if len(matches) > 1:
        return {
            "status": "ambiguous",
            "reason": f"追踪详情里有 {len(matches)} 个分页都含 {wanted}，无法确定是哪一票",
            "index": None,
            "tab_count": len(tabs),
        }
    return {"status": "ok", "reason": "", "index": int(matches[0]["index"]), "tab_count": len(tabs)}


def verify_tab_selection(tabs: Sequence[Mapping[str, Any]], index: int) -> dict[str, Any]:
    """Prove that tab ``index`` — and only it — is the selected one.

    ``page_source`` cannot show which tab is active, so this relies on the
    markers the page itself writes (``aria-selected``, ``selected``, an
    ``active``/``selected`` class).  When no tab carries any marker the answer
    is *unknown*, and unknown is a failure: without it there is no evidence
    that the window about to be changed belongs to the requested shipment.
    """
    if index < 0 or index >= len(tabs):
        return {"status": "unconfirmed", "reason": f"分页序号 {index} 超出范围（共 {len(tabs)} 个）"}

    marked = [
        {"index": int(tab["index"]), "markers": list(tab.get("selection_markers") or [])}
        for tab in tabs
        if tab.get("selected") is not None
    ]
    positives = [int(tab["index"]) for tab in tabs if tab.get("selected") is True]
    target_markers = list(tabs[index].get("selection_markers") or [])

    if positives == [index]:
        return {
            "status": "ok",
            "reason": "",
            "markers": target_markers,
            "marked_tabs": marked,
        }
    if not positives:
        return {
            "status": "unconfirmed",
            "reason": "没有任何分页带「已选中」标记（aria-selected/selected/class 都没读到），无法证明当前打开的是目标货件",
            "markers": target_markers,
            "marked_tabs": marked,
        }
    return {
        "status": "mismatch",
        "reason": f"选中的是分页 {positives}，不是目标分页 [{index}]",
        "markers": target_markers,
        "marked_tabs": marked,
    }


def _parse_timeout(args: Mapping[str, Any]) -> int:
    raw_timeout = args.get("timeout_sec", DEFAULT_TIMEOUT_SECONDS)
    try:
        timeout_sec = int(raw_timeout)
    except (TypeError, ValueError) as exc:
        raise DeliveryWindowApplyArgumentError(
            f"timeout_sec 必须是整数秒，收到: {raw_timeout!r}"
        ) from exc
    if not 1 <= timeout_sec <= MAX_TIMEOUT_SECONDS:
        raise DeliveryWindowApplyArgumentError(
            f"timeout_sec 必须在 1-{MAX_TIMEOUT_SECONDS} 秒之间，收到: {timeout_sec}"
        )
    return timeout_sec


def plan_discover(arguments: Mapping[str, Any]) -> dict[str, Any]:
    """Validate a read-only workflow discovery request.

    One FBA shipment id is the seed used to locate its STA workflow.  The live
    page, not an assumed count, is authoritative for the sibling shipments.
    """
    args = dict(arguments or {})
    timeout_sec = _parse_timeout(args)
    base = dwl.plan_read(args)
    shipment_ids = list(base["shipment_ids"])
    if len(shipment_ids) != 1:
        raise DeliveryWindowApplyArgumentError(
            "action=discover 时 shipment_ids 必须且只能提供 1 个 FBA 货件编号，"
            "程序会用它定位工作流程并动态读取全部子货件"
        )
    if bool(args.get("apply", False)):
        raise DeliveryWindowApplyArgumentError("action=discover 是只读操作，不能同时传 apply=true")
    return {
        "action": ACTION_DISCOVER,
        "store_id": base["store_id"],
        "page_url": base["page_url"],
        "shipment_ids": shipment_ids,
        "seed_shipment_id": shipment_ids[0],
        "apply": False,
        "timeout_sec": timeout_sec,
        "plan_only": bool(base["plan_only"]),
    }


def plan_apply(arguments: Mapping[str, Any], *, now: _dt.datetime | None = None) -> dict[str, Any]:
    """Validate and normalize the argument contract.  Pure; no side effects.

    ``store_id`` / ``page_url`` / ``shipment_ids`` are validated by
    ``delivery_window_list.plan_read`` so both commands share one contract.
    """
    args = dict(arguments or {})
    timeout_sec = _parse_timeout(args)
    base = dwl.plan_read(args)

    shipment_ids = list(base["shipment_ids"])
    if not shipment_ids:
        raise DeliveryWindowApplyArgumentError(
            "shipment_ids 不能为空：改期必须指定要处理的 FBA 货件编号"
        )

    moment = now or _dt.datetime.now(_dt.timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=_dt.timezone.utc)
    today = moment.date()

    target_date = parse_target_date(args.get("target_date"), today=today)
    start, end = calendar_week_span(target_date)
    if end < today:
        raise DeliveryWindowApplyArgumentError(
            f"target_date {target_date.isoformat()} 所在的送达周 "
            f"{format_cn_window(start, end)} 已经过去（今天 {today.isoformat()}，按 UTC）；"
            f"若你指的是下一年，请写成带年份的 {end.year + 1}-{target_date.month:02d}-{target_date.day:02d}"
        )

    return {
        "action": ACTION_APPLY,
        "store_id": base["store_id"],
        "page_url": base["page_url"],
        "shipment_ids": shipment_ids,
        "target_date": target_date.isoformat(),
        "target_window": {
            "start_date": start.isoformat(),
            "end_date": end.isoformat(),
            "span_days": (end - start).days + 1,
            "display": format_cn_window(start, end),
        },
        "target_date_input": _clean(args.get("target_date")),
        "apply": bool(args.get("apply", False)),
        "timeout_sec": timeout_sec,
        "plan_only": bool(base["plan_only"]),
        "today": today.isoformat(),
    }


def _plan_dates(plan: Mapping[str, Any]) -> tuple[_dt.date, _dt.date]:
    window = plan["target_window"]
    return (
        _dt.date.fromisoformat(str(window["start_date"])),
        _dt.date.fromisoformat(str(window["end_date"])),
    )


def _origin(page_url: str) -> str:
    parts = urlsplit(str(page_url))
    return f"{parts.scheme}://{parts.netloc}"


# --------------------------------------------------------------------------
# HTML reads (BeautifulSoup over ``driver.page_source``).
# --------------------------------------------------------------------------


def _soup(html: object) -> BeautifulSoup:
    return BeautifulSoup(str(html or ""), "html.parser")


def _first(root: Tag | BeautifulSoup, selector: str) -> Tag | None:
    found = root.select(selector)
    return found[0] if found else None


def direct_text(node: Tag) -> str:
    """Text that belongs to ``node`` itself, ignoring every child element.

    This is what keeps a label like 「送达时段:」 readable even when the same
    container also holds a tooltip and a help link.
    """
    parts = [
        str(child)
        for child in node.children
        if isinstance(child, NavigableString) and not isinstance(child, Comment)
    ]
    return _clean(" ".join(parts))


def _label_elements(root: Tag | BeautifulSoup, labels: Sequence[str]) -> list[Tag]:
    """Elements whose *own* text is exactly one of ``labels`` (colon optional)."""
    wanted = {_label_key(label) for label in labels}
    elements: list[Tag] = []
    for text_node in root.find_all(string=lambda value: _label_key(value) in wanted):
        parent = text_node.parent
        if isinstance(parent, Tag) and _label_key(direct_text(parent)) in wanted:
            elements.append(parent)
    return elements


def _window_candidates(element: Tag) -> list[dict[str, str]]:
    """Text candidates for the value next to a label, best first."""
    candidates: list[dict[str, str]] = []
    sibling = element.find_next_sibling()
    if isinstance(sibling, Tag):
        text = direct_text(sibling)
        if text:
            candidates.append({"source": "next-sibling-direct", "text": text})

    own = direct_text(element)
    whole = _clean(element.get_text(" "))
    if own and whole.startswith(own) and len(whole) > len(own):
        candidates.append({"source": "self-subtree", "text": _clean(whole[len(own) :])})
    elif not own and whole:
        candidates.append({"source": "self-subtree", "text": whole})
    return candidates


def _inline_window_candidates(
    root: Tag | BeautifulSoup, labels: Sequence[str]
) -> list[dict[str, str]]:
    """Read ``label: value`` when Amazon renders both in one text node."""
    wanted = sorted({_label_key(label) for label in labels}, key=len, reverse=True)
    candidates: list[dict[str, str]] = []
    for text_node in root.find_all(string=True):
        text = _clean(text_node)
        for label in wanted:
            match = re.fullmatch(rf"{re.escape(label)}\s*[:：]\s*(.+)", text)
            if match is not None:
                candidates.append(
                    {"source": "inline-direct", "text": _clean(match.group(1))}
                )
                break
    return candidates


def read_current_window_text(html: object) -> dict[str, Any]:
    """Read the live delivery window, preferring the modal over the page.

    Among the candidates next to the label, the first one that parses as a
    delivery window wins — that is what keeps tooltip/help prose out of the
    result without hard-coding which element is clean.
    """
    soup = _soup(html)
    modal = _first(soup, MODAL_BODY_SELECTOR)
    scopes = [
        (modal, "modal", (CURRENT_WINDOW_LABEL,)),
        (soup, "page", PAGE_WINDOW_LABELS),
    ]
    for root, scope, labels in scopes:
        if root is None:
            continue
        candidates = [
            {"source": f"{scope}:{candidate['source']}", "text": candidate["text"]}
            for candidate in _inline_window_candidates(root, labels)
        ]
        for element in _label_elements(root, labels):
            for candidate in _window_candidates(element):
                candidates.append(
                    {"source": f"{scope}:{candidate['source']}", "text": candidate["text"]}
                )
        if not candidates:
            continue
        for candidate in candidates:
            window = dwl.parse_delivery_window(candidate["text"])
            if window["status"] == WINDOW_PARSED:
                return {
                    "status": WINDOW_PARSED,
                    "raw": candidate["text"],
                    "source": candidate["source"],
                    "scope": scope,
                    "window": window,
                    "candidates": candidates,
                }
        return {
            "status": WINDOW_UNPARSED,
            "raw": candidates[0]["text"],
            "source": candidates[0]["source"],
            "scope": scope,
            "window": dwl.parse_delivery_window(candidates[0]["text"]),
            "candidates": candidates,
        }

    return {
        "status": WINDOW_MISSING,
        "raw": "",
        "source": "",
        "scope": "",
        "window": None,
        "candidates": [],
    }


def read_grace_text(html: object) -> dict[str, Any]:
    """Read the 「在 … 之前」 sentence from the testid, else from any text node."""
    soup = _soup(html)
    node = _first(soup, GRACE_SELECTOR)
    if node is not None:
        text = _clean(node.get_text(" "))
        if text:
            return {"text": text, "source": "grace-period-testid"}

    modal = _first(soup, MODAL_BODY_SELECTOR)
    for root, scope in ((modal, "modal"), (soup, "page")):
        if root is None:
            continue
        found = root.find(string=lambda value: bool(_GRACE_PHRASE.search(_normalize_digits(value))))
        if found is not None:
            match = _GRACE_PHRASE.search(_normalize_digits(found))
            if match is not None:
                return {"text": _clean(match.group(0)), "source": f"{scope}-text"}
    return {"text": "", "source": ""}


def read_edit_link_state(html: object) -> dict[str, Any]:
    """Read the edit entry state; tooltip copy is diagnostic, not a disabled flag."""
    soup = _soup(html)
    link = _first(soup, EDIT_LINK_SELECTOR)
    tooltip = _first(soup, EDIT_TOOLTIP_SELECTOR)
    tooltip_text = _clean(tooltip.get_text(" ")) if tooltip is not None else ""
    disabled = False
    if link is not None:
        disabled = link.has_attr("disabled") or _clean(link.get("aria-disabled")).lower() == "true"
    blocked = disabled
    if disabled:
        block_reason = "编辑入口为 disabled"
    else:
        block_reason = ""
    return {
        "present": link is not None,
        "disabled": disabled,
        "blocked": blocked,
        "block_reason": block_reason,
        "tooltip_text": tooltip_text,
    }


def read_legend_selected_text(html: object) -> dict[str, Any]:
    """Read the week marked 「已选择」 in the modal legend."""
    soup = _soup(html)
    for item in soup.select(LEGEND_ITEM_SELECTOR):
        item_text = _clean(item.get_text(" "))
        markers: list[str] = []
        classes = " ".join(item.get("class") or [])
        if LEGEND_SELECTED_CLASS in classes:
            markers.append("item-class")
        if LEGEND_SELECTED_LABEL in item_text:
            markers.append("item-text")
        for child in item.find_all(True):
            child_classes = " ".join(child.get("class") or [])
            if LEGEND_SELECTED_CLASS in child_classes:
                markers.append("descendant-class")
                break
        if not markers:
            continue

        candidates = [_clean(item_text.replace(LEGEND_SELECTED_LABEL, " ", 1))]
        for child in item.find_all(True):
            candidates.append(_clean(child.get_text(" ").replace(LEGEND_SELECTED_LABEL, " ", 1)))
        for candidate in candidates:
            window = dwl.parse_delivery_window(candidate)
            if window["status"] == WINDOW_PARSED:
                return {
                    "status": WINDOW_PARSED,
                    "raw": candidate,
                    "item_text": item_text,
                    "matched_by": markers,
                    "window": window,
                    "candidates": candidates,
                }
        return {
            "status": WINDOW_UNPARSED,
            "raw": candidates[0] if candidates else "",
            "item_text": item_text,
            "matched_by": markers,
            "window": dwl.parse_delivery_window(candidates[0] if candidates else ""),
            "candidates": candidates,
        }

    return {
        "status": WINDOW_MISSING,
        "raw": "",
        "item_text": "",
        "matched_by": [],
        "window": None,
        "candidates": [],
    }


def _button_disabled(button: Tag) -> bool:
    if not button.has_attr("disabled"):
        return False
    raw = str(button.get("disabled") or "").strip().lower()
    return raw not in {"false", "0"}


def read_update_button_state(html: object) -> dict[str, Any]:
    """Read the confirm button: present? disabled? what does it say?"""
    soup = _soup(html)
    button = _first(soup, UPDATE_BUTTON_SELECTOR)
    if button is None:
        return {"present": False, "disabled": None, "label": "", "aria_disabled": ""}
    aria = _clean(button.get("aria-disabled") or "")
    disabled = _button_disabled(button) or aria.lower() == "true"
    label = _clean(button.get("label") or button.get_text(" "))
    return {"present": True, "disabled": bool(disabled), "label": label, "aria_disabled": aria}


def _tab_selected(tab: Tag) -> tuple[bool | None, list[str]]:
    """``(selected, markers)``; ``None`` means the page told us nothing."""
    positives: list[str] = []
    negatives: list[str] = []

    if tab.has_attr("selected"):
        value = str(tab.get("selected") or "").strip().lower()
        if value in {"", "true", "1", "selected"}:
            positives.append("selected-attr")
        else:
            negatives.append(f"selected-attr={value}")

    for attribute in ("aria-selected", "data-selected", "data-active"):
        value = tab.get(attribute)
        if value is None:
            continue
        lowered = str(value).strip().lower()
        if lowered in {"true", "1", "yes", "selected"}:
            positives.append(f"{attribute}={lowered}")
        else:
            negatives.append(f"{attribute}={lowered}")

    aria_current = tab.get("aria-current")
    if aria_current is not None:
        lowered = str(aria_current).strip().lower()
        if lowered in {"page", "true", "step"}:
            positives.append(f"aria-current={lowered}")
        else:
            negatives.append(f"aria-current={lowered}")

    def check_classes(node: Tag, prefix: str) -> None:
        classes = {str(item).strip().lower() for item in (node.get("class") or [])}
        for negative in ("not-selected", "non-selected", "inactive"):
            if negative in classes:
                negatives.append(f"{prefix}-class={negative}")
        for positive in ("selected", "active", "current", "kat-tab-active"):
            if positive in classes:
                positives.append(f"{prefix}-class={positive}")
                return

    check_classes(tab, "self")
    for child in tab.find_all(True):
        before = len(positives)
        check_classes(child, "descendant")
        if len(positives) > before:
            break
        child_aria = child.get("aria-selected")
        if child_aria is not None and str(child_aria).strip().lower() == "true":
            positives.append("descendant-aria-selected")
            break

    if positives:
        return True, positives
    if negatives:
        return False, negatives
    return None, []


def read_tracking_tabs(html: object) -> list[dict[str, Any]]:
    """Read the shipment tabs of the tracking detail.

    The FBA id is looked for in the tab text *and* in its attributes, because
    the page may carry it either way.
    """
    soup = _soup(html)
    tabs: list[dict[str, Any]] = []
    for index, tab in enumerate(soup.select(TRACKING_TAB_SELECTOR)):
        text = _clean(tab.get_text(" "))
        haystack = " ".join([text] + [str(value) for value in tab.attrs.values() if value])
        fba_ids = list(dict.fromkeys(_FBA_ID_IN_TEXT.findall(_normalize_digits(haystack).upper())))
        selected, markers = _tab_selected(tab)
        tabs.append(
            {
                "index": index,
                "text": text[:160],
                "fba_ids": fba_ids,
                "selected": selected,
                "selection_markers": markers,
            }
        )
    return tabs


def inspect_selected_shipment(html: object, *, now: _dt.datetime) -> dict[str, Any]:
    """Describe whether the currently selected shipment tab is editable.

    This is deliberately a read-only, conservative check.  ``editable=true``
    requires all three live facts: a parsed current window, an unexpired grace
    deadline, and the edit entry being present.  Missing or unparseable facts
    are reported as ``unknown`` instead of being guessed.
    """
    source = str(html or "")
    current = read_current_window_text(source)
    grace_text = read_grace_text(source)
    grace = parse_grace_period(grace_text["text"], now=now)
    edit_link = read_edit_link_state(source)

    if current["status"] != WINDOW_PARSED:
        status = "unknown"
        editable: bool | None = None
        reason = f"当前送达时段无法读取（{current['status']}）"
    elif edit_link["blocked"]:
        status = "locked"
        editable = False
        reason = f"Amazon 明确禁止编辑：{edit_link['block_reason']}"
    elif grace["status"] != WINDOW_PARSED:
        status = "unknown"
        editable = None
        reason = f"可编辑截止时间无法读取（{grace['reason']}）"
    elif not grace["editable"]:
        status = "locked"
        editable = False
        reason = f"可编辑截止时间 {grace['deadline']} 已过"
    elif not edit_link["present"]:
        status = "unavailable"
        editable = False
        reason = f"页面没有编辑时段入口（{EDIT_LINK_SELECTOR}）"
    else:
        status = "editable"
        editable = True
        reason = "页面存在编辑入口，且可编辑截止时间尚未到"

    return {
        "status": status,
        "editable": editable,
        "reason": reason,
        "current_window": current.get("window"),
        "current_window_read": current,
        "grace": grace,
        "grace_text": grace_text,
        "edit_link_present": edit_link["present"],
        "edit_link": edit_link,
    }


def read_sta_link(html: object) -> dict[str, Any]:
    """Read the STA (``/fba/sendtoamazon?wf=``) link of the detail page."""
    soup = _soup(html)
    for selector, source in ((STA_LINK_SELECTOR, "shipment-info-details"), (STA_LINK_ANY_SELECTOR, "page")):
        node = _first(soup, selector)
        if node is None:
            continue
        href = _clean(node.get("href") or "")
        if not href:
            inner = node.find("a", href=True)
            href = _clean(inner.get("href")) if inner is not None else ""
        if href:
            return {"href": href, "source": source}
    return {"href": "", "source": ""}


# --------------------------------------------------------------------------
# Hub rows (shipment id + lifecycle status + delivery window + unit status).
# --------------------------------------------------------------------------


def build_hub_rows(cells: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Group hub cells into rows, keeping lifecycle and inventory evidence."""
    order: list[str] = []
    rows: dict[str, dict[str, Any]] = {}
    duplicates: list[dict[str, str]] = []

    for cell in cells:
        if not isinstance(cell, Mapping):
            continue
        row_id = _clean(cell.get("rowId"))
        column = _clean(cell.get("column"))
        if not row_id or not column:
            continue
        if row_id not in rows:
            rows[row_id] = {
                "fba_shipment_id": row_id,
                "shipment_id_cell_text": "",
                "order_status_text": "",
                "order_status_cell_text": "",
                "order_status_cell_type": "",
                "order_status_cell_variant": "",
                "delivery_window_text": "",
                "delivery_window_cell_text": "",
                "unit_status_text": "",
                "unit_status_cell_text": "",
                "unit_status_cell_type": "",
                "unit_status_cell_variant": "",
            }
            order.append(row_id)
        row = rows[row_id]
        text = _clean(cell.get("text"))
        cell_text = _clean(cell.get("cellText"))
        if column == dwl.SHIPMENT_ID_COLUMN:
            # The row key *is* the shipment id; the cell text is kept only so the
            # report can show whether the page still agrees with that.
            if not row["shipment_id_cell_text"]:
                row["shipment_id_cell_text"] = text
            continue
        if column == dwl.DELIVERY_WINDOW_COLUMN:
            if row["delivery_window_text"]:
                duplicates.append({"rowId": row_id, "column": column})
                continue
            row["delivery_window_text"] = text
            row["delivery_window_cell_text"] = cell_text
            continue
        if column == ORDER_STATUS_COLUMN:
            if row["order_status_text"]:
                duplicates.append({"rowId": row_id, "column": column})
                continue
            row["order_status_text"] = text
            row["order_status_cell_text"] = cell_text
            row["order_status_cell_type"] = _clean(cell.get("cellType"))
            row["order_status_cell_variant"] = _clean(cell.get("cellVariant"))
            continue
        if column == UNIT_STATUS_COLUMN:
            if row["unit_status_text"]:
                duplicates.append({"rowId": row_id, "column": column})
                continue
            row["unit_status_text"] = text
            row["unit_status_cell_text"] = cell_text
            row["unit_status_cell_type"] = _clean(cell.get("cellType"))
            row["unit_status_cell_variant"] = _clean(cell.get("cellVariant"))

    return {
        "rows": [rows[row_id] for row_id in order],
        "by_id": rows,
        "duplicates": duplicates,
        "row_count": len(order),
    }


_READ_HUB_CELLS_SCRIPT = r"""
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
    cellType: String(cell.getAttribute('data-cell-type') || ''),
    cellVariant: String(cell.getAttribute('data-cell-variant') || ''),
  });
}
return out;
"""


def read_hub_cells(driver: Any) -> list[dict[str, Any]]:
    """Read the four hub columns used for identity, status, and diagnostics."""
    payload = driver.execute_script(
        SHADOW_DOM_HELPERS_JS + _READ_HUB_CELLS_SCRIPT,
        SHIPMENT_HUB_CELL_SELECTOR,
        f"{dwl.SHIPMENT_ID_COLUMN},{ORDER_STATUS_COLUMN},"
        f"{dwl.DELIVERY_WINDOW_COLUMN},{UNIT_STATUS_COLUMN}",
        PRIMARY_ATOM_SELECTOR,
    )
    if not isinstance(payload, list):
        return []
    return [dict(item) for item in payload if isinstance(item, Mapping)]


# --------------------------------------------------------------------------
# Page scripts (clicks and shadow-DOM calendar).
# --------------------------------------------------------------------------

_CLICK_SEQUENCE_JS = r"""
function dispatchClick(el) {
  if (!el) return false;
  try {
    el.scrollIntoView({ block: 'center', inline: 'center' });
  } catch (error) {
    // scrolling is best effort
  }
  const rect = (typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : null;
  const options = {
    bubbles: true,
    cancelable: true,
    // composed keeps the event visible across a shadow boundary, which is how
    // the Katal calendar and button components listen.
    composed: true,
    view: window,
  };
  if (rect) {
    options.clientX = rect.left + (rect.width / 2);
    options.clientY = rect.top + (rect.height / 2);
  }
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    let event = null;
    try {
      const EventClass = (type.indexOf('pointer') === 0 && typeof PointerEvent === 'function')
        ? PointerEvent
        : MouseEvent;
      event = new EventClass(type, options);
    } catch (error) {
      event = null;
    }
    if (!event) {
      try {
        event = new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window });
      } catch (innerError) {
        event = null;
      }
    }
    if (event) el.dispatchEvent(event);
  }
  if (typeof el.click === 'function') {
    try {
      el.click();
    } catch (error) {
      return true;
    }
  }
  return true;
}
"""

_CLICK_SELECTOR_SCRIPT = _CLICK_SEQUENCE_JS + r"""
const selector = String(arguments[0] || '');
return dispatchClick(deepQuerySelector(selector));
"""

_CLICK_NTH_SCRIPT = _CLICK_SEQUENCE_JS + r"""
const selector = String(arguments[0] || '');
const index = Number(arguments[1]);
const nodes = Array.from(deepQuerySelectorAll(selector) || []);
return dispatchClick(nodes[index] || null);
"""

_CLICK_TRACKING_STEP_VIEW_SCRIPT = _CLICK_SEQUENCE_JS + r"""
const selector = String(arguments[0] || '');
const links = Array.from(deepQuerySelectorAll(selector) || []);

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function composedParent(node) {
  if (!node) return null;
  if (node.parentElement) return node.parentElement;
  const root = (typeof node.getRootNode === 'function') ? node.getRootNode() : null;
  return root && root.host ? root.host : null;
}

function isTrackingFinalStep(text) {
  const chinese = text.indexOf('最后一步') !== -1 && text.indexOf('追踪详情') !== -1;
  const english = text.indexOf('final step') !== -1 && text.indexOf('tracking detail') !== -1;
  return chinese || english;
}

let best = null;
for (const link of links) {
  let node = link;
  for (let depth = 0; node && depth < 10; depth += 1) {
    if (isTrackingFinalStep(cleanText(node.innerText || node.textContent || ''))) {
      if (!best || depth < best.depth) best = { link, depth };
      break;
    }
    node = composedParent(node);
  }
}
return best ? dispatchClick(best.link) : false;
"""

_SELECTOR_PRESENT_SCRIPT = r"""
const selector = String(arguments[0] || '');
return Boolean(deepQuerySelector(selector));
"""

_SELECTOR_COUNT_SCRIPT = r"""
const selector = String(arguments[0] || '');
return Array.from(deepQuerySelectorAll(selector) || []).length;
"""

_CALENDAR_SCOPE_JS = r"""
const calendarSelector = String(arguments[0] || '');

function scopedQuerySelectorAll(selector, root) {
  const results = [];
  const seen = new Set();
  function add(el) {
    if (!el || seen.has(el)) return;
    seen.add(el);
    results.push(el);
  }
  function walk(node) {
    if (!node) return;
    if (node.matches && node.matches(selector)) add(node);
    if (node.querySelectorAll) {
      for (const match of node.querySelectorAll(selector)) add(match);
      for (const child of node.querySelectorAll('*')) {
        if (child.shadowRoot) walk(child.shadowRoot);
      }
    }
    if (node.shadowRoot) walk(node.shadowRoot);
  }
  walk(root);
  return results;
}

function scopedQuerySelector(selector, root) {
  return scopedQuerySelectorAll(selector, root)[0] || null;
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getCalendar() {
  return deepQuerySelector(calendarSelector);
}
"""

_CALENDAR_MONTH_BODY = _CALENDAR_SCOPE_JS + r"""
const calendar = getCalendar();
if (!calendar) return '';
const month = scopedQuerySelector('.cal-month', calendar)
  || scopedQuerySelector('[part="calendar-month"]', calendar);
return month ? cleanText(month.innerText || month.textContent || '') : '';
"""

_CALENDAR_DAY_COUNT_BODY = _CALENDAR_SCOPE_JS + r"""
const calendar = getCalendar();
if (!calendar) return -1;
return scopedQuerySelectorAll('button[aria-label]', calendar).length;
"""

_CALENDAR_STEP_MONTH_BODY = _CALENDAR_SCOPE_JS + r"""
const direction = String(arguments[1] || '');
const calendar = getCalendar();
if (!calendar) return false;
const selector = (direction === 'prev')
  ? '[part="calendar-prev-month"]'
  : '[part="calendar-next-month"]';
return dispatchClick(scopedQuerySelector(selector, calendar));
"""

_CALENDAR_CLICK_DAY_BODY = _CALENDAR_SCOPE_JS + r"""
const labelPrefix = String(arguments[1] || '').trim();
const calendar = getCalendar();
if (!calendar) return false;

function isDisabled(button) {
  if (button.disabled) return true;
  if (String(button.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return true;
  const cell = (typeof deepClosest === 'function') ? deepClosest(button, 'td') : null;
  if (cell && cell.classList && cell.classList.contains('disabled')) return true;
  return false;
}

for (const button of scopedQuerySelectorAll('button[aria-label]', calendar)) {
  const label = String(button.getAttribute('aria-label') || '').trim();
  if (!labelPrefix || label.indexOf(labelPrefix) !== 0) continue;
  if (isDisabled(button)) continue;
  return dispatchClick(button);
}
return false;
"""


def _calendar_script(body: str) -> str:
    """One shadow-DOM-aware script: traversal helpers + click sequence + body."""
    return SHADOW_DOM_HELPERS_JS + _CLICK_SEQUENCE_JS + body


def _read_page(driver: Any) -> str:
    return str(getattr(driver, "page_source", "") or "")


def _click_selector(driver: Any, selector: str) -> bool:
    return bool(driver.execute_script(SHADOW_DOM_HELPERS_JS + _CLICK_SELECTOR_SCRIPT, selector))


def _click_nth(driver: Any, selector: str, index: int) -> bool:
    return bool(driver.execute_script(SHADOW_DOM_HELPERS_JS + _CLICK_NTH_SCRIPT, selector, int(index)))


def _click_tracking_step_view(driver: Any) -> bool:
    """Expand the final Tracking details step without relying on link order."""
    return bool(
        driver.execute_script(
            SHADOW_DOM_HELPERS_JS + _CLICK_TRACKING_STEP_VIEW_SCRIPT,
            STEP_VIEW_LINK_SELECTOR,
        )
    )


def _selector_present(driver: Any, selector: str) -> bool:
    return bool(driver.execute_script(SHADOW_DOM_HELPERS_JS + _SELECTOR_PRESENT_SCRIPT, selector))


def _selector_count(driver: Any, selector: str) -> int:
    try:
        return int(driver.execute_script(SHADOW_DOM_HELPERS_JS + _SELECTOR_COUNT_SCRIPT, selector))
    except (TypeError, ValueError):
        return 0


def _read_calendar_month(driver: Any) -> str:
    return _clean(driver.execute_script(_calendar_script(_CALENDAR_MONTH_BODY), CALENDAR_SELECTOR))


def _count_calendar_days(driver: Any) -> int:
    try:
        return int(driver.execute_script(_calendar_script(_CALENDAR_DAY_COUNT_BODY), CALENDAR_SELECTOR))
    except (TypeError, ValueError):
        return -1


def _step_calendar_month(driver: Any, direction: str) -> bool:
    return bool(
        driver.execute_script(
            _calendar_script(_CALENDAR_STEP_MONTH_BODY), CALENDAR_SELECTOR, str(direction)
        )
    )


def _click_calendar_day(driver: Any, day: _dt.date) -> bool:
    label_prefix = f"{day.year}年{day.month}月{day.day}日"
    return bool(
        driver.execute_script(
            _calendar_script(_CALENDAR_CLICK_DAY_BODY), CALENDAR_SELECTOR, label_prefix
        )
    )


def _wait_until(
    check: Callable[[], Any],
    *,
    timeout_seconds: float,
    interval_seconds: float = _WAIT_INTERVAL_SECONDS,
) -> Any:
    """Poll ``check`` until it is truthy; ``timeout_seconds=0`` checks once."""
    deadline = time.monotonic() + max(0.0, float(timeout_seconds))
    while True:
        result = check()
        if result:
            return result
        if time.monotonic() >= deadline:
            return result
        _SLEEP(interval_seconds)


# --------------------------------------------------------------------------
# Orchestration.
# --------------------------------------------------------------------------


class _HardFailure(RuntimeError):
    """A page fact that must stop the run, carrying its code and evidence."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class _Trail:
    """Step log, so the artifact shows what was actually done."""

    def __init__(self) -> None:
        self.entries: list[dict[str, str]] = []

    def note(self, step: str, detail: object = "") -> None:
        self.entries.append({"step": str(step), "detail": _clean(detail)})


def _fail(code: str, message: str) -> None:
    raise _HardFailure(code, message)


def _read_hub_status(
    row: Mapping[str, Any], shipment_id: str, trail: _Trail
) -> dict[str, Any]:
    order_status = _clean(row.get("order_status_text"))
    unit = parse_unit_status(row.get("unit_status_text"))
    trail.note(
        "E1 列表状态校验",
        f"orderStatus='{order_status}' unitStatus='{unit.get('raw')}' "
        f"unitStatusParse={unit.get('status')} "
        f"received={unit.get('received')} expected={unit.get('expected')}",
    )
    if not order_status:
        _fail(
            "E1",
            f"{shipment_id} 的 orderStatus 读不出来；"
            f"状态单元格原文: '{row.get('order_status_cell_text') or row.get('order_status_text')}'",
        )
    return {"order_status": order_status, "unit_status": unit}


def _require_hub_status(
    row: Mapping[str, Any], shipment_id: str, trail: _Trail
) -> dict[str, Any]:
    status = _read_hub_status(row, shipment_id, trail)
    order_status = status["order_status"]
    if order_status not in EDITABLE_ORDER_STATUSES:
        _fail(
            "E1",
            f"{shipment_id} 的 orderStatus='{order_status}'，不属于允许修改送达时段的状态"
            f"（当前仅允许: {', '.join(sorted(EDITABLE_ORDER_STATUSES))}）；未进入货件详情",
        )
    # ``unitStatus`` is the inventory pipeline, not the shipment lifecycle.
    # Keep it in the artifact for diagnosis, but never infer editability from
    # X/Y equality.  The tracking page's grace period and edit modal remain the
    # authoritative downstream E3/E4 gates after this business gate passes.
    return status


def _open_tracking_detail(
    driver: Any,
    *,
    detail_url: str,
    timeout_seconds: float,
    trail: _Trail,
) -> None:
    def reveal_tabs() -> bool:
        _wait_until(
            lambda: (
                _selector_count(driver, TRACKING_TAB_SELECTOR) > 0
                or _selector_count(driver, STEP_VIEW_LINK_SELECTOR) > 0
            ),
            timeout_seconds=timeout_seconds,
        )
        if _selector_count(driver, TRACKING_TAB_SELECTOR) > 0:
            return True
        if _selector_count(driver, STEP_VIEW_LINK_SELECTOR) <= 0:
            return False
        clicked = _click_tracking_step_view(driver)
        trail.note(
            "E2a 展开最后一步",
            f"selector={STEP_VIEW_LINK_SELECTOR} click={clicked}",
        )
        if not clicked:
            return False
        return bool(
            _wait_until(
                lambda: _selector_count(driver, TRACKING_TAB_SELECTOR) > 0,
                timeout_seconds=timeout_seconds,
            )
        )

    driver.get(detail_url)
    _wait_until(
        lambda: bool(read_sta_link(_read_page(driver))["href"]),
        timeout_seconds=timeout_seconds,
    )
    link = read_sta_link(_read_page(driver))
    if not link["href"]:
        _fail(
            "E2",
            f"详情页 {detail_url} 上找不到 STA 追踪链接"
            f"（{STA_LINK_SELECTOR}）；可能货件还没进入 Send To Amazon 工作流",
        )
    trail.note("E2a 打开追踪详情", f"detail={detail_url} sta={link['href']} via={link['source']}")

    driver.get(urljoin(detail_url, link["href"]))
    opened = reveal_tabs()
    if not opened:
        trail.note(
            "E2a 回退",
            "直开 STA URL 未出现分页且无法展开最后一步，改为在详情页点击追踪详情链接",
        )
        driver.get(detail_url)
        _wait_until(
            lambda: _selector_present(driver, SHIPMENT_INFO_DETAILS_SELECTOR),
            timeout_seconds=timeout_seconds,
        )
        if not _click_selector(driver, STA_LINK_SELECTOR):
            _fail("E2", f"点击 STA 追踪链接失败（{STA_LINK_SELECTOR}）；详情页原文: {_read_page(driver)[:400]}")
        opened = reveal_tabs()
    if not opened:
        _fail(
            "E2",
            f"追踪详情页没有出现货件分页（{TRACKING_TAB_SELECTOR}），"
            f"也无法通过最后一步的查看链接（{STEP_VIEW_LINK_SELECTOR}）展开；"
            f"当前 URL: {getattr(driver, 'current_url', '')}",
        )

    readiness: dict[str, Any] = {}

    def tracking_details_ready() -> bool:
        html = _read_page(driver)
        readiness["current_window"] = read_current_window_text(html)
        readiness["grace_text"] = read_grace_text(html)
        return (
            readiness["current_window"]["status"] != WINDOW_MISSING
            and bool(readiness["grace_text"]["text"])
        )

    ready = bool(
        _wait_until(
            tracking_details_ready,
            timeout_seconds=min(timeout_seconds, LEGEND_TIMEOUT_SECONDS),
        )
    )
    trail.note(
        "E2a 追踪详情加载",
        f"ready={ready} currentWindow={readiness.get('current_window', {}).get('status', '')} "
        f"gracePresent={bool(readiness.get('grace_text', {}).get('text'))}",
    )


def _select_shipment_tab(
    driver: Any,
    shipment_id: str,
    *,
    timeout_seconds: float,
    trail: _Trail,
) -> dict[str, Any]:
    tabs = read_tracking_tabs(_read_page(driver))
    selection = select_tracking_tab(tabs, shipment_id)
    trail.note(
        "E2b 选中货件分页",
        f"tabs={[{'index': tab['index'], 'fba_ids': tab['fba_ids'], 'selected': tab['selected']} for tab in tabs]} "
        f"-> {selection['status']}",
    )
    if selection["status"] != "ok":
        _fail("E2", f"{shipment_id}: {selection['reason']}；页面上读到 {len(tabs)} 个分页")

    index = int(selection["index"])
    if tabs[index].get("selected") is not True:
        _click_nth(driver, TRACKING_TAB_SELECTOR, index)
        verdict = _wait_for_tab_selection(
            driver, index, timeout_seconds=min(timeout_seconds, LEGEND_TIMEOUT_SECONDS)
        )
        if verdict["status"] != "ok":
            _fail(
                "E2",
                f"{shipment_id}: 点了第 {index} 个分页后仍无法确认它是选中项（{verdict['reason']}）；"
                f"各分页标记: {verdict.get('marked_tabs')}",
            )

    confirmed = verify_tab_selection(read_tracking_tabs(_read_page(driver)), index)
    trail.note("E2b 分页已确认", f"index={index} verdict={confirmed}")
    if confirmed["status"] != "ok":
        _fail(
            "E2",
            f"{shipment_id}: 分页切换后无法唯一确认目标分页（{confirmed['reason']}）；"
            f"标记: {confirmed.get('marked_tabs')}",
        )
    return {"tabs": tabs, "index": index, "verdict": confirmed}


def _wait_for_tab_selection(driver: Any, index: int, *, timeout_seconds: float) -> dict[str, Any]:
    """Poll until tab ``index`` is provably the selected one, else last verdict."""
    state: dict[str, Any] = {"verdict": {"status": "unconfirmed", "reason": "尚未重新读取分页状态"}}

    def check() -> bool:
        state["verdict"] = verify_tab_selection(read_tracking_tabs(_read_page(driver)), index)
        return state["verdict"]["status"] == "ok"

    _wait_until(check, timeout_seconds=timeout_seconds)
    return state["verdict"]


def _read_editable_window(
    driver: Any,
    *,
    now: _dt.datetime,
    trail: _Trail,
) -> tuple[dict[str, Any], dict[str, Any]]:
    html = _read_page(driver)
    grace_text = read_grace_text(html)
    grace = parse_grace_period(grace_text["text"], now=now)
    trail.note(
        "E3 可编辑截止",
        f"text='{grace_text['text']}' via={grace_text['source']} -> {grace['status']} deadline={grace['deadline']}",
    )
    if grace["status"] != WINDOW_PARSED:
        _fail("E3", f"读不到送达时段的可编辑截止时间（{grace['reason']}）；页面原文: '{grace_text['text']}'")
    if not grace["editable"]:
        _fail(
            "E3",
            f"送达时段已锁定：截止时间 {grace['deadline']} 已过"
            f"（页面文案: '{grace['raw']}'）",
        )

    current = read_current_window_text(html)
    window = current["window"] if isinstance(current.get("window"), Mapping) else None
    trail.note(
        "E9 当前送达时段",
        f"raw='{current['raw']}' source={current['source']} scope={current['scope']} -> {current['status']}",
    )
    if current["status"] != WINDOW_PARSED or window is None:
        _fail(
            "E9",
            f"读不到当前送达时段（{current['status']}）；候选文本: "
            f"{[candidate['text'] for candidate in current['candidates']]}",
        )
    return grace, {"read": current, "window": dict(window)}


def _goto_calendar_month(driver: Any, target: _dt.date, *, trail: _Trail) -> None:
    label = _read_calendar_month(driver)
    if not label:
        _fail(
            "E7",
            f"读不到日历月份标题（{CALENDAR_SELECTOR} 内 .cal-month / [part=\"calendar-month\"]）；"
            "日历结构可能变了",
        )
    try:
        current = parse_calendar_month_label(label)
    except DeliveryWindowApplyArgumentError as exc:
        _fail("E7", f"日历月份标题无法解析: {exc}")

    wanted = (target.year, target.month)
    for _ in range(MAX_MONTH_STEPS):
        if current == wanted:
            day_count = _count_calendar_days(driver)
            if day_count <= 0:
                _fail(
                    "E7",
                    f"日历已到 {current[0]}年{current[1]}月，但读不到日期格子"
                    f"（button[aria-label] 数量={day_count}）",
                )
            trail.note("E7 日历定位", f"{current[0]}年{current[1]}月 day_buttons={day_count}")
            return
        direction = "next" if current < wanted else "prev"
        if not _step_calendar_month(driver, direction):
            _fail("E7", f"日历翻页按钮点不动（{direction}），当前 {current[0]}年{current[1]}月，目标 {wanted[0]}年{wanted[1]}月")
        new_label = _read_calendar_month(driver)
        try:
            moved = parse_calendar_month_label(new_label)
        except DeliveryWindowApplyArgumentError as exc:
            _fail("E7", f"翻页后月份标题无法解析: {exc}")
        if moved == current:
            _fail("E7", f"点了 {direction} 但月份没变（仍为 '{new_label}'），停止推进以免点错日期")
        trail.note("E7 日历翻页", f"{current[0]}-{current[1]:02d} --{direction}--> {moved[0]}-{moved[1]:02d}")
        current = moved

    _fail("E7", f"翻了 {MAX_MONTH_STEPS} 次月份仍未到目标 {wanted[0]}年{wanted[1]}月")


def _run_one_shipment(
    driver: Any,
    plan: Mapping[str, Any],
    shipment_id: str,
    *,
    now: _dt.datetime,
    trail: _Trail,
) -> dict[str, Any]:
    target_start, target_end = _plan_dates(plan)
    target_date = _dt.date.fromisoformat(str(plan["target_date"]))
    timeout_seconds = float(plan["timeout_sec"])
    origin = _origin(str(plan["page_url"]))
    detail_url = DETAIL_URL_TEMPLATE.format(origin=origin, shipment_id=shipment_id)

    entry: dict[str, Any] = {
        "fba_shipment_id": shipment_id,
        "status": "pending",
        "failure_code": "",
        "failure_detail": "",
        "detail_url": detail_url,
        "target_date": target_date.isoformat(),
        "target_window": dict(plan["target_window"]),
        "steps": trail.entries,
    }

    _open_tracking_detail(driver, detail_url=detail_url, timeout_seconds=timeout_seconds, trail=trail)
    tab = _select_shipment_tab(
        driver, shipment_id, timeout_seconds=timeout_seconds, trail=trail
    )
    entry["tab_index"] = tab["index"]

    grace, current = _read_editable_window(driver, now=now, trail=trail)
    entry["grace"] = grace
    entry["current_window"] = current["window"]
    entry["current_window_read"] = current["read"]

    if window_matches(current["window"], target_start, target_end):
        trail.note("已完成", "页面上的送达时段已经是目标周，不做任何点击")
        entry["status"] = "already_target"
        return entry

    if not _click_selector(driver, EDIT_LINK_SELECTOR):
        _fail("E4", f"找不到或点不动编辑时段入口（{EDIT_LINK_SELECTOR}）")
    opened = _wait_until(
        lambda: _selector_present(driver, MODAL_BODY_SELECTOR),
        timeout_seconds=MODAL_TIMEOUT_SECONDS,
    )
    if not opened:
        _fail(
            "E4",
            f"点击编辑时段后 {MODAL_TIMEOUT_SECONDS} 秒内没等到弹窗（{MODAL_BODY_SELECTOR}）；"
            "很可能是该货件被承运人预约锁定",
        )
    trail.note("E4 弹窗已打开", MODAL_BODY_SELECTOR)

    modal_read = read_current_window_text(_read_page(driver))
    entry["modal_current_window"] = modal_read["raw"]
    entry["modal_current_window_source"] = modal_read["source"]
    if modal_read["scope"] == "modal" and modal_read["status"] == WINDOW_PARSED:
        before_start = _dt.date.fromisoformat(str(current["window"]["start_date"]))
        before_end = _dt.date.fromisoformat(str(current["window"]["end_date"]))
        if not window_matches(modal_read["window"], before_start, before_end):
            _fail(
                "E9",
                f"弹窗里的当前送达时段（{modal_read['raw']}）与点开弹窗之前页面上读到的不一致"
                f"（{current['read']['raw']}），说明打开的很可能不是 {shipment_id} 这一票",
            )
        trail.note("E9 交叉校验通过", f"modal='{modal_read['raw']}' == page='{current['read']['raw']}'")
    else:
        trail.note(
            "E9 交叉校验跳过",
            f"没能从弹窗内读到当前送达时段（scope={modal_read['scope']} status={modal_read['status']}）；"
            "目标周、图例、回读三项仍各自校验",
        )

    if not plan["apply"]:
        cancelled = _click_selector(driver, CANCEL_BUTTON_SELECTOR)
        entry["dry_run_cancel_clicked"] = cancelled
        trail.note("dry-run 收尾", f"取消按钮点击={cancelled}（未点日历、未点确认）")
        entry["status"] = "dry_run_ready"
        return entry

    _goto_calendar_month(driver, target_date, trail=trail)
    if not _click_calendar_day(driver, target_date):
        day_count = _count_calendar_days(driver)
        _fail(
            "E7",
            f"日历里点不到 {target_date.isoformat()}（aria-label 前缀 {target_date.year}年{target_date.month}月{target_date.day}日）；"
            f"当前月份 '{_read_calendar_month(driver)}'，可点日期格子数={day_count}",
        )
    trail.note("E7 已点目标日", target_date.isoformat())

    legend: dict[str, Any] = read_legend_selected_text(_read_page(driver))
    legend_ok = _wait_until(
        lambda: window_matches(read_legend_selected_text(_read_page(driver)).get("window"), target_start, target_end),
        timeout_seconds=LEGEND_TIMEOUT_SECONDS,
    )
    legend = read_legend_selected_text(_read_page(driver))
    entry["legend_selected"] = legend
    if not legend_ok:
        _fail(
            "E5",
            f"图例「已选择」显示的还不是目标周（读到 '{legend['raw']}'，"
            f"目标 {plan['target_window']['display']}）；绝不点确认",
        )
    trail.note("E5 图例自检通过", f"legend='{legend['raw']}'")

    button = read_update_button_state(_read_page(driver))
    entry["update_button"] = button
    if not button["present"]:
        _fail("E6", f"读不到确认按钮（{UPDATE_BUTTON_SELECTOR}）")
    if button["disabled"]:
        _fail(
            "E6",
            f"确认按钮（'{button['label']}'）仍是 disabled，日历选择大概没被页面接受；不点它",
        )
    if not _click_selector(driver, UPDATE_BUTTON_SELECTOR):
        _fail("E6", f"确认按钮（{UPDATE_BUTTON_SELECTOR}）点击失败")
    trail.note("E6 已点确认", button["label"])

    applied_ok = _wait_until(
        lambda: window_matches(
            (read_current_window_text(_read_page(driver)).get("window")), target_start, target_end
        ),
        timeout_seconds=MODAL_CLOSE_TIMEOUT_SECONDS,
    )
    applied_read = read_current_window_text(_read_page(driver))
    entry["applied_window"] = applied_read["window"]
    entry["applied_window_read"] = applied_read
    if not applied_ok:
        _fail(
            "E8",
            f"确认后回读到的送达时段不是目标周（读到 '{applied_read['raw']}'，"
            f"目标 {plan['target_window']['display']}）；页面可能没接受这次修改",
        )
    trail.note("E8 回读通过", f"applied='{applied_read['raw']}'")
    entry["status"] = "applied"
    return entry


def _workflow_id_from_url(url: object) -> str:
    values = parse_qs(urlsplit(str(url or "")).query).get("wf") or []
    return _clean(values[0]) if values else ""


def _run_discovery(
    driver: Any,
    plan: Mapping[str, Any],
    *,
    output_dir: str | Path,
    now: _dt.datetime | None = None,
) -> dict[str, Any]:
    """Read every child shipment in one STA workflow; never open a modal."""
    moment = now or _dt.datetime.now(_dt.timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=_dt.timezone.utc)

    seed = str(plan["seed_shipment_id"])
    trail = _Trail()
    origin = _origin(str(plan["page_url"]))
    detail_url = DETAIL_URL_TEMPLATE.format(origin=origin, shipment_id=seed)

    driver.get(str(plan["page_url"]))
    _wait_until(
        lambda: len(read_hub_cells(driver)) > 0,
        timeout_seconds=float(plan["timeout_sec"]),
    )
    hub = build_hub_rows(read_hub_cells(driver))
    row = hub["by_id"].get(seed)
    if row is None:
        _fail(
            "E1",
            f"用于定位工作流程的 {seed} 不在当前列表页；"
            f"页面上的行: {sorted(hub['by_id'])[:10]}",
        )
    # The seed locates the STA workflow.  It need not itself be eligible: a
    # workflow can contain child shipments at different lifecycle stages.
    hub_status = _read_hub_status(row, seed, trail)

    _open_tracking_detail(
        driver,
        detail_url=detail_url,
        timeout_seconds=float(plan["timeout_sec"]),
        trail=trail,
    )
    initial_tabs = read_tracking_tabs(_read_page(driver))
    if not initial_tabs:
        _fail("E2", f"工作流程中没有读到任何货件分页（{TRACKING_TAB_SELECTOR}）")

    tab_ids: list[str] = []
    malformed: list[dict[str, Any]] = []
    for tab in initial_tabs:
        ids = list(tab.get("fba_ids") or [])
        if len(ids) != 1:
            malformed.append(
                {"index": tab.get("index"), "fba_ids": ids, "text": tab.get("text")}
            )
        else:
            tab_ids.append(ids[0])
    duplicates = sorted({item for item in tab_ids if tab_ids.count(item) > 1})
    if malformed or duplicates:
        _fail(
            "E2",
            f"无法把工作流程分页唯一映射为 FBA 货件编号；"
            f"malformed={malformed} duplicates={duplicates}",
        )

    shipments: list[dict[str, Any]] = []
    for selection_number, shipment_id in enumerate(tab_ids, start=1):
        item_trail = _Trail()
        operator_identity = {
            "selection_number": selection_number,
            "operator_label": f"货件编号 {selection_number}",
            "fba_shipment_id": shipment_id,
            "tab_index": selection_number - 1,
        }
        child_evidence: dict[str, Any] = {
            "order_status": "",
            "unit_status": parse_unit_status(""),
            "hub_window_text": "",
            "hub_order_status_cell_text": "",
            "hub_unit_status_cell_text": "",
        }
        business_eligible: bool | None = None
        business_reason = ""
        try:
            child_row = hub["by_id"].get(shipment_id)
            if child_row is None:
                business_reason = (
                    f"{shipment_id} 出现在工作流程分页中，但不在当前货件列表页，"
                    "无法确认 orderStatus；实际写入按状态未知处理"
                )
                item_trail.note("E1 列表状态未知", business_reason)
            else:
                child_evidence = {
                    "order_status": _clean(child_row.get("order_status_text")),
                    "unit_status": parse_unit_status(child_row.get("unit_status_text")),
                    "hub_window_text": child_row.get("delivery_window_text"),
                    "hub_order_status_cell_text": child_row.get("order_status_cell_text"),
                    "hub_unit_status_cell_text": child_row.get("unit_status_cell_text"),
                }
                try:
                    child_status = _read_hub_status(child_row, shipment_id, item_trail)
                    child_evidence["order_status"] = child_status["order_status"]
                    child_evidence["unit_status"] = child_status["unit_status"]
                    business_eligible = (
                        child_status["order_status"] in EDITABLE_ORDER_STATUSES
                    )
                    if not business_eligible:
                        business_reason = (
                            f"orderStatus='{child_status['order_status']}' 不属于允许修改送达时段的状态"
                            f"（当前仅允许: {', '.join(sorted(EDITABLE_ORDER_STATUSES))}）"
                        )
                        item_trail.note("E1 业务状态排除", business_reason)
                except _HardFailure as exc:
                    business_reason = f"{exc.code}: {exc.message}"
                    item_trail.note("E1 列表状态未知", business_reason)

            # Discovery is read-only, so inspect every workflow tab even when
            # the list status would block a later apply.  Page capability and
            # business eligibility are separate facts and must not be conflated.
            selected = _select_shipment_tab(
                driver,
                shipment_id,
                timeout_seconds=float(plan["timeout_sec"]),
                trail=item_trail,
            )
            inspection = inspect_selected_shipment(_read_page(driver), now=moment)
            page_editable = inspection.get("editable")
            selectable = business_eligible is True and page_editable is True
            if business_eligible is False:
                status = "ineligible"
                editable: bool | None = False
                reason = business_reason
            elif business_eligible is None:
                status = "unknown"
                editable = None
                reason = business_reason
            else:
                status = str(inspection.get("status") or "unknown")
                editable = page_editable if isinstance(page_editable, bool) else None
                reason = str(inspection.get("reason") or "")
            shipments.append(
                {
                    **operator_identity,
                    "tab_index": selected["index"],
                    **child_evidence,
                    **inspection,
                    "status": status,
                    "editable": editable,
                    "reason": reason,
                    "failure_code": "E1" if business_eligible is None else "",
                    "page_editability_status": inspection.get("status"),
                    "page_editable": page_editable,
                    "page_editability_reason": inspection.get("reason"),
                    "business_eligible": business_eligible,
                    "selectable": selectable,
                    "steps": item_trail.entries,
                }
            )
        except _HardFailure as exc:
            shipments.append(
                {
                    **operator_identity,
                    **child_evidence,
                    "status": "unknown",
                    "editable": None,
                    "reason": f"{exc.code}: {exc.message}",
                    "failure_code": exc.code,
                    "page_editability_status": "unknown",
                    "page_editable": None,
                    "page_editability_reason": f"{exc.code}: {exc.message}",
                    "business_eligible": business_eligible,
                    "selectable": False,
                    "steps": item_trail.entries,
                }
            )

    editable_ids = [
        item["fba_shipment_id"] for item in shipments if item.get("selectable") is True
    ]
    page_editable_ids = [
        item["fba_shipment_id"] for item in shipments if item.get("page_editable") is True
    ]
    unknown_ids = [
        item["fba_shipment_id"] for item in shipments if item.get("editable") is None
    ]
    ineligible_ids = [
        item["fba_shipment_id"]
        for item in shipments
        if item.get("business_eligible") is False
    ]
    operator_options = [
        {
            "selection_number": item["selection_number"],
            "label": item["operator_label"],
            "fba_shipment_id": item["fba_shipment_id"],
            "order_status": item.get("order_status"),
            "current_window": item.get("current_window"),
            "page_editable": item.get("page_editable"),
            "business_eligible": item.get("business_eligible"),
            "selectable": item.get("selectable"),
            "status": item.get("status"),
            "reason": item.get("reason"),
        }
        for item in shipments
    ]
    workflow_id = _workflow_id_from_url(getattr(driver, "current_url", ""))
    payload = {
        "action": ACTION_DISCOVER,
        "store_id": plan["store_id"],
        "page_url": plan["page_url"],
        "seed_shipment_id": seed,
        "workflow_id": workflow_id,
        "shipment_count": len(shipments),
        "operator_options": operator_options,
        "editable_shipment_ids": editable_ids,
        "page_editable_shipment_ids": page_editable_ids,
        "ineligible_shipment_ids": ineligible_ids,
        "unknown_shipment_ids": unknown_ids,
        "shipments": shipments,
        "hub_seed": {
            "order_status": hub_status["order_status"],
            "unit_status": hub_status["unit_status"],
        },
        "steps": trail.entries,
        "recorded_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
    }
    artifact_path = _write_artifact(
        output_dir,
        payload,
        prefix="amazon-delivery-window-discover",
    )
    finished = not unknown_ids
    return {
        "success": True,
        "finished": finished,
        "exception": "",
        "notice": (
            f"只读发现完成：工作流程 {workflow_id or '(未解析)'} 共 {len(shipments)} 个货件，"
            f"页面可编辑 {len(page_editable_ids)} 个，符合业务状态且可选 {len(editable_ids)} 个，"
            f"业务状态排除 {len(ineligible_ids)} 个，"
            f"状态未知 {len(unknown_ids)} 个；"
            "未打开编辑弹窗、未点击日历、未点击确认按钮"
        ),
        "file_path": _artifact_entries(artifact_path, key="delivery_window_discover"),
        "data": payload,
    }


def _write_artifact(
    output_dir: str | Path,
    payload: Mapping[str, Any],
    *,
    prefix: str = "amazon-delivery-window-apply",
) -> str:
    target_dir = Path(output_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / f"{prefix}-{int(time.time())}.json"
    serialized = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
    target.write_text(serialized, encoding="utf-8")
    return str(target.resolve())


def _artifact_entries(
    artifact_path: str,
    *,
    key: str = "delivery_window_apply",
) -> list[dict[str, str]]:
    return [{"key": key, "value": artifact_path}]


def _run_shipments(
    driver: Any,
    plan: Mapping[str, Any],
    *,
    output_dir: str | Path,
    now: _dt.datetime | None = None,
) -> dict[str, Any]:
    """Walk the hub check, then every shipment in order.  Never raises for E1-E9."""
    moment = now or _dt.datetime.now(_dt.timezone.utc)
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=_dt.timezone.utc)

    hub_trail = _Trail()
    hub: dict[str, Any] | None = None
    failure: _HardFailure | None = None
    try:
        driver.get(str(plan["page_url"]))
        _wait_until(
            lambda: len(read_hub_cells(driver)) > 0,
            timeout_seconds=float(plan["timeout_sec"]),
        )
        hub = build_hub_rows(read_hub_cells(driver))
        hub_trail.note(
            "列表页读取",
            f"page_url={plan['page_url']} rows={hub['row_count']} duplicates={len(hub['duplicates'])}",
        )
        if hub["row_count"] == 0:
            _fail(
                "E1",
                f"货件列表页没有读到任何行（{SHIPMENT_HUB_CELL_SELECTOR}）；"
                f"当前 URL: {getattr(driver, 'current_url', '')}",
            )
    except _HardFailure as exc:
        # The list page itself failed: nothing downstream can be trusted, and
        # every requested shipment stays untouched.
        hub_trail.note(exc.code, exc.message)
        failure = exc

    shipments: list[dict[str, Any]] = []
    for index, shipment_id in enumerate(plan["shipment_ids"]):
        if failure is not None:
            if index == 0:
                detail = f"列表页阶段失败后未处理：{failure.code} {failure.message}"
            else:
                detail = f"前一票 {plan['shipment_ids'][index - 1]} 失败后停止（{failure.code}）"
            shipments.append(
                {
                    "fba_shipment_id": shipment_id,
                    "status": "not_attempted",
                    "failure_code": "",
                    "failure_detail": detail,
                    "steps": [],
                }
            )
            continue

        trail = _Trail()
        entry: dict[str, Any]
        try:
            hub_trail.note(f"列表行匹配 {shipment_id}", "")
            row = hub["by_id"].get(shipment_id)
            if row is None:
                candidates = sorted(hub["by_id"])
                _fail(
                    "E1",
                    f"{shipment_id} 不在当前列表页的 {hub['row_count']} 行里；"
                    f"页面上的行: {candidates[:10]}{'…' if len(candidates) > 10 else ''}",
                )
            hub_status = _require_hub_status(row, shipment_id, trail)
            entry = _run_one_shipment(driver, plan, shipment_id, now=moment, trail=trail)
            entry["order_status"] = hub_status["order_status"]
            entry["unit_status"] = hub_status["unit_status"]
            entry["hub_window_text"] = row.get("delivery_window_text")
            entry["hub_order_status_cell_text"] = row.get("order_status_cell_text")
            entry["hub_unit_status_cell_text"] = row.get("unit_status_cell_text")
        except _HardFailure as exc:
            entry = {
                "fba_shipment_id": shipment_id,
                "status": "failed",
                "failure_code": exc.code,
                "failure_detail": exc.message,
                "steps": trail.entries,
            }
            failure = exc
        shipments.append(entry)

    statuses = [str(item.get("status")) for item in shipments]
    finished = failure is None and all(
        status in {"dry_run_ready", "already_target", "applied"} for status in statuses
    )
    if failure is not None:
        notice = (
            f"停在 {failure.code}: {failure.message}；"
            f"已处理 {sum(1 for status in statuses if status != 'not_attempted')} 票，"
            f"其中 applied={statuses.count('applied')}，not_attempted={statuses.count('not_attempted')}"
        )
    else:
        notice = (
            f"目标周 {plan['target_window']['display']}；"
            + "；".join(
                f"{item['fba_shipment_id']}: {item.get('status')}"
                f"（当前 {item.get('current_window', {}).get('raw', '') or item.get('hub_window_text', '')}）"
                for item in shipments
            )
            + ("" if plan["apply"] else "；dry-run：未点日历、未点确认按钮")
        )

    artifact_payload = {
        "store_id": plan["store_id"],
        "page_url": plan["page_url"],
        "apply": bool(plan["apply"]),
        "target_date": plan["target_date"],
        "target_window": plan["target_window"],
        "requested_shipment_ids": list(plan["shipment_ids"]),
        "hub": {
            "row_count": (hub or {}).get("row_count", 0),
            "rows": (hub or {}).get("rows", []),
            "duplicates": (hub or {}).get("duplicates", []),
            "steps": hub_trail.entries,
        },
        "shipments": shipments,
        "recorded_at": _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds"),
    }
    artifact_path = _write_artifact(output_dir, artifact_payload)

    return {
        "success": failure is None,
        "finished": finished,
        "exception": "" if failure is None else f"{failure.code}: {failure.message}",
        "notice": notice,
        "file_path": _artifact_entries(artifact_path),
        "data": {
            "apply": bool(plan["apply"]),
            "dry_run": not bool(plan["apply"]),
            "target_date": plan["target_date"],
            "target_window": plan["target_window"],
            "shipments": shipments,
            "hub_rows": hub["rows"],
            "hub_duplicates": hub["duplicates"],
            "steps": hub_trail.entries,
        },
    }


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
        "auth_refresh_required": False,
        "exception": str(exception or "").strip(),
        "notice": str(notice or "").strip(),
        "file_path": [dict(item) for item in list(file_path or [])],
        "data": dict(data or {}),
    }


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    """lxeskill entrypoint — the catalog ``input_schema`` is the argument contract."""
    action = _clean((arguments or {}).get("action") or ACTION_APPLY).lower()
    if action not in {ACTION_APPLY, ACTION_DISCOVER}:
        return _payload(
            success=False,
            finished=False,
            exception=f"action 必须是 {ACTION_DISCOVER} 或 {ACTION_APPLY}，收到: {action or '(空)'}",
        )
    try:
        plan = plan_discover(arguments) if action == ACTION_DISCOVER else plan_apply(arguments)
    except dwl.DeliveryWindowArgumentError as exc:
        return _payload(success=False, finished=False, exception=str(exc))

    if plan["plan_only"]:
        return _payload(
            success=True,
            finished=True,
            notice="plan_only=true：仅校验参数，未接触任何页面。",
            data={"plan": plan, "shipments": [], "hub_rows": []},
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
        output_dir = Path(workflow_output_dir(session_id))
        with browser_session(
            session_id=session_id,
            context={"store_id": plan["store_id"]},
            output_dir=output_dir,
        ) as session:
            driver = getattr(session, "driver", None)
            if driver is None:
                raise RuntimeError("browser_session 没有提供 driver")
            if action == ACTION_DISCOVER:
                result = _run_discovery(driver, plan, output_dir=output_dir)
            else:
                result = _run_shipments(driver, plan, output_dir=output_dir)
    except _HardFailure as exc:
        return _payload(
            success=False,
            finished=False,
            exception=f"{exc.code}: {exc.message}",
            data={"plan": plan},
        )
    except Exception as exc:  # noqa: BLE001 - the payload must carry the real error
        return _payload(
            success=False,
            finished=False,
            exception=f"{type(exc).__name__}: {exc}",
            data={"plan": plan},
        )

    result["data"]["plan"] = plan
    return _payload(
        success=result["success"],
        finished=result["finished"],
        exception=result["exception"],
        notice=result["notice"],
        file_path=result["file_path"],
        data=result["data"],
    )


__all__ = [
    "CALENDAR_SELECTOR",
    "CANCEL_BUTTON_SELECTOR",
    "CURRENT_WINDOW_LABEL",
    "DeliveryWindowApplyArgumentError",
    "EDIT_LINK_SELECTOR",
    "GRACE_SELECTOR",
    "LEGEND_ITEM_SELECTOR",
    "MODAL_BODY_SELECTOR",
    "ORDER_STATUS_COLUMN",
    "SHIPMENT_INFO_DETAILS_SELECTOR",
    "STA_LINK_SELECTOR",
    "STEP_VIEW_LINK_SELECTOR",
    "TRACKING_TAB_SELECTOR",
    "UNIT_STATUS_COLUMN",
    "UPDATE_BUTTON_SELECTOR",
    "build_hub_rows",
    "calendar_week_span",
    "direct_text",
    "format_cn_window",
    "inspect_selected_shipment",
    "parse_calendar_month_label",
    "parse_grace_period",
    "parse_target_date",
    "parse_unit_status",
    "plan_apply",
    "plan_discover",
    "read_current_window_text",
    "read_grace_text",
    "read_hub_cells",
    "read_legend_selected_text",
    "read_sta_link",
    "read_tracking_tabs",
    "read_update_button_state",
    "run",
    "select_tracking_tab",
    "verify_tab_selection",
    "window_matches",
]
