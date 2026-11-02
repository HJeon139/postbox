// When browser and server checks are delivered to an agent after its turn.

import { lintMessage } from './checks.mjs';

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
