// Flexible apps (prototype, designs/prototypes/flexible-apps.md): what an app shares with its agent without a card.
// - publish: the app puts its data where its agent reads it with read_app, and the agent hears at its next turn that
//   it changed (a notice, which never starts a turn).
// - note: a send the browser didn’t see the person click for. It used to wait on a card that made the person “needs
//   you”; now it’s kept on the app and reaches the agent the same way as published data, folded into one notice.
// - read_app: the agent’s tool for both, and the app’s saved state.

import { spawn } from 'node:child_process';
import { conversationOf } from '../shared/room-refs.mjs';
import { httpError } from './helpers.mjs';

/** The most an app may publish, as JSON: the same as its saved state. */
const PUBLISH_BYTES = 256 * 1024;
/** Notes an app keeps for its agent; older ones are dropped, and counted, so the agent knows. */
const NOTES_MAX = 50;

/** The JSON of a value an app gave, or a 413 past the limit. @param {unknown} v @param {string} what */
function sized(v, what) {
  const json = JSON.stringify(v ?? null);
  if (json.length > PUBLISH_BYTES) throw httpError(413, `${what} is limited to 256 KB as JSON.`);
  return JSON.parse(json);
}

/**
 * Tells the app’s agent, at its next turn, that the app has something new for it, unless a notice from this app is
 * already waiting: a burst of changes is one notice. @param {any} rt @param {any} app @param {string} what
 */
function noticeOnce(rt, app, what) {
  const se = rt.s.sessions[app.sessionId];
  if (!se || se.retiredFork) return;
  const tag = `[app ${app.id}]`;
  if (rt.delivery.waiting(se.id).some((e) => e.source === 'notice' && e.text?.startsWith(tag))) return;
  rt.delivery.send(
    {
      sessionId: se.id,
      threadId: app.threadId,
      source: 'notice',
      text: `${tag} ${app.title} ${what} since you last looked. Call read_app with appId “${app.id}” to see it.`,
    },
    { wake: false },
  );
}

/** postbox.publish(data): the app’s data for its agent, replacing what it published before. */
export function publishApp(rt, appId, data) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  if (app.retired) throw httpError(409, `${app.title} was retired, so it can’t publish.`);
  const published = sized(data, 'What an app publishes');
  if (JSON.stringify(published) === JSON.stringify(app.published ?? null)) return { ok: true, unchanged: true };
  rt.store.emit('app', { ...app, published, publishedAt: Date.now() });
  noticeOnce(rt, app, 'has new data from the person');
  return { ok: true };
}

/** A send without the person’s click: kept on the app for its agent, with no line in the person’s voice and no card. */
export function noteApp(rt, appId, action, values) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  if (app.retired) throw httpError(409, `${app.title} was retired, so it can’t send.`);
  const note = { action: String(action ?? '').slice(0, 64), values: sized(values, 'A note'), at: Date.now() };
  const all = [...(app.notes ?? []), note];
  const dropped = (app.dropped ?? 0) + Math.max(0, all.length - NOTES_MAX);
  rt.store.emit('app', { ...app, notes: all.slice(-NOTES_MAX), dropped });
  noticeOnce(rt, app, 'sent notes on its own');
  return { ok: true, noted: true, waiting: Math.min(all.length, NOTES_MAX) };
}

/**
 * read_app { appId }: what an app in the agent’s conversation published, the notes it sent on its own since the agent
 * last read them, and its saved state. Reading takes the notes. @param {any} rt @param {string} sessionId
 * @param {{ appId?: unknown }} [args]
 */
export function readApp(rt, sessionId, { appId } = {}) {
  const se = rt.session(sessionId);
  const id = String(appId ?? '').slice(0, 80);
  const app = rt.s.apps[id];
  if (!app || conversationOf(rt.s.threads, app.threadId) !== conversationOf(rt.s.threads, se.threadId))
    return { ok: false, message: `There’s no app “${id}” in your conversation. Use the appId show_app returned.` };
  const mine = app.sessionId === sessionId;
  const out = {
    appId: id,
    title: app.title,
    version: app.current,
    published: app.published ?? null,
    publishedAt: app.publishedAt ? new Date(app.publishedAt).toISOString() : null,
    notes: app.notes ?? [],
    ...(app.dropped ? { droppedNotes: app.dropped } : {}),
    savedState: app.state ?? null,
  };
  if (mine && (app.notes?.length || app.dropped)) rt.store.emit('app', { ...app, notes: [], dropped: 0 });
  return { ok: true, message: JSON.stringify(out) };
}

/**
 * A web link the person clicked in an app, opened in their default browser. The page asks for this only in the Claude
 * desktop app’s pane, where window.open replaces Postbox’s own page instead of opening a tab (measured). Only http and
 * https, as an argument, never through a shell. @param {any} rt @param {string} appId @param {unknown} url
 */
export function openLink(rt, appId, url) {
  if (!rt.s.apps[appId]) throw httpError(404, 'That app doesn’t exist.');
  let u;
  try {
    u = new URL(String(url));
  } catch {
    throw httpError(400, 'An app’s link needs an absolute http or https URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw httpError(400, 'Postbox opens only http and https links from apps.');
  const cmd = { darwin: ['open', [u.href]], linux: ['xdg-open', [u.href]], win32: ['rundll32', ['url.dll,FileProtocolHandler', u.href]] }[process.platform];
  if (!cmd) throw httpError(501, 'Postbox can’t open links on this system.');
  spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref();
  return { ok: true };
}
