// When browser and server checks are delivered to an agent after its turn.

import { lintMessage } from './checks.mjs';

/** How long a lint turn waits after its agent turn ends for what the browser measures (diagrams, the app check). */
const LINT_SETTLE_MS = 1500;
/** …and at most, while an app of the agent’s is still being checked. */
const LINT_WAIT_MAX_MS = 12000;

export function sendLint(rt, turnId) {
  const entry = rt.lints.get(turnId);
  if (!entry || entry.sent || entry.timer) return;
  const wait = rt.config.lintSettleMs ?? LINT_SETTLE_MS;
  const until = Date.now() + LINT_WAIT_MAX_MS;
  const send = () => {
    entry.timer = null;
    // An app this agent showed is still being checked in the browser: its warnings join this lint turn.
    const checking = Object.values(rt.s.apps).some((app) => app.sessionId === entry.sessionId && app.check.status === 'pending' && !app.retired);
    if (wait > 0 && checking && Date.now() < until) {
      entry.timer = setTimeout(send, wait);
      entry.timer.unref?.();
      return;
    }
    entry.sent = true;
    const session = rt.s.sessions[entry.sessionId];
    if (session && !session.deleting && !session.archived) rt.deliver(entry.sessionId, lintMessage(entry.problems), { threadId: entry.threadId });
  };
  if (wait <= 0) return send();
  entry.timer = setTimeout(send, wait);
  entry.timer.unref?.();
}
