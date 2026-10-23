// Apps (#54, #38, #49): what an agent shows, the browser’s pre-display check of it, what an app sends in your voice,
// its saved state and the host data it asks for, and the files an agent names for it. Each is a Runtime method’s body,
// with the instance first; Runtime keeps a one-line method that calls it.

import { realpath, stat } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import { buildEvent } from '../shared/events.mjs';
import { LIMITS, limitText } from '../shared/limits.mjs';
import { httpError } from './helpers.mjs';
import { readCapped } from './read-capped.mjs';

/** App check problems that are warnings: the app is shown, with notes, and the agent is told. */
const APP_WARNINGS = new Set(['marks-too-small', 'text-too-small', 'dashes-too-fine', 'only-error']);
/** A data file of an app’s version, stored by its hash (#54). @typedef {{ name: string, sha256: string, size: number }} AppFile */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** A file an agent named that Postbox can’t use; its message goes back to the agent. */
export class AgentFileError extends Error {}

// ── Apps ───────────────────────────────────────────────────────────────────────────

/** The browser reports its pre-display check. The first failure goes back to the agent to fix. */
export function appCheck(rt, appId, { version, problems = [] }) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  if (version !== app.current) return { ignored: true };
  const clean = (Array.isArray(problems) ? problems : [])
    .slice(0, 20)
    .map((p) => ({ code: String(p?.code).slice(0, 40), message: String(p?.message).slice(0, 300) }));
  if (!clean.length) {
    rt.store.emit('app', { ...app, check: { status: 'passed', attempt: app.check.attempt, problems: [] } });
    return { status: 'passed' };
  }
  if (clean.some((p) => p.code === 'script-error')) {
    rt.store.emit('app', { ...app, check: { status: 'crashed', attempt: app.check.attempt, problems: clean } });
    return { status: 'crashed' };
  }
  // Problems the agent can’t fix (the frame never answered) are shown as a note, not sent back. Warnings (marks or
  // text too small, an app showing only an error) don’t hold the app back: it’s shown with notes, and the agent
  // hears of them through the lint pipeline, unless it’s already fixing the app.
  const fixable = clean.filter((p) => p.code !== 'no-answer');
  const blocking = fixable.filter((p) => !APP_WARNINGS.has(p.code));
  if (app.check.attempt === 0 && blocking.length && rt.s.sessions[app.sessionId]) {
    rt.store.emit('app', { ...app, check: { status: 'fixing', attempt: 1, problems: fixable } });
    rt.deliver(app.sessionId, { kind: 'app-check', appId, problems: fixable }, { threadId: app.threadId });
    return { status: 'fixing' };
  }
  const notes = clean.every((p) => APP_WARNINGS.has(p.code));
  rt.store.emit('app', { ...app, check: { status: 'note', attempt: app.check.attempt, problems: clean, ...(notes ? { notes } : {}) } });
  if (notes) {
    // The version was made by the agent’s turn that’s running, or else the last one that ended.
    const turnId = [...rt.turns.values()].find((t) => t.sessionId === app.sessionId)?.id ?? rt.lastTurn.get(app.sessionId);
    const scope = { kind: 'app', id: appId, title: app.title };
    rt.lint(
      app.sessionId,
      turnId,
      clean.map((p) => ({ ...p, scope })),
    );
  }
  return { status: 'note' };
}

// An app writes lines in your voice, and each one starts an agent turn, so its sends are limited (#38). The
// browser accepts a send only right after a click or key press in that app (app/js/apps.mjs); here, where a
// script calling the API lands too, an app gets APP_SEND_LIMIT sends per APP_SEND_WINDOW_MS. More wait on
// a card for you to allow or not, and nothing is dropped silently: the app is told its send is waiting.
// The browser keeps the same limit (SEND_LIMIT in app/js/apps.mjs), and the agent guide says so.
export const APP_SEND_LIMIT = 5;
export const APP_SEND_WINDOW_MS = 60_000;
/** Sends one card holds; past that, a send is refused with a reason. */
export const APP_HOLD_MAX = 20;

