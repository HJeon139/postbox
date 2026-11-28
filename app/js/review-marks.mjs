// Marking a part of an app in its review (#856): a click marks a point and a drag a box, anywhere on the app, whether
// or not it names parts, and the arrow keys move a box for a person who can’t drag. Postbox draws on a layer of its
// own over the app’s frame, beside it in the frame’s box, never inside it: the app’s code isn’t trusted to draw what
// the person marked, and its sandbox is unchanged. A region is kept in px of the app’s page, which a review’s frame
// shows whole, as tall as the app (apps.mjs, sizeFrame), with the size of the frame it was marked in. Each region on
// the version shown, in a frame as wide as it was marked in, is drawn with its number; one on another version, or
// marked at another width, where the app may be laid out another way, is listed only (designs/agent-apps.md, the
// review block).

import { regionText } from '/shared/review-regions.mjs';
import { onReleaseApps, shownVersion } from './apps.mjs';
import { client } from './client.mjs';
import { h } from './dom.mjs';
import { startComment } from './review-draft.mjs';
import { probeRegion } from './review-probe.mjs';
import { nextAnchor, regionsOf } from './review-region-numbers.mjs';

/** How far one arrow key moves or resizes the box, in px, and the smallest box it resizes to: a point is a click. */
const STEP = 8;
const SMALLEST = 8;
/** How far a frame’s width may be from the one a region was marked in, in px, for the region to be drawn in it. */
const SAME_WIDTH = 4;
/** A drag shorter than this, in pixels each way, is a click, so a point; touch gets more slop for a finger. */
const SLOP = 4;
const TOUCH_SLOP = 8;
/** What each arrow key does to a box: moves it, or with Shift, moves its right or bottom edge. */
const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/**
 * Each review’s layer over its app’s frame, by its item, with the latest render’s view of the review (env): kept
 * across renders, as the frame is (review-app.mjs, rerenderAround), so a repaint never takes focus from it. Held
 * weakly: the layer’s own listeners keep it while its element is on the page or in a render being built, and a review
 * the page let go of, as when the person leaves its room, takes its layer, and the render it saw, with it.
 * @type {Map<string, WeakRef<{ el: HTMLElement, watch: MutationObserver | null, env: any, width: number | null }>>}
 */
const layers = new Map();
onReleaseApps(releaseMarks);

const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.min(hi, Math.max(lo, v));

/** The version of the app the review shows, as apps.mjs mounts it, or null when the app is gone. @param {any} b @param {boolean} done */
export function versionOf(b, done) {
  const app = client.state.apps[b.appId];
  return app ? shownVersion(app, !done) : null;
}

/**
 * Where a region is, after its anchor in the review’s list of comments: every drawn region is said in words too, and
 * one on another version, or marked in a frame of another width, says it isn’t drawn. @param {any} region
 * @param {number | null} version  the one shown @param {number | null} width  the frame’s now, null before it’s laid out
 */
export function regionNote(region, version, width) {
  if (!region) return '';
  if (region.version !== version) return ` · ${regionText(region)}, so it isn’t drawn on this version`;
  if (width !== null && !drawnAt(region, width)) return ` · ${regionText(region)}, marked ${region.width} px wide, so it isn’t drawn at this width`;
  return ` · ${regionText(region)}`;
}

/** Whether a region is drawn in a frame this wide: one as wide as it was marked in. @param {any} r @param {number} width */
const drawnAt = (r, width) => Math.abs(width - r.width) <= SAME_WIDTH;

/** The frame a layer is over, once it’s placed. @param {any} l @returns {HTMLIFrameElement | null} */
const frameOf = (l) => l.el.parentElement?.querySelector(':scope > iframe.app-iframe') ?? null;

/** The size of a layer’s frame in CSS px, or null before it’s laid out. @param {any} l */
function sizeOf(l) {
  const f = frameOf(l);
  return f?.clientWidth ? { width: f.clientWidth, height: Math.max(1, f.clientHeight) } : null;
}

/** The layer for a review, made once. @param {string} itemId */
function layerOf(itemId) {
  let l = layers.get(itemId)?.deref();
  if (!l) {
    l = { el: h('div.rv-marks', { 'data-marks': itemId }), watch: null, env: null, width: null, resize: null };
    layers.set(itemId, new WeakRef(l));
    wire(l);
  }
  return l;
}

/**
 * Releases layers whose element is no longer on the page, disconnecting their observers so nothing keeps a detached
 * room’s DOM or render closure alive (#856). Called from releaseApps() when a conversation view leaves the page.
 */
export function releaseMarks() {
  for (const [id, ref] of layers) {
    const l = ref.deref();
    if (!l || !l.el.isConnected) {
      l?.watch?.disconnect();
      l?.resize?.disconnect();
      l?.el.remove();
      if (l) l.env = null;
      layers.delete(id);
    }
  }
}

