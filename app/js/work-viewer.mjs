// Work’s viewer (#1446): a room asset, or a file the agents changed as they left it, read in the pane. Markdown is
// drawn by renderMarkdown() in trusted(), other text goes in as text (its first VIEWER.textBytes), the four safe image
// types show as an image from their route, and anything else shows its details and a download. Nothing an agent wrote
// runs here: HTML and SVG come as text when they are text, never as a page (server/room-files.mjs serves them so).

import { INLINE_TYPES } from '/shared/files.mjs';
import { VIEWER } from '/shared/limits.mjs';
import { roomAsset } from '/shared/room-refs.mjs';
import { formatBytes } from '/shared/work.mjs';
import { client } from './client.mjs';
import { fill, h, icon, timeOf } from './dom.mjs';
import { mdNode, openWork, route } from './ui.mjs';

const MARKDOWN = /\.(md|markdown)$/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;

/**
 * @typedef {{ name: string, url: string, key: string, how: 'markdown' | 'text' | 'image' | 'other', meta: string[],
 *   size: number, path?: string, diff?: string, missing?: string }} Viewed
 */

/** How a file shows, from what’s known of it: Markdown first, then an image, then text. @returns {Viewed['how']} */
function showAs({ markdown = false, image = false, text = false }) {
  if (markdown) return 'markdown';
  if (image) return 'image';
  return text ? 'text' : 'other';
}

/** Why a changed file has nothing to show, or null when Postbox kept a copy. @param {any} f */
function noCopy(f) {
  if (f.after?.sha256) return null;
  if (f.after?.exists) return `Postbox kept no copy of ${f.rel}: it was larger than 4 MB, or unreadable.`;
  return 'The agents deleted this file.';
}

/** An asset of the conversation’s room, as the viewer shows it. @param {string} convId @param {any} asset @returns {Viewed} */
function assetView(convId, asset) {
  const v = asset.versions[asset.head - 1];
  const how = showAs({ markdown: MARKDOWN.test(asset.name) || v.type === 'text/markdown', image: INLINE_TYPES.has(v.type), text: v.isText });
  return {
    name: asset.name,
    url: `/api/threads/${convId}/assets/${asset.id}?v=${v.v}`,
    key: `${asset.id}:${v.v}`,
    how,
    size: v.size,
    meta: ['Asset', `v${v.v} by ${v.author}`, timeOf(v.at), formatBytes(v.size)],
  };
}

/** A changed file, as the agents left it. @param {string} convId @param {any} f @returns {Viewed} */
function fileView(convId, f) {
  const after = f.after ?? {};
  const how = showAs({ markdown: !after.binary && MARKDOWN.test(f.rel), image: after.binary && IMAGE_FILE.test(f.rel), text: !after.binary });
  const kept = noCopy(f);
  return {
    name: f.rel,
    url: `/api/threads/${convId}/work/files/${f.id}/content`,
    key: `${f.id}:${after.sha256 ?? 'none'}`,
    how,
    size: after.size ?? 0,
    meta: ['Changed file', `by ${f.handles?.join(', ') ?? 'an agent'}`, after.size != null ? formatBytes(after.size) : ''],
    path: f.path,
    diff: f.id,
    ...(kept ? { missing: kept } : {}),
  };
}

/**
 * What the viewer shows for an id in a conversation, or null when the conversation has no such asset or file.
 * @param {string} convId @param {string} at @returns {Viewed | null}
 */
export function viewed(convId, at) {
  const state = client.state;
  const asset = roomAsset(state, convId, at);
  if (asset) return assetView(convId, asset);
  const f = (state.work?.[convId] ?? []).find((e) => e.id === at && e.kind === 'file');
  return f ? fileView(convId, f) : null;
}

