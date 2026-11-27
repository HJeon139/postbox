// How a Kiro tool call ended, from its ACP update: what it returned, or why it failed.

import { clip } from '../harness-tools.mjs';

const contentText = (content) =>
  (Array.isArray(content) ? content : [])
    .map((c) => (c?.type === 'content' ? c.content : c))
    .filter((c) => c?.type === 'text')
    .map((c) => c.text)
    .join(' ');
// How v3 refuses a call it would ask about (recorded): a pending_interaction (tool_approval) for the call, then
// lint-allow spelling: “cancelled” is Kiro’s value, as it sends it.
// interaction_resolved with outcome “cancelled”, then the call fails with “The user rejected this tool call.” The
// turn itself still succeeds, so the stream is the only record. The text is the fallback, and v2’s wording. The
// UAT’s checks read recorded streams with it too (tools/uat/checks.mjs).
export const REFUSED = /The user rejected this tool call|permission approval is not supported/;

/**
 * How a call ended: what it returned, or why it failed. One Kiro refused for want of an answer (an ask no one could
 * take), or by a deny rule, which v3 reports as _meta.kiro.policyDenial (recorded: “Tool call denied by user's
 * permissions. Rule: deny mcp matching …”), is refused, and says what happened: Kiro words it as the person’s answer,
 * but nobody was asked. @param {any} u @param {{ refused: Set<string>, asked: Map<string, string> }} st
 */
export function kiroResult(u, st) {
  const failed = u.status === 'failed';
  const why = failed ? (contentText(u.content) || String(u.rawOutput?.message ?? '')).replace(/^Output:\s*/, '') : contentText(u.content);
  const unanswered = failed && (st.refused.has(u.toolCallId) || REFUSED.test(why));
  const refused = unanswered || (failed && Boolean(u._meta?.kiro?.policyDenial));
  const asked = st.asked.get(u.toolCallId);
  const reason = unanswered
    ? `Kiro asks before this${asked ? ` (“${clip(asked, 80)}”)` : ''}, and can’t ask you from Postbox, so it was refused.`
    : 'Its permissions in Postbox don’t allow this.';
  return { kind: 'tool_result', id: u.toolCallId, isError: failed, text: why, ...(refused ? { refused: reason } : {}) };
}
