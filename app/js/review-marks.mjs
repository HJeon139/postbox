// Marking a part of an app in its review (#856): a click marks a point and a drag a box, anywhere on the app, whether
// or not it names parts, and the arrow keys move a box for a person who can’t drag. Postbox draws on a layer of its
// own over the app’s frame, beside it in the frame’s box, never inside it: the app’s code isn’t trusted to draw what
// the person marked, and its sandbox is unchanged. A region is kept as fractions of the frame, which a review sizes to
// the app’s content (apps.mjs, sizeFrame), so of the app itself. Each region on the version shown is drawn with its
// number; one on another version is listed only, with its version (designs/agent-apps.md, the review block).

import { REGION_ANCHOR, regionAnchor, regionText } from '/shared/review-regions.mjs';
import { shownVersion } from './apps.mjs';
import { client } from './client.mjs';
import { h } from './dom.mjs';
import { startComment } from './review-draft.mjs';

/** The box the keyboard starts from, centered, and how far one arrow key moves or resizes it, as fractions of the app. */
const START = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
const STEP = 0.02;
/** The smallest box the keyboard resizes to: a point is a click. */
const SMALLEST = 0.02;
/** A drag shorter than this, in pixels each way, is a click, so a point. */
const SLOP = 4;
/** What each arrow key does to a box: moves it, or with Shift, moves its right or bottom edge. */
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * Each review’s layer over its app’s frame, by its item, with the latest render’s view of the review (env): kept
 * across renders, as the frame is (review-app.mjs, rerenderAround), so a repaint never takes focus from it.
 * @type {Map<string, { el: HTMLElement, watch: MutationObserver | null, env: any }>}
 */
const layers = new Map();

const round = (/** @type {number} */ f) => Math.round(f * 10000) / 10000;
const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.min(hi, Math.max(lo, v));

/** The version of the app the review shows, as apps.mjs mounts it, or null when the app is gone. @param {any} b @param {boolean} done */
export function versionOf(b, done) {
  const app = client.state.apps[b.appId];
  return app ? shownVersion(app, !done) : null;
}

/**
 * Gives the draft’s regions the numbers the answer will give them: one an agent’s comment numbered first, while the
 * draft was open, moves to the next number, so the page draws both, each where it is (#856). @param {any} b @param {any} d
 */
export function renumberDraft(b, d) {
  const held = [...(b.threads ?? [])];
  for (const c of d.comments) {
    if (c.region) c.anchor = regionAnchor(c, held);
    held.push(c);
  }
  if (d.composingRegion && typeof d.composing === 'string') d.composing = regionAnchor({ anchor: d.composing, region: d.composingRegion }, held);
}

/** The region of each anchor that has one: the threads’, the drafts’ and the open comment box’s. @param {any} b @param {any} d */
export function regionsOf(b, d) {
  /** @type {Map<string, any>} */
  const out = new Map();
  for (const x of [...(b.threads ?? []), ...d.comments]) if (x.region && typeof x.anchor === 'string') out.set(x.anchor, x.region);
  if (d.composingRegion && typeof d.composing === 'string') out.set(d.composing, d.composingRegion);
  return out;
}

/**
 * The anchor of the next region marked on a review: one past the highest it has, the open box’s too when something is
 * typed in it, since it becomes a draft comment when the new one opens, and a blank one is dropped (startComment).
 * @param {any} b @param {any} d
 */
function nextAnchor(b, d) {
  const open = d.composingRegion && d.composingText.trim() ? [{ anchor: d.composing }] : [];
  const taken = [...(b.threads ?? []), ...d.comments, ...open].map((x) => x.anchor).filter((a) => typeof a === 'string' && REGION_ANCHOR.test(a));
  return `region ${Math.max(0, ...taken.map((a) => Number(a.slice('region '.length)))) + 1}`;
}

/**
 * Where a region is, after its anchor in the review’s list of comments: every drawn region is said in words too, and
 * one on another version says it isn’t drawn. @param {any} region @param {number | null} version  the one shown
 */
export function regionNote(region, version) {
  if (!region) return '';
  return ` · ${regionText(region)}${region.version === version ? '' : ', so it isn’t drawn on this version'}`;
}

/** The layer for a review, made once. @param {string} itemId */
function layerOf(itemId) {
  let l = layers.get(itemId);
  if (!l) {
    l = { el: h('div.rv-marks', { 'data-marks': itemId }), watch: null, env: null };
    layers.set(itemId, l);
    wire(l);
  }
  return l;
}