/** Keeps the review’s mark button enabled only while its app’s frame is mounted (#856). @param {string} itemId @param {any} l */
function syncButton(itemId, l) {
  const btn = l.env?.pins?.querySelector(`[data-mark-button="${CSS.escape(itemId)}"]`);
  if (btn instanceof HTMLButtonElement) btn.disabled = !frameOf(l) || l.env?.version === null;
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
    syncButton(itemId, l);
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
  const regions = regionsOf(b, d);
  const width = sizeOf(l)?.width ?? null;
  l.width = width;
  const drawn = [...regions].filter(([, r]) => r.version === version && width !== null && drawnAt(r, width));
  el.replaceChildren(...drawn.map(([a, r]) => regionBox(r, a.slice('region '.length))), ...(marking ? [regionBox(marking, '', 'marking')] : []));
  // Whether each is drawn is said in the list of comments, which a resize changes without a render.
  for (const note of env.pins?.querySelectorAll('[data-region-note]') ?? [])
    note.textContent = regionNote(regions.get(/** @type {HTMLElement} */ (note).dataset.regionNote), version, width);
  syncButton(itemId, l);
}

/**
 * A region drawn: an outlined box, or a dot for a point, with its number. The words for it are in the list of
 * comments (regionNote), so a screen reader skips it. @param {any} r @param {string} n @param {string} [cls]
 */
export function regionBox(r, n, cls = '') {
  const point = r.w === 0 && r.h === 0;
  const px = (/** @type {number} */ n) => `${n}px`;
  const size = point ? {} : { width: px(r.w), height: px(r.h) };
  return h(
    'div.rv-region',
    {
      class: [point ? 'point' : '', cls].filter(Boolean).join(' '),
      'aria-hidden': 'true',
      'data-region': n || null,
      style: { left: px(r.x), top: px(r.y), ...size },
    },
    n ? h('span.rv-region-n', n) : null,
  );
}

const helpId = (/** @type {string} */ itemId) => `rv-mark-help-${itemId}`;
/** The box being marked, in words. @param {any} m @param {number | null} version */
const statusOf = (m, version) => (m ? `Marking ${regionText({ ...m, version: version ?? 1 })}.` : '');

/** The box the keyboard starts from: a fifth of the frame each way, in its middle. @param {{ width: number, height: number }} f */
const startBox = (f) => ({ x: Math.round(f.width * 0.4), y: Math.round(f.height * 0.4), w: Math.round(f.width * 0.2), h: Math.round(f.height * 0.2), ...f });

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
    const l = layers.get(itemId)?.deref();
    const size = l && sizeOf(l);
    if (!size) return;
    d.marking = startBox(size);
    rerender();
    layers.get(itemId)?.deref()?.el.focus();
  };
  const button = h(
    'button.btn.sm',
    { type: 'button', 'aria-pressed': String(on), 'data-mark-button': itemId, disabled: version === null || !frameOf(layers.get(itemId)?.deref() ?? { el: h('div') }), onclick: toggle },
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

/**
 * Opens a comment on the region marked, and leaves marking. What the app has there joins the region when the kit
 * answers, on the region the comment holds, so the box opens at once. @param {any} l
 * @param {{ x: number, y: number, w: number, h: number, width: number, height: number }} r
 */
function finish(l, r) {
  const { b, d, version, rerender } = l.env;
  if (version === null) return;
  d.marking = null;
  const region = { ...r, version };
  void probeRegion(frameOf(l), r).then((under) => {
    if (under) Object.assign(region, { under });
  });
  startComment(d, nextAnchor(b, d), region);
  rerender();
}

/**
 * The region from where a drag started to where the pointer is now, in px of the frame, within it: a point when it
 * hardly moved. @param {{ x: number, y: number, rect: DOMRect, width: number, height: number }} from @param {PointerEvent} e
 */
function dragged(from, e) {
  const { rect, width, height } = from;
  const px = (/** @type {number} */ x) => Math.round(clamp(x - rect.left, 0, width));
  const py = (/** @type {number} */ y) => Math.round(clamp(y - rect.top, 0, height));
  const slop = e.pointerType === 'touch' ? TOUCH_SLOP : SLOP;
  if (Math.abs(e.clientX - from.x) < slop && Math.abs(e.clientY - from.y) < slop) return { x: px(from.x), y: py(from.y), w: 0, h: 0, width, height };
  const [x0, x1] = [px(from.x), px(e.clientX)];
  const [y0, y1] = [py(from.y), py(e.clientY)];
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0), width, height };
}

/** The pointer and the keys on a review’s layer, which take them only while the person is marking. @param {any} l */
function wire(l) {
  const el = l.el;
  /** @type {{ x: number, y: number, rect: DOMRect, width: number, height: number } | null} */
  let from = null;
  el.addEventListener('pointerdown', (/** @type {PointerEvent} */ e) => {
    const size = sizeOf(l);
    if (!l.env?.d.marking || e.button !== 0 || !size) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    from = { x: e.clientX, y: e.clientY, rect: el.getBoundingClientRect(), ...size };
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
  // A frame of another width draws other regions, and says so in the list (regionNote), with no render.
  l.resize = new ResizeObserver(() => {
    if (l.env && sizeOf(l)?.width !== l.width) paintMarks(l.env.itemId, l.env);
  });
  l.resize.observe(el);
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
    ? { ...m, w: clamp(m.w + dx * STEP, SMALLEST, m.width - m.x), h: clamp(m.h + dy * STEP, SMALLEST, m.height - m.y) }
    : { ...m, x: clamp(m.x + dx * STEP, 0, m.width - m.w), y: clamp(m.y + dy * STEP, 0, m.height - m.h) };
  paintMarks(env.itemId, env);
  const status = document.querySelector(`[data-mark-status="${CSS.escape(env.itemId)}"]`);
  if (status) status.textContent = statusOf(env.d.marking, env.version);
}
