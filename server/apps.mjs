// Apps (#54, #38, #49): what an agent shows, the browser’s pre-display check of it, what an app sends in your voice,
// and its saved state and the host data it asks for; the files an agent names for it are in server/agent-files.mjs.
// What an app sends without a click is a note (server/app-notes.mjs).
// Apps (server/app-service.mjs) calls each with itself.

import { followsConversation, validateBlock } from '../shared/catalog.mjs';
import { buildEvent } from '../shared/events.mjs';
import { cutText } from '../shared/text-parts.mjs';
import { appReceipt } from './app-check-status.mjs';
import { awaited, settleUnchecked, settleWaits } from './app-check-wait.mjs';
import { intentOf, withIntentNote } from './app-intent.mjs';
import { notYours } from './app-retire.mjs';
import { httpError, refuseRetired } from './helpers.mjs';
import { HELD_BY_EVERY_AGENT, hostTool } from './host-tool.mjs';
import { newId } from './store.mjs';

/** @typedef {import('./agent-files.mjs').AppFile} AppFile */

/**
 * App check problems that are warnings: the app is shown, with notes, and the agent is told. Text under 12 px holds a
 * version back at 1000 × 680, as the critique’s floor does (#997): agents shipped the labels this flagged when it was a
 * warning. At 375 px it stays a warning: an SVG scaled to fit a narrow pane draws its labels small.
 */
const APP_WARNINGS = new Set(['marks-too-small', 'text-too-small-375', 'dashes-too-fine', 'only-error', 'text-over-marks']);
/**
 * Of the warnings, those only the agent hears: alone, they leave the version passed, with no note for the person. Labels
 * on a chart’s marks (#952) are one: in a sample of real apps, half of what it flagged was a legible touch, which isn’t
 * worth the person’s attention, and the person chose that the agent alone hears it.
 */
const APP_HINTS = new Set(['text-over-marks']);

// ── Apps ───────────────────────────────────────────────────────────────────────────

/**
 * The browser reports its pre-display check. The first failure goes back to the agent to fix, in the reply of the
 * show_app or update_app that’s waiting for it (#337, app-check-wait.mjs), or else as a message.
 */
export function appCheck(apps, appId, report) {
  const r = checked(apps, appId, report);
  if (!r.ignored) settleWaits(apps, appId, report.version, apps.store.pending.apps()[appId]?.check);
  return r;
}

/**
 * A version that passed, or whose only findings are hints for the agent alone: those go to it through the lint pipeline
 * of the turn that made the version, and stay on the check for it to read; the person sees the version as passed.
 * @param {any} apps @param {any} app  the app as checked() read it @param {number} version @param {any[]} hints
 */
function passed(apps, app, version, hints) {
  if (hints.length) {
    const turnId = apps.running.turnOf(app.sessionId)?.id ?? apps.store.state.sessions[app.sessionId]?.lastTurnId;
    const scope = { kind: 'app', id: app.id, title: app.title };
    apps.checks.lint(
      app.sessionId,
      turnId,
      hints.map((p) => ({ ...p, scope })),
    );
  }
  const check = { status: 'passed', attempt: app.check.attempt, problems: [], ...(hints.length ? { hints } : {}) };
  apps.store.emit('app', { ...app, lastShown: version, check });
  return { status: 'passed' };
}