/**
 * Puts the review’s layer over its app’s frame, last in the frame’s box so it’s on top, and again each time the app is
 * mounted afresh there (a reload after a crash, a pause while another app is checked). @param {string} itemId
 * @param {HTMLElement} appEl  the review’s .rv-app, as mountApp fills it
 */
export function attachMarks(itemId, appEl) {
  const l = layerOf(itemId);
  l.watch?.disconnect();
  const place = () => {
    const body = appEl.querySelector(':scope > .app-body');
    if (body?.querySelector(':scope > iframe.app-iframe') && body.lastElementChild !== l.el) body.append(l.el);
  };
  l.watch = new MutationObserver(place);
  l.watch.observe(appEl, { childList: true, subtree: true });
  place();
}

/**
 * Draws a review’s regions over its app, and the box being marked, if the person is marking one.
 * @param {string} itemId @param {{ b: any, d: any, done: boolean, version: number | null, rerender: () => HTMLElement }} env
 */
export function paintMarks(itemId, env) {
  const l = layerOf(itemId);
  l.env = { ...env, itemId };
  const { b, d, done, version } = env;
  const marking = !done && d.marking ? d.marking : null;
  const el = l.el;
  el.classList.toggle('marking', !!marking);
  if (marking) {
    el.tabIndex = 0;
    el.setAttribute('role', 'application');
    el.setAttribute('aria-label', 'Mark a part of the app');
    el.setAttribute('aria-describedby', helpId(itemId));
  } else for (const a of ['tabindex', 'role', 'aria-label', 'aria-describedby']) el.removeAttribute(a);
  const drawn = [...regionsOf(b, d)].filter(([, r]) => r.version === version).map(([a, r]) => regionBox(r, a.slice('region '.length)));
  el.replaceChildren(...drawn, ...(marking ? [regionBox(marking, '', 'marking')] : []));
}

/**
 * A region drawn: an outlined box, or a dot for a point, with its number. The words for it are in the list of
 * comments (regionNote), so a screen reader skips it. @param {any} r @param {string} n @param {string} [cls]
 */
function regionBox(r, n, cls = '') {
  const point = r.w === 0 && r.h === 0;
  const pct = (/** @type {number} */ f) => `${f * 100}%`;
  const size = point ? {} : { width: pct(r.w), height: pct(r.h) };
  return h(
    'div.rv-region',
    {
      class: [point ? 'point' : '', cls].filter(Boolean).join(' '),
      'aria-hidden': 'true',
      'data-region': n || null,
      style: { left: pct(r.x), top: pct(r.y), ...size },
    },
    n ? h('span.rv-region-n', n) : null,
  );
}

const helpId = (/** @type {string} */ itemId) => `rv-mark-help-${itemId}`;
/** The box being marked, in words. @param {any} m @param {number | null} version */
const statusOf = (m, version) => (m ? `Marking ${regionText({ ...m, version: version ?? 1 })}.` : '');

/**
 * The button that starts marking, beside “Comment on the whole app”, and while marking, how to mark and where the box
 * is, in words: drawn only then, so an open review shows its hint alone until the person marks.
 * @param {string} itemId @param {{ d: any, version: number | null, rerender: () => HTMLElement }} env
 */
export function markControls(itemId, env) {
  const { d, version, rerender } = env;
  const on = !!d.marking;
  const toggle = () => {
    if (d.marking) return stopMarking(itemId, d, rerender);
    d.marking = { ...START };
    rerender();
    layers.get(itemId)?.el.focus();
  };
  const button = h(
    'button.btn.sm',
    { type: 'button', 'aria-pressed': String(on), 'data-mark-button': itemId, disabled: version === null, onclick: toggle },
    'Mark a part of the app',
  );
  if (!on) return { button, help: null, status: null };
  const help = h(
    'p.small.dim',
    { id: helpId(itemId) },
    'Drag a box on the app, or click a point. Or move the box with the arrow keys, resize it with Shift and the arrow keys, press Enter to comment on it, or Escape to stop.',
  );
  const status = h('p.small', { 'data-mark-status': itemId, 'aria-live': 'polite' }, statusOf(d.marking, version));
  return { button, help, status };
}

