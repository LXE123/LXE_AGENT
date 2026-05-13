from __future__ import annotations

import json
import time
from typing import Any

from services.agent_cli.browser.amazon_common.login_verify import verify_seller_central_login
from services.agent_cli.browser.amazon_common.seller_central_url import (
    DEFAULT_SELLER_CENTRAL_ORIGIN,
    build_seller_central_url,
)
from services.browser.browser.shadow_dom import SHADOW_DOM_HELPERS_JS


MARKETPLACE_SWITCHER_PATH = "/account-switcher/default/merchantMarketplace"
MARKETPLACE_SWITCHER_URL = f"{DEFAULT_SELLER_CENTRAL_ORIGIN}{MARKETPLACE_SWITCHER_PATH}"
_LOGIN_VERIFY_PATHS = {"/ap/signin", "/ap/mfa"}

_SITE_ALIASES: dict[str, tuple[str, ...]] = {
    "US": ("US", "USA", "UNITED STATES", "美国", "美国站"),
    "UK": ("UK", "GB", "UNITED KINGDOM", "BRITAIN", "英国", "英国站"),
    "DE": ("DE", "GERMANY", "德国", "德国站"),
    "FR": ("FR", "FRANCE", "法国", "法国站"),
    "IT": ("IT", "ITALY", "意大利", "意大利站"),
    "ES": ("ES", "SPAIN", "西班牙", "西班牙站"),
    "CA": ("CA", "CANADA", "加拿大", "加拿大站"),
    "JP": ("JP", "JAPAN", "日本", "日本站"),
    "AU": ("AU", "AUS", "AUSTRALIA", "澳大利亚", "澳大利亚站"),
}

_SWITCHER_SHARED_JS = """
function compact(value, limit) {
  return String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
}

function cleanLabel(value, limit) {
  return compact(String(value || '').replace(/\\(当前\\)/g, '').replace(/\\.\\s*Selected$/i, ''), limit);
}

function ensureAid(el) {
  const existing = el.getAttribute('data-aid') || '';
  if (existing) return existing;
  const counter = Number(window.__amazonAgentCliAidCounter || 2000000);
  const nextValue = counter + 1;
  window.__amazonAgentCliAidCounter = nextValue;
  const aid = `aid-cli-${nextValue}`;
  el.setAttribute('data-aid', aid);
  return aid;
}

function clickableDescendant(el) {
  if (!el || !(el instanceof Element)) return null;
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'button' || tag === 'a') return el;
  return deepQuerySelector('button, a, [role="button"], [role="link"]', el.shadowRoot || el) || el;
}

function readCurrentAccountLabelEl() {
  return deepQuerySelector('.full-page-account-switcher-account-label-expanded[data-test="current-account"]');
}

function readCurrentAccountLabel() {
  const el = readCurrentAccountLabelEl();
  return cleanLabel(el ? el.innerText || el.textContent || '' : '', 120);
}

function readRegionButtons() {
  const currentAccountLabel = readCurrentAccountLabel();
  const results = [];
  for (const raw of deepQuerySelectorAll('.full-page-account-switcher-account > button.full-page-account-switcher-account-details, .full-page-account-switcher-account button.full-page-account-switcher-account-details')) {
    if (!(raw instanceof Element)) continue;
    const labelEl = deepQuerySelector('.full-page-account-switcher-account-label', raw.shadowRoot || raw) || raw;
    const labelClassName = String(labelEl.className || '');
    const rawLabel = compact(labelEl.innerText || labelEl.textContent || raw.innerText || raw.textContent || '', 120);
    const cleanRegionLabel = cleanLabel(rawLabel, 120);
    const isExpandedCurrentAccount =
      labelClassName.includes('full-page-account-switcher-account-label-expanded') &&
      String(labelEl.getAttribute('data-test') || '') === 'current-account';
    if (isExpandedCurrentAccount) continue;
    if (currentAccountLabel && cleanRegionLabel && cleanRegionLabel === currentAccountLabel) continue;
    results.push(raw);
  }
  return results;
}

function readRegionOption(raw) {
  const target = clickableDescendant(raw) || raw;
  const labelEl = deepQuerySelector('.full-page-account-switcher-account-label', raw.shadowRoot || raw) || raw;
  const cleanRegionLabel = cleanLabel(labelEl.innerText || labelEl.textContent || target.innerText || target.textContent, 120);
  return {
    target,
    label: cleanRegionLabel,
    aid: ensureAid(target),
  };
}

function readConfirmHost() {
  let confirmHost = deepQuerySelector('[data-test="confirm-selection"], [data-testid="confirm-selection"], kat-button[data-test="confirm-selection"], kat-button[data-testid="confirm-selection"]');
  if (confirmHost) return confirmHost;
  for (const candidate of deepQuerySelectorAll('button, [role="button"], kat-button')) {
    const text = compact(candidate.innerText || candidate.textContent || '', 80);
    const lower = text.toLowerCase();
    if (text.includes('选择账户') || text.includes('Select account') || lower.includes('select account')) {
      return candidate;
    }
  }
  return null;
}

"""