/** The check’s result, recorded. @param {any} apps @param {string} appId @param {{ version: number, problems?: any[] }} report */
function checked(apps, appId, { version, problems = [] }) {
  const app = apps.store.state.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  // A retired app shows no frame, so a check still running when it was retired has nothing to fix (#193).
  if (version !== app.current || app.retired || app.check.status !== 'pending') return { ignored: true };
  const clean = (Array.isArray(problems) ? problems : [])
    .slice(0, 20)
    .map((p) => ({ code: String(p?.code).slice(0, 40), message: cutText(String(p?.message), 300) }));
  // Passed, or with only hints for the agent: the version the person is shown, which stands in while its agent fixes a
  // later one (#948).
  if (clean.every((p) => APP_HINTS.has(p.code))) return passed(apps, app, version, clean);
  // A script error goes back to the agent once, like any blocking problem (#964); after that, or with no agent to
  // tell, the version shows as crashed.
  if (clean.some((p) => p.code === 'script-error') && (app.check.attempt > 0 || !apps.store.state.sessions[app.sessionId])) {
    apps.store.emit('app', { ...app, check: { status: 'crashed', attempt: app.check.attempt, problems: clean } });
    return { status: 'crashed' };
  }
  // Problems the agent can’t fix (the frame never answered, or a check of Postbox’s threw) are shown as a note, not
  // sent back. Warnings (marks or dashes too small, an app showing only an error) don’t hold the app back: it’s shown
  // with notes. What the agent can fix and isn’t fixing now, warnings or what a fix left, reaches it through the lint
  // pipeline: the person’s note is plain, so the agent is the only one with the detail (#948, #981).
  const fixable = clean.filter((p) => p.code !== 'no-answer' && p.code !== 'check-error');
  const blocking = fixable.filter((p) => !APP_WARNINGS.has(p.code));
  const liveTurn = apps.running.turnOf(app.sessionId);
  const heard = !!liveTurn && !liveTurn.abort?.signal?.aborted && awaited(apps, appId, version, liveTurn);
  if (app.check.attempt === 0 && blocking.length && apps.store.state.sessions[app.sessionId]) {
    // heard: a reply waiting for this check on a live turn carries the problems, so no app-check turn comes; the turn
    // that made the version ends the fix instead (fixOver).
    apps.store.emit('app', { ...app, check: { status: 'fixing', attempt: 1, problems: fixable, ...(heard ? { heard } : {}) } });
    if (!heard) apps.send(app.sessionId, { kind: 'app-check', appId, problems: fixable }, { threadId: app.threadId });
    return { status: 'fixing' };
  }
  const notes = clean.every((p) => APP_WARNINGS.has(p.code));
  // The version was made by the agent’s turn that’s running, or else the last one that ended.
  const turnId = liveTurn?.id ?? apps.store.state.sessions[app.sessionId]?.lastTurnId;
  const scope = { kind: 'app', id: appId, title: app.title };
  // Whether the agent will hear of them, so the person’s note says so only when it’s true.
  // A reply waiting for this check carries them, so the lint turn doesn’t repeat them.
  const told =
    fixable.length > 0 &&
    (heard ||
      !!apps.checks.lint(
        app.sessionId,
        turnId,
        fixable.map((p) => ({ ...p, scope })),
      ));
  const check = { status: 'note', attempt: app.check.attempt, problems: clean, ...(notes ? { notes } : {}), ...(told ? { told } : {}) };
  // Only a version Postbox checked to the end can stand in later: one its check couldn’t finish is shown with its note,
  // and the last checked version stays the fallback (#948).
  const checked = fixable.length === clean.length;
  apps.store.emit('app', { ...app, ...(checked ? { lastShown: version } : {}), check });
  return { status: 'note' };
}

/** The status of an app whose agent’s app-check turn ended without a new version: crashed if its script threw (#964). */
export const fixEnded = (app) => (app.check.problems?.some((p) => p.code === 'script-error') ? 'crashed' : 'note');

/**
 * No app-check turn will fix the agent’s apps now: each still fixing shows with its note, or crashed (#1664). With
 * heardOnly, only those whose problems a show_app or update_app reply carried (#337).
 * @param {{ store: any }} rt @param {string} sessionId @param {{ heardOnly?: boolean }} [o]
 */
export function endFixes(rt, sessionId, { heardOnly = false } = {}) {
  for (const app of Object.values(rt.store.pending.apps()))
    if (app.sessionId === sessionId && app.check.status === 'fixing' && (!heardOnly || app.check.heard))
      rt.store.emit('app', { ...app, check: { ...app.check, status: fixEnded(app) } });
}

/**
 * An event an app sends in your voice, which starts its agent’s turn. The browser sends one only for the person’s click
 * or key press in the app, one a click (app/js/app-send.mjs), so there’s no limit to count here and no card to wait
 * on: what an app sends without a click is a note (server/app-notes.mjs, #1488).
 * @param {import('./app-service.mjs').Apps} apps @param {string} appId @param {string} action @param {object} values
 * @param {{ now?: number }} [opts]
 */