/** Leaves marking, and gives focus back to the button that started it. @param {string} itemId @param {any} d @param {() => HTMLElement} rerender */
function stopMarking(itemId, d, rerender) {
  d.marking = null;
  const n = rerender();
  /** @type {HTMLElement | null} */ (n.querySelector(`[data-mark-button="${CSS.escape(itemId)}"]`))?.focus();
}

/** Opens a comment on the region marked, and leaves marking. @param {any} l @param {{ x: number, y: number, w: number, h: number }} r */
function finish(l, r) {
  const { b, d, version, rerender } = l.env;
  if (version === null) return;
  d.marking = null;
  startComment(d, nextAnchor(b, d), { ...r, version });
  rerender();
}

/**
 * The region from where a drag started to where the pointer is now, as fractions of the layer, within the app: a
 * point when it hardly moved. @param {{ x: number, y: number, rect: DOMRect }} from @param {PointerEvent} e
 */
function dragged(from, e) {
  const { rect } = from;
  const fx = (/** @type {number} */ x) => clamp((x - rect.left) / rect.width, 0, 1);
  const fy = (/** @type {number} */ y) => clamp((y - rect.top) / rect.height, 0, 1);
  if (Math.abs(e.clientX - from.x) < SLOP && Math.abs(e.clientY - from.y) < SLOP) return { x: round(fx(from.x)), y: round(fy(from.y)), w: 0, h: 0 };
  const x = round(Math.min(fx(from.x), fx(e.clientX)));
  const y = round(Math.min(fy(from.y), fy(e.clientY)));
  return {
    x,
    y,
    w: Math.min(round(Math.abs(fx(e.clientX) - fx(from.x))), round(1 - x)),
    h: Math.min(round(Math.abs(fy(e.clientY) - fy(from.y))), round(1 - y)),
  };
}

/** The pointer and the keys on a review’s layer, which take them only while the person is marking. @param {any} l */
function wire(l) {
  const el = l.el;
  /** @type {{ x: number, y: number, rect: DOMRect } | null} */
  let from = null;
  el.addEventListener('pointerdown', (/** @type {PointerEvent} */ e) => {
    if (!l.env?.d.marking || e.button !== 0) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    from = { x: e.clientX, y: e.clientY, rect: el.getBoundingClientRect() };
  });
  el.addEventListener('pointermove', (/** @type {PointerEvent} */ e) => {
    if (!from) return;
    const r = dragged(from, e);
    el.querySelector('.rv-region.marking')?.replaceWith(regionBox(r, '', 'marking'));
  });
  el.addEventListener('pointerup', (/** @type {PointerEvent} */ e) => {
    if (!from) return;
    const r = dragged(from, e);
    from = null;
    finish(l, r);
  });
  el.addEventListener('pointercancel', () => {
    from = null;
    if (l.env) paintMarks(l.env.itemId, l.env);
  });
  el.addEventListener('keydown', (/** @type {KeyboardEvent} */ e) => onKey(l, e));
}

/**
 * The keyboard’s way to mark: the arrow keys move the box, and with Shift resize it; Enter comments on it, and Escape
 * stops marking. @param {any} l @param {KeyboardEvent} e
 */
function onKey(l, e) {
  const env = l.env;
  const m = env?.d.marking;
  if (!m) return;
  if (e.key === 'Escape' || e.key === 'Enter') {
    e.preventDefault();
    e.stopPropagation();
    return e.key === 'Enter' ? finish(l, m) : stopMarking(env.itemId, env.d, env.rerender);
  }
  if (!Object.hasOwn(ARROWS, e.key)) return;
  e.preventDefault();
  const [dx, dy] = ARROWS[/** @type {keyof typeof ARROWS} */ (e.key)];
  env.d.marking = e.shiftKey
    ? { ...m, w: round(clamp(m.w + dx * STEP, SMALLEST, 1 - m.x)), h: round(clamp(m.h + dy * STEP, SMALLEST, 1 - m.y)) }
    : { ...m, x: round(clamp(m.x + dx * STEP, 0, 1 - m.w)), y: round(clamp(m.y + dy * STEP, 0, 1 - m.h)) };
  paintMarks(env.itemId, env);
  const status = document.querySelector(`[data-mark-status="${CSS.escape(env.itemId)}"]`);
  if (status) status.textContent = statusOf(env.d.marking, env.version);
}
