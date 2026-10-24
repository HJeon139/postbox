// The permission_prompt tool (mcp.mjs): what Claude Code calls (--permission-prompt-tool) before a risky tool call in
// “ask” mode. It waits for your answer on a card in the conversation.

import { describePermission } from './adapters/claude-stream.mjs';

/**
 * Asks the person whether a tool may run, and answers in the shape Claude Code expects from a
 * permission prompt tool: { behavior: "allow", updatedInput } or { behavior: "deny", message }.
 */
export async function permission(rt, sessionId, args) {
  const { tool_name, input = {}, tool_use_id, permission_suggestions, agent_id } = args ?? {};
  const { summary, detail } = describePermission(String(tool_name ?? 'a tool'), input);
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
    ? { behavior: 'allow', updatedInput: answer.updatedInput ?? input, ...(answer.updatedPermissions ? { updatedPermissions: answer.updatedPermissions } : {}) }
    : { behavior: 'deny', message: answer.message ?? 'The person didn’t allow this.' };
  return { content: [{ type: 'text', text: JSON.stringify(decision) }] };
}
