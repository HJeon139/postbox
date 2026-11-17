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

/** Runs it detached, so a browser that stays open isn’t Postbox’s child. @param {[string, string[]]} cmd */
const launch = ([file, args]) =>
  spawn(file, args, { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref();

/**
 * Opens a link from an app the person clicked in. @param {any} rt @param {string} appId @param {unknown} url
 * @param {{ run?: (cmd: [string, string[]]) => unknown, platform?: string }} [opts]  run and platform for tests
 */
export function openLink(rt, appId, url, { run = launch, platform = String(process.platform) } = {}) {
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
  run(/** @type {[string, string[]]} */ (cmd));
  return { ok: true };
}