/**
 * An event an app sends in your voice. Within the limit, it goes to the agent; past it (or when the browser
 * asks, with hold), it waits on the app’s card. The card and its events are items, so they survive a restart.
 * @param {any} rt  the Runtime @param {string} appId @param {string} action @param {object} values
 * @param {{ hold?: boolean, now?: number }} [opts]
 */
export function appEvent(rt, appId, action, values, { hold = false, now = Date.now() } = {}) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  const r = buildEvent({ type: 'app', id: appId, title: app.title }, action, values);
  if (!r.ok) throw httpError(422, r.error);
  const items = rt.store.items(app.threadId);
  const card = items.find((x) => x.kind === 'appsend' && x.appId === appId && x.status === 'open');
  // Sends you allowed on a card don’t count against the next minute.
  const recent = items.filter((x) => x.kind === 'voice' && x.appId === appId && !x.approved && now - (x.sentAt ?? x.at) < APP_SEND_WINDOW_MS).length;
  // Once some sends wait, later ones wait behind them, so the agent gets them in order.
  if (card || hold || recent >= APP_SEND_LIMIT) {
    const held = { action: r.event.action, values: r.event.values, voice: r.voice, sent: r.event.sent, ...(r.quote ? { quote: r.quote } : {}) };
    const waiting = (card?.events.length ?? 0) + 1;
    if (card) {
      if (card.events.length >= APP_HOLD_MAX)
        throw httpError(429, `${card.events.length} messages from ${app.title} are already waiting for the person to allow them. Wait for their answer.`);
      rt.patchItem(app.threadId, card.id, { events: [...card.events, held] });
    }
    const cardId =
      card?.id ?? rt.addItem(app.threadId, { kind: 'appsend', appId, title: app.title, sessionId: app.sessionId, events: [held], status: 'open' }).id;
    rt.needAppSend(app, cardId, waiting);
    return {
      ok: true,
      held: true,
      waiting,
      message: `Held for the person to allow: an app sends up to ${APP_SEND_LIMIT} messages a minute. ${waiting === 1 ? '1 message is' : `${waiting} messages are`} waiting.`,
    };
  }
  rt.addItem(app.threadId, { kind: 'voice', text: r.voice, ...(r.quote ? { quote: r.quote } : {}), appId, sentAt: now });
  if (rt.s.sessions[app.sessionId]) rt.deliver(app.sessionId, { kind: 'event', event: r.event }, { threadId: app.threadId });
  return { ok: true, voice: r.voice };
}

/** An open app card makes its agent need you and tells you, like a permission card, unless it already needs you. */
export function needAppSend(rt, app, itemId, waiting) {
  const se = rt.s.sessions[app.sessionId];
  if (!se || (se.needs && se.needs.itemId !== itemId)) return;
  const text = `${app.title} wants to send ${waiting === 1 ? '1 message' : `${waiting} messages`} for you`;
  rt.updateSession(se.id, { needs: { kind: 'appsend', itemId, text }, state: rt.turns.has(se.id) ? se.state : 'needs' });
  if (waiting === 1) rt.notify('blocking', se, text, `Apps send up to ${APP_SEND_LIMIT} a minute in your voice. Allow these, or don’t.`);
}

/** Your answer on an app’s card: allow sends the waiting events as they were sent; don’t allow drops them. */
export function resolveAppSend(rt, threadId, itemId, action, { now = Date.now() } = {}) {
  const it = rt.store.item(threadId, itemId);
  if (it?.kind !== 'appsend' || it.status !== 'open') throw httpError(409, 'That request was already answered.');
  if (action !== 'allow' && action !== 'deny') throw httpError(400, 'An app’s request takes “allow” or “deny”.');
  const allow = action === 'allow';
  rt.patchItem(threadId, itemId, { status: allow ? 'allowed' : 'declined', answeredAt: now });
  const owner = rt.s.sessions[it.sessionId];
  if (owner?.needs?.itemId === itemId) rt.updateSession(owner.id, { needs: null, state: rt.turns.has(owner.id) ? owner.state : 'idle' });
  if (!allow) {
    const n = it.events.length;
    rt.addItem(threadId, { kind: 'voice', text: `Didn’t allow ${it.title} to send ${n === 1 ? '1 message' : `${n} messages`}` });
    return { ok: true };
  }
  const se = rt.s.sessions[it.sessionId];
  for (const ev of it.events) {
    rt.addItem(threadId, { kind: 'voice', text: ev.voice, ...(ev.quote ? { quote: ev.quote } : {}), appId: it.appId, sentAt: now, approved: true });
    const event = {
      blockId: it.appId,
      action: ev.action,
      values: ev.values,
      ...(ev.sent ? { sent: ev.sent } : {}),
      ...(ev.quote ? { appSummary: ev.quote } : {}),
    };
    if (se && !se.archived) rt.deliver(se.id, { kind: 'event', event }, { threadId });
  }
  return { ok: true };
}

