// The permission_prompt tool (mcp.mjs): what Claude Code calls (--permission-prompt-tool) before a risky tool call in
// “ask” mode. It waits for your answer on a card in the conversation. Only that backend asks through it.

import { describePermission } from './adapters/claude-stream.mjs';

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
  if (signal?.aborted)
    return { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: 'The permission request closed before anyone answered.' }) }] };
  const { tool_name, input = {}, tool_use_id, permission_suggestions, agent_id } = args ?? {};
  const { summary, detail } = describePermission(String(tool_name ?? 'a tool'), input);
  const before = new Set(rt.permissionWaits?.keys?.() ?? []);
  const onAbort = () => {
    for (const [id, w] of rt.permissionWaits ?? [])
      if (w.sessionId === sessionId && !before.has(id)) rt.settlePermission(id, 'expired', 'The permission request closed before anyone answered.');
  };
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const answer = await rt.requestPermission(sessionId, {
      tool: String(tool_name ?? ''),
      summary,
      detail,
      toolUseId: tool_use_id,
      input,
      suggestions: permission_suggestions,
      agentId: typeof agent_id === 'string' ? agent_id : null,
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
  const adapter = backend && rt.adapters.names().includes(backend) ? rt.adapters.get(backend) : null;
  return Boolean(adapter) && adapter.capabilities?.promptTool !== false;
}

/** What a call from an agent that doesn’t ask through permission_prompt gets, at once. */
export const NOT_YOUR_PROMPT = {
  content: [
    {
      type: 'text',
      text: 'Postbox didn’t run permission_prompt: it’s how the Claude Code CLI asks the person before a risky call, and your backend asks another way, or not at all. Don’t call it yourself. Make the call you need: if it needs the person’s permission, Postbox asks them.',
    },
  ],
  isError: true,
};
