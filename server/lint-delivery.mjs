// When browser and server checks are delivered to an agent after its turn: the lint entry each agent turn gets, the
// problems that join it until its lint turn goes, the problems a new turn takes in instead, and the one line a lint
// turn that wrote nothing leaves. The lint entries and their timers live on the runtime (rt.lints). lintEntry,
// endLint, lint, foldLint and quietLint moved here out of server/runtime.mjs, which keeps a method of each name that
// delegates here.

import { formatLint, lintMessage } from './checks.mjs';

/** How long a lint turn waits after its agent turn ends for what the browser measures. */
const LINT_SETTLE_MS = 1500;
/** …and at most, while an app of the agent’s is still being checked. */
const LINT_WAIT_MAX_MS = 12_000;

export function sendLint(rt, turnId) {
  const entry = rt.lints.get(turnId);
  if (!entry || entry.sent || entry.timer) return;
  const wait = rt.config.lintSettleMs ?? LINT_SETTLE_MS;
  const now = rt.config.now ?? Date.now;
  const setTimer = rt.config.setTimer ?? setTimeout;
  const until = now() + (rt.config.lintWaitMaxMs ?? LINT_WAIT_MAX_MS);
  const send = () => {
    entry.timer = null;
    const pending = Object.values(rt.store.pending.apps()).filter((app) => app.sessionId === entry.sessionId && app.check.status === 'pending' && !app.retired);
    // An app this agent showed is still being checked in the browser: its warnings join this lint turn.
    if (wait > 0 && pending.length && now() < until) {
      entry.timer = setTimer(send, wait);
      entry.timer.unref?.();
      return;
    }
    if (wait > 0)
      for (const app of pending)
        entry.problems.push({
          code: 'app-unchecked',
          message: `No Postbox page was open to check ${app.title} v${app.current}. It will be checked when one opens.`,
          scope: { kind: 'app', id: app.id, title: app.title },
        });
    entry.sent = true;
    const session = rt.s.sessions[entry.sessionId];
    if (session && !session.deleting && !session.archived) rt.deliver(entry.sessionId, lintMessage(entry.problems), { threadId: entry.threadId });
  };
  if (wait <= 0) return send();
  entry.timer = setTimer(send, wait);
  entry.timer.unref?.();
}

function lintEntry(rt, sessionId, turnId) {
  let e = rt.lints.get(turnId);
  if (!e) {
    e = { sessionId, kind: null, ended: false, sent: false, problems: [], timer: null, threadId: null };
    rt.lints.set(turnId, e);
    // Only recent turns can still get a lint turn.
    for (const [k, old] of rt.lints) {
      if (rt.lints.size <= 200) break;
      clearTimeout(old.timer);
      rt.lints.delete(k);
    }
  }
  return e;
}

/** The turn ended: its lint turn goes once the browser has had a moment to report. */
export function endLint(rt, turn, problems) {
  const e = lintEntry(rt, turn.sessionId, turn.id);
  e.kind = turn.kind;
  // The lint turn answers where the reply was.
  e.threadId = turn.threadId;
  e.ended = true;
  e.problems.push(...problems);
  if (e.problems.length) sendLint(rt, turn.id);
}

/**
 * Adds problems to the lint turn of the agent turn they came from. Returns whether the agent will hear of them:
 * not when they came from a lint turn, or when that turn’s lint turn has already gone.
 * @param {string} sessionId  @param {string|null|undefined} turnId  @param {import('./checks.mjs').Problem[]} problems
 */
export function lint(rt, sessionId, turnId, problems) {
  if (!problems.length || !turnId || !rt.s.sessions[sessionId]) return false;
  const live = [...rt.turns.values()].find((t) => t.id === turnId);
  // A turn that isn’t running and has no entry failed, was stopped, ran before a restart or is long gone: its
  // problems are dropped, so no lint turn lands about an old reply. A lint turn’s own problems are too.
  if ((!live && !rt.lints.has(turnId)) || live?.kind === 'lint') return false;
  const e = lintEntry(rt, sessionId, turnId);
  if (e.kind === 'lint' || e.sent) return false;
  e.problems.push(...problems);
  if (e.ended) sendLint(rt, turnId);
  return true;
}

/**
 * Another turn starts before a lint turn went (the person wrote during the settle, say): the problems join that
 * turn, so a lint turn never lands after it, and later reports for the earlier turns are dropped.
 */
export function foldLint(rt, sessionId, message) {
  const problems = [];
  for (const e of rt.lints.values()) {
    if (e.sessionId !== sessionId || !e.ended || e.sent) continue;
    clearTimeout(e.timer);
    e.timer = null;
    e.sent = true;
    problems.push(...e.problems);
  }
  // Its own place in the turn (formatMessage, server/adapters/guide.mjs): after the request, before the background.
  return problems.length ? { ...message, lint: formatLint(lintMessage(problems), { folded: true }) } : message;
}

/** A lint turn that wrote nothing shows as one line, such as “@researcher defined “Step 2””. */
export function quietLint(rt, turn, se) {
  // What the browser reports later about this lint turn’s own work is never linted.
  Object.assign(lintEntry(rt, se.id, turn.id), { kind: 'lint', ended: true, sent: true });
  if (turn.said.trim() || turn.first) return;
  const defined = [...new Set(turn.defined ?? [])].map((t) => `“${t}”`);
  const list = defined.length > 1 ? `${defined.slice(0, -1).join(', ')} and ${defined.at(-1)}` : (defined[0] ?? '');
  const text = defined.length ? `@${se.handle} defined ${list}` : turn.steps.length ? `@${se.handle} acted on Postbox’s check without a reply` : null;
  if (text) rt.addItem(turn.threadId, { kind: 'system', variant: 'lint', handle: se.handle, turnId: turn.id, text, lintReply: true });
}