/** The body: an image, or text or Markdown once it loads, or what to do instead. @param {Viewed} v */
function content(v) {
  if (v.missing) return h('p.empty-note', v.missing);
  if (v.how === 'image') return h('img.wv-img', { src: v.url, alt: v.name });
  if (v.how === 'other') return h('p.empty-note', 'Postbox shows text, Markdown and images here. Download this file to open it.');
  const box = h('div.wv-text', { 'aria-busy': 'true' }, h('p.small.dim', 'Loading…'));
  fetch(v.url, { cache: 'no-store' })
    .then(async (r) => {
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `The server answered ${r.status}.`);
      return r.text();
    })
    .then((text) => {
      // The route sends at most VIEWER.textBytes of text (server/room-files.mjs).
      const cut = v.size > VIEWER.textBytes;
      fill(
        box,
        v.how === 'markdown' ? mdNode(text) : h('pre.wv-pre.mono', text),
        cut ? h('p.small.dim', `Showing the first ${formatBytes(VIEWER.textBytes)} of ${formatBytes(v.size)}. Download it for the rest.`) : null,
      );
    })
    .catch((e) => fill(box, h('p.empty-note', `Postbox couldn’t load it: ${e.message}`)))
    .finally(() => box.removeAttribute('aria-busy'));
  return box;
}

/**
 * The viewer for one asset or file, in place of the pane’s lists until Back.
 * @param {string} convId @param {string} at @param {{ back: () => void }} opts
 * @returns {{ el: HTMLElement, key: string, back: HTMLElement }}
 */
export function mountViewer(convId, at, { back }) {
  const v = viewed(convId, at);
  const backBtn = h('button.btn.sm.ghost', { type: 'button', id: 'wv-back', onclick: back }, icon('back', 'i-sm'), 'Back to Work');
  if (!v)
    return {
      el: h('section.wv', { 'aria-label': 'Not found' }, backBtn, h('p.empty-note', 'This conversation has no such asset or file. It may have been deleted.')),
      key: `${at}:gone`,
      back: backBtn,
    };
  const el = h(
    'section.wv',
    { 'aria-labelledby': 'wv-title', dataset: { at } },
    backBtn,
    h('h2.wv-name.mono', { id: 'wv-title' }, v.name),
    h('p.small.dim', v.meta.filter(Boolean).join(' · ')),
    v.path ? h('p.small.dim.mono.wv-path', v.path) : null,
    h(
      'div.work-actions',
      v.missing ? null : h('a.btn.sm', { href: `${v.url}${v.url.includes('?') ? '&' : '?'}download=1`, download: v.name.replace(/^.*\//, '') }, 'Download'),
      v.diff ? h('button.btn.sm', { type: 'button', onclick: () => openWork(convId, { full: true, at: v.diff }) }, 'Diff') : null,
    ),
    content(v),
  );
  return { el, key: v.key, back: backBtn };
}

/**
 * The viewer in the Work pane: open while the address names an asset or file of this conversation (`?work&at=<id>`,
 * not full screen), drawn again when what it shows gets a new version. Focus goes to Back when it opens from the
 * pane, and back to the row that opened it when it closes.
 * @param {string} convId @param {HTMLElement} pane  the pane, for where focus is @param {HTMLElement} body  what it fills
 * @param {() => void} paint  draws the pane’s lists again
 */
export function paneViewer(convId, pane, body, paint) {
  /** @type {{ at: string, key: string, opener: string | null } | null} */
  let shown = null;
  const back = () => openWork(convId);
  const show = (at) => {
    if (shown?.key === (viewed(convId, at)?.key ?? `${at}:gone`)) return;
    const active = document.activeElement;
    const fromPane = active instanceof HTMLElement && pane.contains(active);
    const v = mountViewer(convId, at, { back });
    // The row it opened from, kept while a newer version is shown in its place.
    const opener = shown?.opener ?? (fromPane && active.id ? active.id : null);
    shown = { at, key: v.key, opener };
    fill(body, v.el);
    body.scrollTop = 0;
    if (fromPane) v.back.focus();
  };
  const close = () => {
    if (!shown) return;
    const { opener } = shown;
    const had = pane.contains(document.activeElement);
    shown = null;
    paint();
    if (had && opener) document.getElementById(opener)?.focus();
  };
  const sync = () => {
    const r = route();
    const at = r.view === 'thread' && r.threadId === convId && r.work && !r.full ? r.at : null;
    if (at) show(at);
    else close();
  };
  // A new version of what’s shown, or what’s shown gone.
  const off = client.on((ch) => {
    if (shown && (ch.type === 'load' || ch.type.startsWith('asset') || ch.type.startsWith('work.'))) sync();
  });
  addEventListener('hashchange', sync);
  addEventListener('pb-pane', sync);
  sync();
  return {
    get open() {
      return shown !== null;
    },
    destroy() {
      off();
      removeEventListener('hashchange', sync);
      removeEventListener('pb-pane', sync);
    },
  };
}
