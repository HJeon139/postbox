// When browser and server checks are delivered to an agent after its turn.

import { lintMessage } from './checks.mjs';

/** How long a lint turn waits after its agent turn ends for what the browser measures (diagrams, the app check). */
const LINT_SETTLE_MS = 1500;
/** …and at most, while an app of the agent’s is still being checked. */
const LINT_WAIT_MAX_MS = 12000;

export function sendLint(rt, turnId) {
  const e = rt.lints.get(turnId);
  if (!e || e.sent || e.timer) return;
  const wait = rt.config.lintSettleMs ?? LINT_SETTLE_MS;
  const until = Date.now() + LINT_WAIT_MAX_MS;
  const send = () => {
    e.timer = null;
    // An app this agent showed is still being checked in the browser: its warnings join this lint turn.
    const checking = Object.values(rt.s.apps).some((a) => a.sessionId === e.sessionId && a.check.status === 'pending' && !a.retired);
    if (wait > 0 && checking && Date.now() < until) {
      e.timer = setTimeout(send, wait);
      e.timer.unref?.();
      return;
    }
    e.sent = true;
    const se = rt.s.sessions[e.sessionId];
    if (se && !se.deleting && !se.archived) rt.deliver(e.sessionId, lintMessage(e.problems), { threadId: e.threadId });
  };
  if (wait <= 0) return send();
  e.timer = setTimeout(send, wait);
  e.timer.unref?.();
}
