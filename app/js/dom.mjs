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

/** The longest a press holds off a repaint (#898), so a press that rests on a panel doesn’t freeze what it shows. */
const HOLD_MS = 3000;
const TEXT_FIELD = 'input, textarea, [contenteditable]';

/**
 * Wraps a panel’s paint so a press in root holds it until the press ends (#898). A repaint replaces root’s buttons, and
 * a press that began on one and ends on its replacement isn’t a click to the browser, so it was lost. While a pointer
 * is down in root, or Space (which clicks on its keyup) is down on a control there, a paint waits; the press’s end
 * paints once, after its click, or HOLD_MS after the first press began, whichever comes first. One that ends after
 * root has left the page paints nothing. Returns the paint to call.
 * @param {HTMLElement} root  @param {() => void} paint
 * @returns {() => void}
 */
export function heldPaint(root, paint) {
  /** @type {AbortController | null} */
  let hold = null;
  let pending = false;
  let bound = 0;
  const flush = () => {
    hold?.abort();
    hold = null;
    clearTimeout(bound);
    const due = pending && root.isConnected;
    pending = false;
    if (due) paint();
  };
  const start = () => {
    if (hold) return;
    hold = new AbortController();
    const opts = { capture: true, signal: hold.signal };
    // After the click the press ends in, which the browser dispatches after pointerup and Space’s keyup.
    const end = () => setTimeout(flush);
    // A mouse press may come as mouse events alone, with no pointer events, as in Firefox with touch emulated.
    for (const type of ['pointerup', 'pointercancel', 'mouseup']) window.addEventListener(type, end, opts);
    window.addEventListener('keyup', (e) => e.key === ' ' && end(), opts);
    bound = window.setTimeout(flush, HOLD_MS);
  };
  for (const type of ['pointerdown', 'mousedown']) root.addEventListener(type, start);
  root.addEventListener('keydown', (e) => {
    if (e.key === ' ' && !e.repeat && !(e.target instanceof Element && e.target.closest(TEXT_FIELD))) start();
  });
  return () => {
    if (hold) pending = true;
    else paint();
  };
}

export const icon = (name, extra = '') => h(`span.i.i-${name}${extra ? '.' + extra : ''}`, { 'aria-hidden': 'true' });

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// One formatter each, made once: a toLocale*String call builds its formatter every time, which cost about 1.2 s of a
// switch into a 10,000-item room (#866). Each gives the same text as the toLocale*String call it replaces. They keep
// the time zone the page loaded with, until it reloads.
const TIME = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'long', day: 'numeric', month: 'long' });

/** A time as 14:05. @param {number} ms */
export function timeOf(ms) {
  return TIME.format(ms);
}
/** A day as Friday, November 6. @param {number} ms */
export function dayOf(ms) {
  return DAY.format(ms);
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

/**
 * Keyed list reconciliation: reuses nodes by key so rings keep animating and focus stays put. Nodes that leave go
 * first, so the ones that stay aren’t moved past them; and moving a node drops focus inside it, so it’s given back
 * (#597 review: a row leaving above the focused one).
 */
export function syncList(container, items, key, create, update) {
  const existing = new Map([...container.children].filter((c) => c.dataset.key).map((c) => [c.dataset.key, c]));
  const keep = new Set(items.map((item) => String(key(item))));
  for (const [k, n] of existing)
    if (!keep.has(k)) {
      n.remove();
      existing.delete(k);
    }
  const had = container.contains(document.activeElement) ? document.activeElement : null;
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
  if (had instanceof HTMLElement && had.isConnected && document.activeElement !== had) had.focus({ preventScroll: true });
}