export function appEvent(apps, appId, action, values, { now = Date.now() } = {}) {
  const app = apps.store.state.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  if (app.retired) throw httpError(409, `${app.title} was retired, so it can’t send messages.`);
  const r = buildEvent({ type: 'app', id: appId, title: app.title }, action, values);
  if (!r.ok) throw httpError(422, r.error);
  refuseRetired(apps.store.state.sessions[app.sessionId]);
  const voice = apps.threads.addItem(app.threadId, { kind: 'voice', text: r.voice, ...(r.quote ? { quote: r.quote } : {}), appId, sentAt: now });
  if (apps.store.state.sessions[app.sessionId]) apps.send(app.sessionId, { kind: 'event', event: r.event }, { threadId: app.threadId, itemId: voice.id });
  return { ok: true, voice: r.voice };
}

export function appState(apps, appId, state) {
  const app = apps.store.state.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  const json = JSON.stringify(state ?? null);
  if (json.length > 256 * 1024) throw httpError(413, 'Saved app state is limited to 256 KB.');
  // An app that saves the same state again (on every load, say) changes nothing.
  if (json === JSON.stringify(app.state ?? null)) return;
  apps.store.emit('app', { ...app, state: JSON.parse(json) });
}

/**
 * An app asks the host for data. It can use only tools both it and its agent were granted; every agent holds its
 * conversation’s assets (HELD_BY_EVERY_AGENT), so an app reads them by naming them in its permissions.
 */
export function appQuery(apps, appId, tool, args) {
  const app = apps.store.state.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  const se = apps.store.state.sessions[app.sessionId];
  const persona = se && apps.personas.forSession(se);
  const held = (/** @type {string} */ t) => HELD_BY_EVERY_AGENT.has(t) || persona?.tools?.includes(t);
  const allowed = new Set((app.versions[app.current - 1].permissions ?? []).filter(held));
  if (!allowed.has(tool)) throw httpError(403, `This app can’t use “${tool}”. It needs the permission, and its agent needs the tool.`);
  return hostTool(apps, tool, args, { threadId: app.threadId, app });
}

/**
 * A data file of an app’s version (#54), as the app reads it with postbox.file(name).
 * @param {import('./app-service.mjs').Apps} apps @param {string} appId @param {string} name @param {number} [v]  the version; the current one by default
 */
export async function appFile(apps, appId, name, v) {
  const app = apps.store.state.apps[appId];
  if (!app) throw httpError(404, 'That app doesn’t exist.');
  const ver = app.versions[(Number(v) || app.current) - 1];
  const f = ver?.files?.find((x) => x.name === name);
  const blobs = apps.assets.blobs;
  if (!f || !blobs) throw httpError(404, `This version of ${app.title} has no file “${name}”.`);
  return blobs.get(f.sha256);
}

/** @param {import('./app-service.mjs').Apps} apps @param {string} sessionId @param {any} block @param {string} itemId @param {string} [threadId] @param {AppFile[]} [files] */
export function registerApp(apps, sessionId, block, itemId, threadId = apps.store.state.sessions[sessionId]?.threadId, files = []) {
  apps.store.emit('app', {
    id: block.id,
    threadId,
    sessionId,
    itemId,
    title: block.title ?? 'App',
    versions: [{ v: 1, code: block.code, permissions: block.permissions ?? [], files, at: Date.now(), summary: '', intent: intentOf(block.intent) }],
    current: 1,
    state: null,
    check: { status: 'pending', attempt: 0, problems: [] },
  });
}

/** The app an item shows, when it's the app's own item, not a stub left where it was. @param {any} apps @param {any} it */
export function appOf(apps, it) {
  const app = it?.kind === 'block' && it.valid && it.block?.type === 'app' ? apps.store.state.apps[it.block.id] : null;
  return app?.itemId === it.id ? app : null;
}