export function appState(rt, appId, state) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  const json = JSON.stringify(state ?? null);
  if (json.length > 256 * 1024) throw httpError(413, 'Saved app state is limited to 256 KB.');
  // An app that saves the same state again (on every load, say) changes nothing.
  if (json === JSON.stringify(app.state ?? null)) return;
  rt.store.emit('app', { ...app, state: JSON.parse(json) });
}

/** An app asks the host for data. It can use only tools both it and its agent were granted. */
export function appQuery(rt, appId, tool, args) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  const se = rt.s.sessions[app.sessionId];
  const persona = se && rt.personaFor(se);
  const allowed = new Set((app.versions[app.current - 1].permissions ?? []).filter((t) => persona?.tools?.includes(t)));
  if (!allowed.has(tool)) throw httpError(403, `This app can’t use “${tool}”. It needs the permission, and its agent needs the tool.`);
  return hostTool(rt, tool, args);
}

/**
 * A data file of an app’s version (#54), as the app reads it with postbox.file(name).
 * @param {any} rt  the Runtime @param {string} appId @param {string} name @param {number} [v]  the version; the current one by default
 */
export async function appFile(rt, appId, name, v) {
  const app = rt.s.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  const ver = app.versions[(Number(v) || app.current) - 1];
  const f = ver?.files?.find((x) => x.name === name);
  if (!f || !rt.blobs) throw httpError(404, `This version of ${app.title} has no file “${name}”.`);
  return rt.blobs.get(f.sha256);
}

// ── Files an agent names (#54) ─────────────────────────────────────────────────────

/** The folders an agent works in: its own (where it starts), the project’s, and any added for the conversation. */
export async function agentFolders(rt, sessionId) {
  const se = rt.session(sessionId);
  const persona = rt.personaFor(se);
  const project = rt.s.projects[rt.s.threads[se.threadId]?.projectId] ?? null;
  const adapter = rt.adapters.get(persona?.backend);
  const own = adapter?.folderFor ? await adapter.folderFor(persona, project) : persona?.folder || project?.folder || null;
  return [...new Set([own, project?.folder, ...(se.addDirs ?? [])].filter(Boolean))];
}

/**
 * Reads a file an agent named for an app: a path in one of its folders (relative to its own), followed through
 * links, so a link can’t reach outside them. Larger than max bytes is refused before it’s read.
 * @param {any} rt  the Runtime @param {string} sessionId @param {unknown} path @param {number} max @param {string} what  how the error names it
 */
export async function agentFile(rt, sessionId, path, max, what) {
  if (typeof path !== 'string' || !path.trim()) throw new AgentFileError(`${what} needs a path to a file in your folder.`);
  const folders = await rt.agentFolders(sessionId);
  if (!folders.length) throw new AgentFileError(`You have no folder to read ${what} from. Send it inline instead.`);
  const real = await realpath(resolve(folders[0], path)).catch(() => null);
  if (!real) throw new AgentFileError(`There’s no file at ${path} (${what}).`);
  const roots = await Promise.all(folders.map((f) => realpath(f).catch(() => null)));
  if (!roots.some((r) => r && (real === r || real.startsWith(r + sep))))
    throw new AgentFileError(`${path} is outside your folders, so Postbox didn’t read it (${what}).`);
  const st = await stat(real);
  if (!st.isFile()) throw new AgentFileError(`${path} isn’t a file (${what}).`);
  const over = () => new AgentFileError(`${path} is over the limit for ${what}.`);
  if (st.size > max) throw over();
  const buf = await readCapped(real, max);
  if (!buf) throw over();
  return buf;
}

