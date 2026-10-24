"""Bounded, read-only structural probe; never supplies actionable refs."""

DOM_PROBE_JS = r"""
function probeStructure(targets, selectorCandidates) {
  const nodeLimit = 160;
  const targetLimit = 64;
  const candidateLimit = 40;
  const ancestorLimit = 4;
  const nodes = [];
  const indexes = new Map();
  let truncated = false;
  function ownValue(object, key) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  }
  function eventHints(el) {
    const hints = [];
    // This observes exposed handlers only, not arbitrary addEventListener calls.
    for (const key of ['onclick', 'onmousedown', 'onpointerdown', 'onkeydown']) {
      if (typeof el[key] === 'function') hints.push('dom_property:' + key);
    }
    for (const key of Reflect.ownKeys(el)) {
      const name = typeof key === 'symbol' ? key.description || '' : key;
      if (name === '__vue__') hints.push('framework_marker:vue2');
      if (name !== '_vei' && !name.startsWith('__reactProps$')) continue;
      const registry = ownValue(el, key);
      if (!registry || typeof registry !== 'object') continue;
      for (const event of Object.keys(registry).slice(0, 40)) {
        if (!/^on(?:click|mouse|pointer|key|touch)/i.test(event)) continue;
        const value = ownValue(registry, event);
        if (typeof value === 'function') {
          hints.push((name === '_vei' ? 'vue_invoker:' : 'react_prop:') + event);
        }
      }
    }
    return hints.slice(0, 20);
  }
  function parentOf(el) {
    const root = el.getRootNode ? el.getRootNode() : null;
    return el.parentElement || (root && root.host) || null;
  }
  function record(el) {
    if (indexes.has(el)) return indexes.get(el);
    if (nodes.length >= nodeLimit) { truncated = true; return null; }
    const index = nodes.length;
    indexes.set(el, index);
    const item = {diagnostic_node: index};
    nodes.push(item);
    try {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const reasons = [];
      if (style.display === 'none') reasons.push('display:none');
      if (style.visibility === 'hidden' || style.visibility === 'collapse') reasons.push('visibility:' + style.visibility);
      if (Number(style.opacity) === 0) reasons.push('opacity:0');
      if (rect.width <= 0 || rect.height <= 0) reasons.push('zero_rect');
      const tag = (el.tagName || '').toLowerCase();
      // Never read form values, handler bodies, HTML, URL parameters or component state.
      const text = ['input', 'textarea', 'select', 'script', 'style'].includes(tag)
        ? '' : compactValue(el.innerText || '', 96);
      Object.assign(item, {
        tag, text,
        classes: compactValue(el.getAttribute('class') || '', 120),
        role: compactValue(el.getAttribute('role') || '', 40),
        tabindex: el.getAttribute('tabindex'),
        style: {display: style.display, visibility: style.visibility, opacity: style.opacity,
          cursor: style.cursor, pointer_events: style.pointerEvents},
        rect: [rect.left, rect.top, rect.width, rect.height].map(value => Math.round(value)),
        visibility_reasons: reasons,
        onclick_attribute: el.hasAttribute('onclick'),
        event_hints: eventHints(el),
      });
    } catch (error) {
      const message = String(error);
      item.error = message.slice(0, 400) + (message.length > 400 ? ' ... [truncated]' : '');
    }
    return index;
  }
  function trace(el) {
    const diagnosticNode = record(el);
    const ancestors = [];
    let parent = parentOf(el);
    for (let depth = 0; parent && depth < ancestorLimit; depth++) {
      const index = record(parent);
      if (index === null) break;
      ancestors.push(index);
      parent = parentOf(parent);
    }
    return {diagnostic_node: diagnosticNode, ancestors, ancestors_truncated: Boolean(parent)};
  }
  return {
    event_observation: 'Exposed DOM properties and Vue/React handler registries only; absence does not exclude delegated/addEventListener handlers. No handler is invoked.',
    targets: targets.slice(0, targetLimit).map(trace),
    targets_truncated: targets.length > targetLimit,
    selector_candidates: selectorCandidates.slice(0, candidateLimit).map(trace),
    selector_candidates_truncated: selectorCandidates.length > candidateLimit,
    nodes,
    nodes_truncated: truncated,
    ancestor_limit: ancestorLimit,
  };
}
"""