_SWITCHER_STATE_JS = SHADOW_DOM_HELPERS_JS + _SWITCHER_SHARED_JS + """
const regionButtons = readRegionButtons();

const options = [];
for (const raw of regionButtons) {
  const option = readRegionOption(raw);
  if (!option.label) continue;
  options.push({
    aid: option.aid,
    label: option.label,
  });
}

const confirmTarget = clickableDescendant(readConfirmHost());
const confirmAid = confirmTarget ? ensureAid(confirmTarget) : '';

return {
  confirm_aid: confirmAid,
  options,
};
"""

_HOME_REGION_LABEL_JS = SHADOW_DOM_HELPERS_JS + """
function compact(value, limit) {
  return String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
}

function cleanLabel(value, limit) {
  return compact(String(value || '').replace(/\\(当前\\)/g, '').replace(/\\.\\s*Selected$/i, ''), limit);
}

for (const selector of [
  '.dropdown-account-switcher-header-label-regional.dropdown-account-switcher-header-label-regional-child',
  '.dropdown-account-switcher-header-label-regional-child',
  '.dropdown-account-switcher-header-label-regional',
]) {
  const el = deepQuerySelector(selector);
  if (!el) continue;
  const label = cleanLabel(el.innerText || el.textContent || '', 120);
  if (label) return label;
}
return '';
"""


def _normalize_alias(value: str) -> str:
    return "".join(str(value or "").strip().upper().split())


def normalize_site_code(site: str) -> str:
    normalized = _normalize_alias(site)
    if not normalized:
        raise ValueError("site 不能为空")
    for code, aliases in _SITE_ALIASES.items():
        accepted = {code, *(_normalize_alias(alias) for alias in aliases)}
        if normalized in accepted:
            return code
    supported = ", ".join(sorted(_SITE_ALIASES))
    raise ValueError(f"不支持的 site: {site}，仅支持 {supported}")


def site_aliases(site_code: str) -> tuple[str, ...]:
    code = normalize_site_code(site_code)
    return _SITE_ALIASES[code]


def _label_matches_site(label: str, site_code: str) -> bool:
    normalized_label = _normalize_alias(label)
    if not normalized_label:
        return False
    candidates = {normalize_site_code(site_code)}
    candidates.update(_normalize_alias(alias) for alias in site_aliases(site_code))
    return any(candidate and candidate in normalized_label for candidate in candidates)


def _read_switcher_state(session: Any) -> dict[str, Any]:
    state = dict(session.driver.execute_script(_SWITCHER_STATE_JS) or {})
    state["options"] = [dict(item or {}) for item in list(state.get("options") or [])]
    return state


def _state_option_labels(state: dict[str, Any]) -> list[str]:
    return [str(item.get("label") or "").strip() for item in list(state.get("options") or []) if str(item.get("label") or "").strip()]


def _read_home_region_label(session: Any) -> str:
    return str(session.driver.execute_script(_HOME_REGION_LABEL_JS) or "").strip()


def _read_current_path(driver: Any) -> str:
    return str(
        driver.execute_script(
            """
return String((window.location && window.location.pathname) || '').trim();
"""
        )
        or ""
    ).strip()


def _verify_login_if_needed(session: Any, *, timeout_seconds: int) -> dict[str, Any]:
    path = _read_current_path(session.driver)
    if path not in _LOGIN_VERIFY_PATHS:
        return {}

    verify_payload = dict(
        verify_seller_central_login(
            session.driver,
            timeout_seconds=timeout_seconds,
        )
        or {}
    )
    if bool(verify_payload.get("manual_required")):
        click_count = int(verify_payload.get("click_count") or 0)
        notice = str(verify_payload.get("notice") or "").strip() or "登录验证未完成，请用户手动操作"
        if click_count:
            notice = f"{notice}，共点击 {click_count} 次"
        raise RuntimeError(notice)
    return verify_payload


def _execute_switcher_script(driver: Any, script_body: str, *args):
    return driver.execute_script(SHADOW_DOM_HELPERS_JS + _SWITCHER_SHARED_JS + script_body, *args)


def _wait_for_switcher_options(session: Any, timeout_seconds: float) -> dict[str, Any]:
    deadline = time.time() + max(0.0, float(timeout_seconds or 0))
    last_state = _read_switcher_state(session)
    if list(last_state.get("options") or []):
        return last_state
    while time.time() < deadline:
        time.sleep(0.5)
        last_state = _read_switcher_state(session)
        if list(last_state.get("options") or []):
            return last_state
    return last_state


