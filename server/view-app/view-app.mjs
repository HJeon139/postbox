// view_app { appId }: a picture of an agent’s app, as the person first sees it (#95; designs/architecture.md, “Agents
// see their app”). Postbox renders the app inline in its own page, in a pinned headless browser the person agreed to
// download (consent.mjs), at the size of the person’s Postbox window, or 1000 × 680 with no tab open. The picture goes
// to the agent as an image when its backend takes one, and is saved in its folder either way.

import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppBrowser, DEFAULT_WINDOW } from './browser.mjs';
import { answerIn, askToSee } from './consent.mjs';
import { viewOf } from './view-of.mjs';

/** The widths and heights a reported window may have; anything outside is ignored. */
const WINDOW = Object.freeze({ min: 320, max: 4000 });
/** How long a tab’s report of its window counts: a tab reports each time it shows a conversation. */
const WINDOW_FRESH_MS = 30 * 60 * 1000;

export class ViewApp {
  /** @param {{ dataDir: string, origin: () => string, browser?: AppBrowser }} opts  origin: read after Postbox listens, for its port */
  constructor({ dataDir, origin, browser }) {
    this.dir = join(dataDir, 'browsers');
    this.origin = origin;
    this.browser = browser ?? new AppBrowser({ dir: this.dir });
    /** @type {{ width: number, height: number, column: number|null, theme: 'light'|'dark', at: number }|null} */
    this.window = null;
  }

  /**
   * The person’s window, from their open Postbox tab’s report of the conversation it shows (server/index.mjs, the
   * view route), with how wide the conversation is there beside the rail and any pane. Bounded where it enters; a
   * report that isn’t a window is ignored, and a column that doesn’t fit in it is left to the page’s own layout.
   * @param {unknown} body
   */
  noteWindow(body) {
    const b = /** @type {any} */ (body ?? {});
    const w = Math.round(Number(b.width));
    const h = Math.round(Number(b.height));
    if (!(w >= WINDOW.min && w <= WINDOW.max && h >= WINDOW.min && h <= WINDOW.max)) return;
    const c = Math.round(Number(b.column));
    const column = c >= WINDOW.min / 2 && c <= w ? c : null;
    this.window = { width: w, height: h, column, theme: b.theme === 'dark' ? 'dark' : 'light', at: Date.now() };
  }

  /** The window a capture uses now. */
  windowNow() {
    const w = this.window;
    if (w && Date.now() - w.at < WINDOW_FRESH_MS) return w;
    // No tab: the page lays the conversation out beside the rail, as a person opening it would see it.
    return { ...DEFAULT_WINDOW, column: null, theme: /** @type {'light'} */ ('light') };
  }

  close() {
    return this.browser.close();
  }
}

/**
 * The tool, for the session it acts for. Refuses an app outside the agent’s conversation, asks the person before the
 * first download, and says plainly when it can’t show anything.
 * @param {any} rt @param {string} sessionId @param {{ appId?: unknown }} args
 * @param {{ threadId: () => string, endSegment: () => void, images: boolean }} ctx
 */
export async function viewApp(rt, sessionId, { appId } = {}, ctx) {
  const view = viewOf(rt);
  const se = rt.session(sessionId);
  const id = String(appId ?? '').slice(0, 80);
  const app = rt.s.apps[id];
  if (!app || conversationOf(rt, app.threadId) !== conversationOf(rt, se.threadId))
    return { ok: false, message: `There’s no app “${id}” in your conversation. Use the appId show_app returned.` };
  if (rt.personaFor(se)?.remote?.hostId)
    return { ok: false, message: 'view_app can’t show an app to an agent on another computer yet. Ask the person how it looks.' };
  const status = view.browser.status();
  if (status === 'no-package')
    return {
      ok: false,
      message: 'Postbox can’t render apps here: playwright-core, its optional browser package, isn’t installed. Ask the person how it looks.',
    };
  const answer = answerIn(view.dir);
  if (answer === 'declined')
    return {
      ok: false,
      message: 'The person chose not to download the browser that renders apps for now, so view_app can’t show you this one. Ask them how it looks.',
    };
  if (answer === 'unasked' || status === 'missing') {
    if (answer === 'allowed' && view.browser.installing)
      return { ok: true, waiting: true, message: 'The browser is still downloading. End your turn; you’ll hear when it’s ready.' };
    return askToSee(rt, sessionId, ctx.threadId(), ctx.endSegment);
  }
  const item = rt.store.items(app.threadId).find((x) => x.block?.id === id);
  if (!item) return { ok: false, message: `${id} isn’t in its thread any more, so there’s nothing to render.` };
  const win = view.windowNow();
  let png;
  try {
    png = await view.browser.capture({ origin: view.origin(), threadId: app.threadId, itemId: item.id, ...win });
  } catch (e) {
    return { ok: false, message: `Postbox couldn’t render ${id}: ${e.message} The pre-display check still stands.` };
  }
  const saved = await save(rt, sessionId, `${id}-v${app.current}.png`, png);
  const where = saved ? ` Saved as ${saved}.` : '';
  return {
    ok: true,
    message: `${id} v${app.current} as the person first sees it, inline in the conversation, in a ${win.width} × ${win.height} window, ${win.theme} theme.${where}`,
    image: ctx.images ? { data: png.toString('base64'), mimeType: 'image/png' } : null,
  };
}

/** A conversation’s id, for a thread in it: its own, or its parent’s for a side or topic thread. */
function conversationOf(rt, threadId) {
  const t = rt.s.threads[threadId];
  return t?.parentId && rt.s.threads[t.parentId] ? t.parentId : threadId;
}

/**
 * Saves the picture in the agent’s own folder, under .postbox/view, written atomically. Returns its path, or null when
 * the agent has no folder, so the image alone goes back. @param {any} rt @param {string} sessionId @param {string} name
 * @param {Buffer} png
 */
async function save(rt, sessionId, name, png) {
  const [folder] = await rt.agentFolders(sessionId);
  if (!folder) return null;
  const dir = join(folder, '.postbox', 'view');
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, png);
  await rename(tmp, file);
  return file;
}
