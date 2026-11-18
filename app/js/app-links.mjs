// A web link the person clicked in an agent app, which app/kit/links.js hands over the bridge (#1480): a new tab in a
// browser, and in the Claude desktop app’s pane, where window.open replaces this page, Postbox’s server opens it in the
// default browser instead (designs/architecture/sandbox.md, “No popups; links through the bridge”).

import { api } from './client.mjs';
import { toast } from './ui.mjs';

// A click’s activation lasts about 5 s in Chromium, and nothing in the frame uses it up: a burst of links, or a timer
// after the click, would each find it still active. So one open spends it, and the frame’s next open waits for a new
// click. Opening a tab uses up the activation of the whole page, frames included, so in a browser a new click shows up
// as this page’s activation again. The pane opens no tab here, so there a new click can’t be told from the old one until
// the old one has lapsed. The 5 s count from the open, when Postbox spent the click, not from when the app asked.
const ACTIVATION_MS = 5000;
/** @type {WeakMap<HTMLIFrameElement, { at: number, usedUp: boolean, told?: boolean }>} each app frame’s last open */
const spent = new WeakMap();

/**
 * Whether the message carries a click in the app that hasn’t opened a link yet: 'fresh', 'spent' when that click
 * already opened one, or 'none' when it carries no click. @param {MessageEvent} e @param {HTMLIFrameElement} frame
 */
function clickIn(e, frame, now = Date.now()) {
  // Without the click’s snapshot in the message (Firefox and Safari, #76), Postbox can’t tell which frame was clicked:
  // links open nothing there, as sends wait for the person.
  if (e.userActivation?.isActive !== true) return 'none';
  const last = spent.get(frame);
  if (!last || now - last.at >= ACTIVATION_MS || (last.usedUp && navigator.userActivation?.isActive === true)) return 'fresh';
  return 'spent';
}

/**
 * In the pane, a person’s second click within the 5 s is refused as the app’s own burst is, so it says why, once per
 * frame per 5 s. In a browser a new click always opens, so a refusal there is only ever the app’s, and says nothing.
 * @param {HTMLIFrameElement} frame
 */
function sayOnePerClick(frame) {
  const last = spent.get(frame);
  if (!last || last.usedUp || last.told) return;
  last.told = true;
  toast({ title: 'Postbox opens one link per click from an app. Click it again in a moment.' });
}

/**
 * The app’s link as Postbox parsed it, or null unless it’s a web link exactly as written: http or https, with nothing
 * before it (the URL parser drops leading spaces, which a person reading the link wouldn’t see). @param {unknown} url
 */
function webLink(url) {
  const href = String(url);
  if (href !== href.trimStart()) return null;
  let u;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
}

/**
 * Opens the link when the person just clicked or pressed a key in this app, and no link opened from that click yet. An
 * app asking on its own is refused without a word: there’s nothing for the person to do about it.
 * @param {MessageEvent} e @param {{ appId: string, iframe: HTMLIFrameElement, check?: boolean }} rec @param {unknown} url
 * @param {string|null} refused  apps.mjs’s activated(): null when the click or key press was in this app
 */
export function openAppLink(e, rec, url, refused) {
  if (rec.check || refused) return;
  const u = webLink(url);
  if (!u) return;
  const click = clickIn(e, rec.iframe);
  if (click === 'spent') sayOnePerClick(rec.iframe);
  if (click !== 'fresh') return;
  const pane = / Claude\//.test(navigator.userAgent);
  spent.set(rec.iframe, { at: Date.now(), usedUp: !pane });
  // Only the URL rebuilt from the parsed one, never the app’s own string.
  if (!pane) window.open(u.href, '_blank', 'noopener,noreferrer');
  else
    api(`/api/apps/${encodeURIComponent(rec.appId)}/open`, { url: u.href }).catch((err) =>
      toast({ title: 'That link didn’t open', text: err.message, level: 'blocking' }),
    );
}
