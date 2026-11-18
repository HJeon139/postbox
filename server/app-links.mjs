// A web link the person clicked in an app, opened in their default browser (#1480). The page asks for this only in the
// Claude desktop app’s browser pane, where window.open replaces Postbox’s own page instead of opening a tab (measured in
// the flexible-apps prototype, #1475; designs/architecture/sandbox.md, “No popups; links through the bridge”). Only http and https, as an argument, never through a shell.

import { spawn } from 'node:child_process';
import { httpError } from './helpers.mjs';

/**
 * The command that opens a URL in this computer’s default browser, as [file, args], or null.
 * @param {string} url @param {string} [platform]
 */
export function opener(url, platform = process.platform) {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'linux') return ['xdg-open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return null;
}

/**
 * Runs it detached, so a browser that stays open isn’t Postbox’s child. Settles once it has started, or failed to (no
 * such opener on this computer). @param {[string, string[]]} cmd @returns {Promise<void>}
 */
const launch = ([file, args]) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'ignore', detached: true }).on('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

// The page opens one link per click in an app (app/js/app-links.mjs). This holds anything calling the route itself, with
// the page’s token, to a few a minute per app, more than a person clicks through.
export const OPEN_LIMIT = 10;
const OPEN_WINDOW_MS = 60_000;
/** @type {WeakMap<object, Map<string, number[]>>} each runtime’s apps → when each opened a link */
const openedAt = new WeakMap();

/** Counts this open against the app’s minute, or refuses it past the limit. @param {object} rt @param {string} appId @param {number} now */
function spend(rt, appId, now) {
  const apps = openedAt.get(rt) ?? new Map();
  openedAt.set(rt, apps);
  const times = (apps.get(appId) ?? []).filter((t) => now - t < OPEN_WINDOW_MS);
  if (times.length >= OPEN_LIMIT) throw httpError(429, `Postbox opens at most ${OPEN_LIMIT} links a minute from one app. Wait a minute, then click it again.`);
  apps.set(appId, [...times, now]);
}

/**
 * Opens a link from an app the person clicked in. @param {any} rt @param {string} appId @param {unknown} url
 * @param {{ run?: (cmd: [string, string[]]) => Promise<unknown>, platform?: string, now?: number }} [opts]  stand-ins for tests
 */
export async function openLink(rt, appId, url, { run = launch, platform = String(process.platform), now = Date.now() } = {}) {
  if (!rt.s.apps[appId]) throw httpError(404, 'That app doesn’t exist.');
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw httpError(400, 'An app’s link needs an absolute http or https URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw httpError(400, 'Postbox opens only http and https links from apps.');
  const cmd = opener(u.href, platform);
  if (!cmd) throw httpError(501, 'Postbox can’t open links on this system.');
  spend(rt, appId, now);
  try {
    await run(/** @type {[string, string[]]} */ (cmd));
  } catch (e) {
    throw httpError(502, `Postbox couldn’t open the link (${e instanceof Error ? e.message : e}). Open ${u.href} in your browser.`);
  }
  return { ok: true };
}
