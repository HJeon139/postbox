// Tiny DOM helpers. Text always goes in as text nodes; the only HTML strings inserted come from
// shared/markdown.mjs, which escapes everything an agent wrote.

/** HTML that Postbox made itself (renderMarkdown’s output). h() sets innerHTML only from these. */
class TrustedHtml {
  constructor(s) {
    this.s = s;
  }
}
export const trusted = (s) => new TrustedHtml(String(s));

/**
 * h('button.btn.sm', { onclick, 'aria-label': 'Close' }, 'Close')
 * Props starting with "on" become listeners; class/className, style (object), dataset and hidden are
 * handled; everything else is an attribute. Children may be strings, nodes, arrays, null or false.
 */
export function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class' || k === 'className') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    // Agent data that lands in the props slot by mistake is a plain object: its html becomes text, never markup.
    // lint-allow dom: a TrustedHtml is only ever renderMarkdown() output, which escapes everything an agent wrote.
    else if (k === 'html') v instanceof TrustedHtml ? (el.innerHTML = v.s) : el.append(String(v));
    else if (k === 'value' && 'value' in el) el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'open' || k === 'selected') el[k] = !!v;
    // lint-allow dom: prop names come from Postbox’s own h() calls, never from agent data.
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replaces an element’s children, skipping null, false and nested arrays the way h() does. */
export function fill(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

export const icon = (name, extra = '') => h(`span.i.i-${name}${extra ? '.' + extra : ''}`, { 'aria-hidden': 'true' });

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function timeOf(ms) {
  return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}
export function dayOf(ms) {
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' });
}
export function ago(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hr = Math.round(m / 60);
  return hr < 24 ? `${hr} h ago` : dayOf(ms);
}
export const plural = (n, one, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Keyed list reconciliation: reuses nodes by key so rings keep animating and focus stays put. */
export function syncList(container, items, key, create, update) {
  const existing = new Map([...container.children].filter((c) => c.dataset.key).map((c) => [c.dataset.key, c]));
  let prev = null;
  for (const item of items) {
    const k = String(key(item));
    let node = existing.get(k);
    if (node) {
      existing.delete(k);
      update?.(node, item);
    } else {
      node = create(item);
      node.dataset.key = k;
    }
    const next = prev ? prev.nextSibling : container.firstChild;
    if (node !== next) container.insertBefore(node, next);
    prev = node;
  }
  for (const n of existing.values()) n.remove();
}