def _click_switcher_region(driver: Any, target_label: str) -> bool:
    return bool(
        _execute_switcher_script(
            driver,
            """
const targetLabel = String(arguments[0] || '').replace(/\\s+/g, '').toUpperCase();
if (!targetLabel) return false;

function cleanLabel(value) {
  return String(value || '').replace(/\\s+/g, '').replace(/\\(当前\\)/g, '').replace(/\\.\\s*Selected$/i, '').toUpperCase();
}
function clickElement(el) {
  if (!el) return false;
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (error) {}
  try { el.click(); return true; } catch (error) {}
  try {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  } catch (error) {}
  return false;
}
function clickableDescendant(el) {
  if (!el || !(el instanceof Element)) return null;
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'button' || tag === 'a') return el;
  return deepQuerySelector('button, a, [role="button"], [role="link"]', el.shadowRoot || el) || el;
}

for (const raw of readRegionButtons()) {
  const option = readRegionOption(raw);
  if (!option.label || cleanLabel(option.label) !== targetLabel) continue;
  return clickElement(option.target);
}
return false;
""",
            str(target_label or "").strip(),
        )
    )


def _click_switcher_confirm(driver: Any) -> bool:
    return bool(
        _execute_switcher_script(
            driver,
            """
function compact(value, limit) {
  return String(value || '').replace(/\\s+/g, ' ').trim().slice(0, limit);
}
function clickElement(el) {
  if (!el) return false;
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (error) {}
  try { el.click(); return true; } catch (error) {}
  try {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  } catch (error) {}
  return false;
}
function clickableDescendant(el) {
  if (!el || !(el instanceof Element)) return null;
  const tag = String(el.tagName || '').toLowerCase();
  if (tag === 'button' || tag === 'a') return el;
  return deepQuerySelector('button, a, [role="button"], [role="link"]', el.shadowRoot || el) || el;
}

let confirmHost = deepQuerySelector('[data-test="confirm-selection"], [data-testid="confirm-selection"], kat-button[data-test="confirm-selection"], kat-button[data-testid="confirm-selection"]');
if (!confirmHost) {
  for (const candidate of deepQuerySelectorAll('button, [role="button"], kat-button')) {
    const text = compact(candidate.innerText || candidate.textContent || '', 80);
    const lower = text.toLowerCase();
    if (text.includes('选择账户') || text.includes('Select account') || lower.includes('select account')) {
      confirmHost = candidate;
      break;
    }
  }
}
const target = clickableDescendant(confirmHost) || confirmHost;
return clickElement(target);
""",
        )
    )


def _wait_for_home_region_match(session: Any, site: str, timeout_seconds: float) -> str:
    deadline = time.time() + max(0.0, float(timeout_seconds or 0))
    last_label = ""
    while time.time() < deadline:
        last_label = _read_home_region_label(session)
        if last_label and _label_matches_site(last_label, site):
            return last_label
        time.sleep(1.0)
    return last_label


def switch_region(session: Any, site: str, *, timeout_seconds: int = 60) -> dict[str, Any]:
    target_site = normalize_site_code(site)
    screenshots: list[str] = []
    switcher_url = build_seller_central_url(session, MARKETPLACE_SWITCHER_PATH)
    option_wait_seconds = 10.0
    home_wait_seconds = 15.0

    open_result = session.open_url(switcher_url)
    screenshots.append(str(open_result.get("screenshot_path") or "").strip())
    time.sleep(2.0)

    state = _wait_for_switcher_options(session, option_wait_seconds)
    available = _state_option_labels(state)
    target_option = next(
        (
            dict(item or {})
            for item in list(state.get("options") or [])
            if _label_matches_site(str(item.get("label") or "").strip(), target_site)
        ),
        {},
    )
    target_aid = str(target_option.get("aid") or "").strip()
    if not target_aid:
        raise RuntimeError(
            "站点切换页未找到目标站点。"
            f" target={target_site} available={json.dumps(available, ensure_ascii=False)}"
        )

    target_label = str(target_option.get("label") or "").strip()
    if not _click_switcher_region(session.driver, target_label):
        raise RuntimeError(
            "站点切换页未找到目标站点。"
            f" target={target_site} available={json.dumps(available, ensure_ascii=False)}"
        )

    if not str(state.get("confirm_aid") or "").strip():
        raise RuntimeError(
            "站点切换页缺少确认按钮。"
            f" target={target_site} available={json.dumps(available, ensure_ascii=False)}"
        )

    if not _click_switcher_confirm(session.driver):
        raise RuntimeError(
            "站点切换页缺少确认按钮。"
            f" target={target_site} available={json.dumps(available, ensure_ascii=False)}"
        )

    _verify_login_if_needed(session, timeout_seconds=timeout_seconds)
    last_label = _wait_for_home_region_match(session, target_site, home_wait_seconds)
    if _label_matches_site(last_label, target_site):
        return {
            "site": target_site,
            "switched": True,
            "current_label": last_label,
            "available_options": available,
            "screenshots": [path for path in screenshots if path],
        }
    raise RuntimeError(
        "站点切换后校验失败。"
        f" target={target_site}"
        f" current={last_label or 'unknown'}"
    )


__all__ = [
    "MARKETPLACE_SWITCHER_PATH",
    "MARKETPLACE_SWITCHER_URL",
    "normalize_site_code",
    "site_aliases",
    "switch_region",
]
