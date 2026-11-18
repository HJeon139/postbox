// A web link the person clicked in an agent app, which app/kit/links.js hands over the bridge (#1480): a new tab in a
// browser, and in the Claude desktop app’s pane, where window.open replaces this page, Postbox’s server opens it in the
// default browser instead (designs/architecture/sandbox.md, “No popups; links through the bridge”).

import { api } from './client.mjs';
import { toast } from './ui.mjs';

// A click’s activation lasts about 5 s in Chromium, and nothing in the frame uses it up: a burst of links, or a timer
// after the click, would each find it still active. So one open spends it, and the frame’s next open waits for a new
// click. Opening a tab uses up the activation of the whole page, frames included, so in a browser a new click shows up
// as this page’s activation again. The pane opens no tab here, so there a new click can’t be told from the old one until
// the old one has lapsed.
const ACTIVATION_MS = 5000;
/** @type {WeakMap<HTMLIFrameElement, { at: number, usedUp: boolean }>} each app frame’s last open */
const spent = new WeakMap();

/** Whether the message carries a click in the app that hasn’t opened a link yet. @param {MessageEvent} e @param {HTMLIFrameElement} frame */
function freshClick(e, frame, now = Date.now()) {
  // Without the click’s snapshot in the message (Firefox and Safari, #76), Postbox can’t tell which frame was clicked:
  // links open nothing there, as sends wait for the person.
  if (e.userActivation?.isActive !== true) return false;
  const last = spent.get(frame);
  return !last || now - last.at >= ACTIVATION_MS || (last.usedUp && navigator.userActivation?.isActive === true);
}

/**
 * Opens the link when the person just clicked or pressed a key in this app, and no link opened from that click yet. An
 * app asking on its own is refused without a word: there’s nothing for the person to do about it.
 * @param {MessageEvent} e @param {{ appId: string, iframe: HTMLIFrameElement, check?: boolean }} rec @param {unknown} url
 * @param {string|null} refused  apps.mjs’s activated(): null when the click or key press was in this app
 */
export function openAppLink(e, rec, url, refused) {
  const href = String(url);
  // A web link exactly as written: no other scheme, and nothing before it.
  if (rec.check || refused || !/^https?:\/\//i.test(href) || !freshClick(e, rec.iframe)) return;
  const pane = / Claude\//.test(navigator.userAgent);
  spent.set(rec.iframe, { at: Date.now(), usedUp: !pane });
  if (!pane) window.open(href, '_blank', 'noopener,noreferrer');
  else
    api(`/api/apps/${encodeURIComponent(rec.appId)}/open`, { url: href }).catch((err) =>
      toast({ title: 'That link didn’t open', text: err.message, level: 'blocking' }),
    );
}
