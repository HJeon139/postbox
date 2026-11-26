// Background work after an Agent SDK turn’s reply (#1714). In a single-turn query the SDK waits after the last
// `result` while background subagents and commands run on, but only up to CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS
// (10 min by default); then it ends the run and that work is stopped. Recorded on 26 November 2026 with the SDK
// 0.3.306 and claude 2.1.306 (tests/fixtures/agent-sdk/background-limit.jsonl): with the limit at 30 s, a background
// `sleep 90` got a task_notification `stopped` 5 s after the reply’s result, and the query ended. The CLI on its own
// waited the full 90 s with the same setting, so the limit is the SDK’s. Postbox gives it the bound a host turn waiting
// on background work already has (QUIET.backgroundMax, #847), and tells the agent what the limit still stopped.

import { QUIET } from '../../shared/limits.mjs';
import { cutText } from '../../shared/text-parts.mjs';

/** The query’s environment: Postbox’s own, with the SDK’s wait for background work set to Postbox’s bound. */
export const backgroundWaitEnv = () => ({ ...process.env, CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(QUIET.backgroundMax) });

/**
 * Watches a turn’s messages for background work stopped after its reply: a task_notification `stopped` that follows a
 * `result` with no message of the agent’s own between. One the agent stopped itself comes mid-turn, before a result.
 */
export function stoppedAfterReply() {
  let replied = false;
  /** @type {string[]} */
  const stopped = [];
  return {
    /** @param {any} m */
    push(m) {
      if (m?.type === 'result') replied = true;
      // The agent at work again: its own message, not one a subagent forwards (parent_tool_use_id) while it runs on.
      else if (m?.type === 'assistant' && !m.parent_tool_use_id) replied = false;
      else if (replied && m?.type === 'system' && m.subtype === 'task_notification' && m.status === 'stopped') {
        // One line, cut at a whole character: a summary is the agent’s own words and can run to paragraphs.
        const summary = String(m.summary ?? '')
          .replace(/\s+/g, ' ')
          .trim();
        stopped.push(cutText(summary || String(m.task_id || 'background work'), 120));
      }
    },
    /** What the agent hears at its next turn, or null when nothing was stopped. */
    told() {
      if (!stopped.length) return null;
      const hours = QUIET.backgroundMax / 3_600_000;
      return `Background work you started was stopped after your reply, before it finished: ${stopped.map((s) => `“${s}”`).join(', ')}. Postbox waits up to ${hours} h for background work after a reply. If you still need it, run it again, in the foreground or in smaller parts.`;
    },
  };
}
