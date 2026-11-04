// The UAT driver’s screenshots (tools/uat/driver.mjs): an item as a person sees it, and the whole window. Moved out of
// driver.mjs, which is at its size.
// R1 (#531): a runner action leaves the person’s view as it was. A shot scrolls to its item, so it runs in keepView,
// which puts each transcript’s view back after it, by what the transcript publishes (app/js/view-state.mjs, publish).

import { writeFile } from 'node:fs/promises';
import { js } from '../browser.mjs';
import { ITEM } from './selectors.mjs';

// Each transcript on the page, its scroll box, and where its view starts: view-state.mjs’s box() and viewTop().
const TRANSCRIPTS = `[['main', document.querySelector('#main.transcript')], ['panel', document.querySelector('.sidepanel .transcript')]]
  .filter(([, el]) => el)
  .map(([where, el]) => {
    const s = where === 'panel' ? el.parentElement : document.scrollingElement;
    return { where, el, s, top: () => (where === 'panel' ? s.getBoundingClientRect().top : 0) };
  })`;
const NODE = `(t, key) => (key ? t.el.querySelector(':scope > [data-key="' + CSS.escape(key) + '"]') : null)`;
/**
 * What each transcript publishes, and how far from its end it is. `at` is where an item starts in its view: the one
 * `keys` names for it, else its own anchor.
 * @param {Record<string, string>} keys
 */
const READ = (keys) => `(() => {
  const node = ${NODE};
  const keys = ${js(keys)};
  return ${TRANSCRIPTS}.map((t) => {
    const { viewMode: mode = '', viewAnchor: anchor = '', viewOffset: offset = '' } = t.el.dataset;
    const n = node(t, keys[t.where] || anchor);
    const gap = t.s.scrollHeight - t.s.scrollTop - t.s.clientHeight;
    return { where: t.where, mode, anchor, offset: offset === '' ? null : Number(offset), at: n ? n.getBoundingClientRect().top - t.top() : null, gap };
  });
})()`;
/**
 * Back as each was: to the end of its own box while it was following; while reading, its anchor’s top at its offset,
 * found by its key. An anchor that’s gone leaves the view where it is.
 * @param {any[]} before
 */
const RESTORE = (before) => `(() => {
  const node = ${NODE};
  const before = ${js(before)};
  for (const t of ${TRANSCRIPTS}) {
    const b = before.find((x) => x.where === t.where);
    if (!b) continue;
    if (b.mode === 'following') t.s.scrollTo({ top: t.s.scrollHeight, behavior: 'instant' });
    else {
      const n = node(t, b.anchor);
      if (n) t.s.scrollBy({ top: n.getBoundingClientRect().top - t.top() - b.offset, behavior: 'instant' });
    }
  }
})()`;
// A scroll set now reaches the page’s onScroll, which publishes, only in a later frame.
const SETTLED = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))';

/**
 * Whether a view came back as it was: the same mode, and while reading, the same anchor at its offset within 1 px. A
 * reading view put back within 2 px of the end comes back following (view-state.mjs, atEnd), so that is kept too, if
 * its anchor is within 2 px of where it was; and one whose anchor has gone can’t be put back, which isn’t the runner’s.
 * @param {any} b  as it was  @param {any} a  after, with `at` where b’s anchor now starts
 */
export function kept(b, a) {
  if (b.mode === 'following') return a.mode === 'following';
  if (a.at === null) return true;
  if (a.mode === 'reading') return a.anchor === b.anchor && Math.abs(a.offset - b.offset) <= 1;
  return a.mode === 'following' && a.gap <= 2 && Math.abs(a.at - b.offset) <= 2;
}

/**
 * Runs fn, then puts every transcript’s view back as it was before, however fn ended, and once the page has settled,
 * checks it is: `moved` hears each one that isn’t.
 * @template T @param {(expr: string) => Promise<any>} ev @param {() => Promise<T>} fn
 * @param {(m: { where: string, before: any, after: any }) => void} moved
 * @returns {Promise<T>}
 */
export async function keepView(ev, fn, moved) {
  const before = await ev(READ({}));
  try {
    return await fn();
  } finally {
    await ev(RESTORE(before));
    await ev(SETTLED);
    const after = await ev(READ(Object.fromEntries(before.map((b) => [b.where, b.anchor]))));
    for (const b of before) {
      const a = after.find((x) => x.where === b.where);
      if (a && !kept(b, a)) moved({ where: b.where, before: b, after: a });
    }
  }
}

/**
 * @param {{ ev: (expr: string) => Promise<any>, page: any, sleep: (ms: number) => Promise<unknown>, input?: (e: any) => void }} o
 *   ev: the driver’s page.evaluate; page: from tools/browser.mjs launch(); input: hears a shot that moved the person’s
 *   view, as the runner’s (facts.probes.inputs, tools/uat/probes.mjs)
 */
export function shots({ ev, page, sleep, input = () => {} }) {
  /** What a person sees of an item, scrolled to it: shotItem, without putting the view back. */
  async function shotOf(key, file) {
    const ok = await ev(
      `(() => { const n = ${ITEM(key)}; if (!n) return false; n.scrollIntoView({ block: 'start' }); scrollBy(0, -((document.querySelector('header.topbar')?.offsetHeight ?? 0) + 8)); return true; })()`,
    );
    if (!ok) return null;
    // Apps far off screen are unloaded; give them a moment to load again and draw. (The clip is in page
    // coordinates, so the scroll offset is added below.)
    await sleep((await ev(`!!${ITEM(key)}.querySelector('iframe')`)) ? 2500 : 300);
    const r = await ev(
      `(() => { const b = ${ITEM(key)}.getBoundingClientRect(); const top = Math.max(b.top - 6, 0); return { x: Math.max(0, b.left - 6) + scrollX, y: top + scrollY, width: Math.min(b.width + 12, innerWidth), height: Math.max(1, Math.min(b.bottom + 6, innerHeight) - top) }; })()`,
    );
    const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { ...r, scale: 1 } });
    await writeFile(file, Buffer.from(data, 'base64'));
    return file;
  }
  const moved = (/** @type {any} */ m) => input({ cause: 'runner', ...m });
  return {
    /**
     * What a person sees of an item: scrolled to just below the top bar, and only what fits in the window.
     * (Capturing beyond the window paints the sticky top bar mid-item, and leaves sandboxed frames blank.) The view
     * is put back after, as it was.
     */
    shotItem: (key, file) => keepView(ev, () => shotOf(key, file), moved),

    // It doesn’t scroll, so there’s no view to put back.
    async shotScreen(file) {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      await writeFile(file, Buffer.from(data, 'base64'));
      return file;
    },
  };
}
