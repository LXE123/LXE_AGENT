"""Shared Shadow DOM traversal helpers for injected browser-side JavaScript."""

SHADOW_DOM_HELPERS_JS = r"""
function deepQuerySelectorAll(selector, root) {
  const base = root || document;
  const results = [];
  const seen = new Set();

  function pushAll(node, cssSelector) {
    for (const match of node.querySelectorAll(cssSelector)) {
      if (seen.has(match)) continue;
      seen.add(match);
      results.push(match);
    }
  }

  function walk(node) {
    pushAll(node, selector);
    for (const child of node.querySelectorAll('*')) {
      if (child.shadowRoot) {
        walk(child.shadowRoot);
      }
    }
  }

  walk(base);
  return results;
}

function deepQuerySelector(selector, root) {
  const base = root || document;
  const found = base.querySelector(selector);
  if (found) return found;
  for (const el of base.querySelectorAll('*')) {
    if (el.shadowRoot) {
      const inner = deepQuerySelector(selector, el.shadowRoot);
      if (inner) return inner;
    }
  }
  return null;
}

function deepClosest(el, selector) {
  let current = el;
  while (current) {
    const found = current.closest(selector);
    if (found) return found;
    const root = current.getRootNode();
    current = (root instanceof ShadowRoot) ? root.host : null;
  }
  return null;
}
"""


__all__ = ["SHADOW_DOM_HELPERS_JS"]
