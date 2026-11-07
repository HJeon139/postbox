// The permission_prompt tool (mcp.mjs): what Claude Code calls (--permission-prompt-tool) before a risky tool call in
// “ask” mode. It waits for your answer on a card in the conversation. Only that backend asks through it.

import { adapterOf } from './adapters/adapter.mjs';
import { describePermission } from './adapters/claude-stream.mjs';
import { claimPrompt, REFUSED } from './prompt-claim.mjs';

function toAbortSignal(closeOrSignal) {
  if (!closeOrSignal) return null;
  if ('aborted' in closeOrSignal) return closeOrSignal;
  const ac = new AbortController();
  if (closeOrSignal.destroyed) ac.abort();
  else closeOrSignal.on?.('close', () => !closeOrSignal.writableEnded && ac.abort());
  return ac.signal;
}

/**
 * Asks the person whether a tool may run, and answers in the shape Claude Code expects from a
 * permission prompt tool: { behavior: "allow", updatedInput } or { behavior: "deny", message }.
 * @param {any} rt @param {string} sessionId @param {any} args @param {AbortSignal|import('node:http').ServerResponse|null} [closeOrSignal]
 */
export async function permission(rt, sessionId, args, closeOrSignal = null) {
  const signal = toAbortSignal(closeOrSignal);
  const deny = (message) => ({ content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message }) }] });
  if (signal?.aborted) return deny(REFUSED.closed);
  // Only a prompt for a call the turn’s stream showed counts, once (#353, #665): the rest never reach a card or the judge.
  const claim = await claimPrompt(rt, sessionId, args, { signal });
  if (!claim.ok) return deny(claim.why === 'repeat' ? REFUSED.again : claim.message);
  // Nothing but the call’s id is the prompt’s: a copy that claims first must offer nothing the real call’s card
  // wouldn’t, so its permission_suggestions never reach Always allow (the CLI sends none, as recorded in
  // permission-prompts.json and permission-edit-prompts.json), and Postbox makes the rule from the stream’s call.
  const { tool_use_id } = args ?? {};
  // The call as the stream showed it, which the prompt matched, and the subagent’s call it’s under.
  const { tool: tool_name, input, agentId, bound } = claim;
  const { summary, detail } = describePermission(String(tool_name ?? 'a tool'), input);
  const useId = tool_use_id ? String(tool_use_id) : null;
  const onAbort = () => {
    for (const [id, w] of rt.permissionWaits ?? [])
      if (w.sessionId === sessionId && useId && rt.store.pending.item(w.threadId, id)?.toolUseId === useId)
        rt.settlePermission(id, 'expired', 'The permission request closed before anyone answered.');
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const answer = await rt.requestPermission(sessionId, {
      tool: String(tool_name ?? ''),
      summary,
      detail,
      toolUseId: tool_use_id,
      input,
      agentId: agentId ?? null,
      bound: bound === true,
    });
    const decision = answer.allow
      ? {
          behavior: 'allow',
          updatedInput: answer.updatedInput ?? input,
          ...(answer.updatedPermissions ? { updatedPermissions: answer.updatedPermissions } : {}),
        }
      : { behavior: 'deny', message: answer.message ?? 'The person didn’t allow this.' };
    return { content: [{ type: 'text', text: JSON.stringify(decision) }] };
  } finally {
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * Whether the session’s agent asks through permission_prompt, by the backend its running turn started on (else its
 * persona’s): the Claude Code CLI does (--permission-prompt-tool). A backend that declares capabilities.promptTool
 * false asks another way (the SDK’s canUseTool) or can’t ask at all (Kiro), so a call from one is the agent’s own, and
 * would hold a card and the call open for up to POSTBOX_TIMEOUT_MS (#220).
 * @param {any} rt @param {string} sessionId
 */
export function asksByPrompt(rt, sessionId) {
  const se = rt.s.sessions[sessionId];
  const backend = rt.turns.get(sessionId)?.backend ?? (se ? rt.personaFor(se)?.backend : null);
  const adapter = adapterOf(rt, backend);
  return Boolean(adapter) && adapter.capabilities?.promptTool !== false;
}

// What a call from an agent that doesn’t ask through permission_prompt gets, at once: one text with the host’s shim.
export { NOT_YOUR_PROMPT } from '../shared/mcp-tools.mjs';