/**
 * show_app and update_app as an agent calls them over MCP (#54): code may come from codePath, a file in its folder,
 * and files names data files there for the app to read. Postbox reads both itself, under the same limits as an
 * inline call, and stores the data files with the version. Returns the call’s arguments with code filled in, and
 * the files as Postbox stored them; a call can’t name stored files itself.
 * @param {any} rt  the Runtime @param {string} sessionId @param {any} args
 * @returns {Promise<{ args: any, files?: AppFile[] }>}
 */
export async function appFiles(rt, sessionId, args) {
  const { codePath, files: wanted, ...rest } = args ?? {};
  const out = { ...rest };
  if (codePath !== undefined) {
    if (typeof rest.code === 'string' && rest.code) throw new AgentFileError('Send code or codePath, not both.');
    // A character is at most 4 bytes, so a file within the limit in characters is within 4 times it in bytes.
    out.code = (await rt.agentFile(sessionId, codePath, LIMITS.appCode * 4, 'codePath')).toString('utf8');
    if (out.code.length > LIMITS.appCode)
      throw new AgentFileError(`${codePath} has ${out.code.length.toLocaleString('en-US')} characters; an app’s code is up to ${limitText('appCode')}.`);
  }
  if (wanted === undefined) return { args: out };
  if (!Array.isArray(wanted)) throw new AgentFileError('files is a list: [{ name?, path }].');
  if (wanted.length > LIMITS.appFiles) throw new AgentFileError(`An app carries up to ${limitText('appFiles')} data files.`);
  if (!rt.blobs) throw new AgentFileError('This Postbox can’t store files.');
  /** @type {AppFile[]} */
  const stored = [];
  for (const f of wanted) {
    const path = typeof f === 'string' ? f : f?.path;
    const name = String((typeof f === 'object' && f?.name) || basename(String(path ?? '')));
    if (!FILE_NAME.test(name)) throw new AgentFileError(`“${name}” can’t name a file: use letters, digits and - _ . (up to 64).`);
    if (stored.some((x) => x.name === name)) throw new AgentFileError(`Two files are named “${name}”.`);
    const buf = await rt.agentFile(sessionId, path, LIMITS.appFileBytes, `the file “${name}” (up to ${limitText('appFileBytes')})`);
    const { sha256, size } = await rt.blobs.put(buf);
    stored.push({ name, sha256, size });
  }
  return { args: out, files: stored };
}

/** @param {any} rt  the Runtime @param {string} sessionId @param {any} block @param {string} itemId @param {string} [threadId] @param {AppFile[]} [files] */
export function registerApp(rt, sessionId, block, itemId, threadId = rt.s.sessions[sessionId]?.threadId, files = []) {
  rt.store.emit('app', {
    id: block.id,
    threadId,
    sessionId,
    itemId,
    title: block.title ?? 'App',
    versions: [{ v: 1, code: block.code, permissions: block.permissions ?? [], files, at: Date.now(), summary: '' }],
    current: 1,
    state: null,
    check: { status: 'pending', attempt: 0, problems: [] },
  });
}

/** Host tools that apps (through the bridge) and agents can use, if granted. */
export function hostTool(rt, tool, args = {}) {
  switch (tool) {
    case 'corpus.search': {
      const q = String(args.query ?? '').slice(0, 200);
      const mode = ['both', 'lexical', 'semantic'].includes(args.mode) ? args.mode : 'both';
      return rt.corpus.search(q, { mode, k: Math.min(50, +args.k || 12), books: Array.isArray(args.books) ? args.books : undefined });
    }
    case 'corpus.read':
      return rt.corpus.read(String(args.id ?? ''));
    case 'corpus.stats':
      return rt.corpus.stats();
    case 'narrate.speak':
      if (!rt.narrator) throw httpError(503, 'Narration isn’t installed here. Run npm install to add Kokoro, then restart Postbox.');
      return rt.narrator.speak(args);
    default:
      throw httpError(404, `There’s no host tool called “${tool}”.`);
  }
}