/**
 * show_app: an app is a block of type app (showBlock, server/block-show.mjs), and an id the session already holds is a
 * new version (updateApp). @param {import('./app-service.mjs').Apps} apps @param {string} sessionId
 * @param {any} tools  the turn's tools as toolsFor made them
 * @param {{ id?: string, title?: string, code: string, permissions?: string[], fallback?: string, intent?: string }} args
 * @param {{ files?: AppFile[] }} [given]  data files Postbox read from the agent’s folders (#54); never from the call
 */
export function showApp(apps, sessionId, tools, { id, title, code, permissions, fallback, intent }, given = {}) {
  const blockId = id ?? newId('app');
  const existing = apps.store.pending.app(blockId);
  // A new version keeps the permissions the call leaves out, as update_app does (#1751).
  if (existing?.sessionId === sessionId) return tools.update_app({ id: blockId, code, permissions, title, intent }, given);
  return tools.show_block(
    {
      block: {
        id: blockId,
        type: 'app',
        version: 1,
        title: title ?? 'App',
        fallback: fallback ?? `${title ?? 'An app'}: open Postbox to use it.`,
        code,
        permissions: permissions ?? [],
        // As the agent said it: show_block trims it, cuts it and flags a long one, for every way an app is shown.
        ...(intent !== undefined && { intent }),
      },
    },
    given,
  );
}

/**
 * @param {import('./app-service.mjs').Apps} apps @param {string} sessionId @param {any} turn  the turn the tools act for, or null
 * @param {() => string} threadId  where the turn speaks @param {() => void} endSegment  ends the reply so far
 * @param {{ id: string, code?: string, permissions?: string[], title?: string, summary?: string, intent?: string }} args
 *   without code, the current version’s, when files are given (#1751)
 * @param {{ files?: AppFile[], held?: boolean }} [given]  as for show_app; held is set once a version holds the files (#1702); a version without them keeps the last one’s, as one without an intent does
 */
export function updateApp(apps, sessionId, turn, threadId, endSegment, { id, code, permissions, title, summary = '', intent }, given = {}) {
  const app = apps.store.pending.app(id);
  if (!app || app.sessionId !== sessionId) return notYours(apps, sessionId, id);
  // New data files alone keep the current code (#1751): a live panel refreshes its data without resending the app.
  if (code == null && !given.files) return { ok: false, message: 'Send code, codePath or files: an update with none of them has nothing to change.' };
  code ??= app.versions[app.current - 1].code;
  const v = validateBlock({ id, type: 'app', version: 1, fallback: 'x', code, permissions: permissions ?? app.versions[app.current - 1].permissions });
  if (!v.ok) return { ok: false, message: `The update was invalid: ${v.errors.join(' ')}` };
  const versions = [
    ...app.versions,
    {
      v: app.versions.length + 1,
      code,
      permissions: v.block.permissions ?? [],
      files: given.files ?? app.versions[app.current - 1].files ?? [],
      summary: cutText(String(summary ?? ''), 300),
      intent: intentOf(intent) || (app.versions[app.current - 1].intent ?? ''),
      at: Date.now(),
    },
  ];
  // A new version brings a retired app back (#193).
  const { retired: _, ...live } = app;
  const next = {
    ...live,
    title: typeof title === 'string' && title.trim() ? cutText(title, 200) : app.title,
    versions,
    current: versions.length,
    check: { status: 'pending', attempt: app.check.attempt },
  };
  apps.store.emit('app', next);
  // The version holds the call’s data files, so keptIfShown keeps their blobs (#1702).
  if (given.files) given.held = true;
  // A reply still waiting for an earlier version’s check won’t get one now (#337).
  settleUnchecked(apps, id, next.current);
  // A new version always comes to the newest point, where the agent says what changed (#49).
  let moved = false;
  if (followsConversation({ type: 'app' })) {
    if (app.threadId === threadId()) endSegment();
    moved = apps.threads.bringForward(app.threadId, app.itemId, { what: 'app', title: next.title, v: versions.length }, turn ? { turnId: turn.id } : {});
  }
  return withIntentNote(appReceipt(next, `App ${id} is now v${versions.length}${moved ? ', shown at the newest point in the conversation' : ''}.`), intent);
}
