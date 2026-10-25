// The Agent SDK’s canUseTool: a permission prompt the SDK sends becomes the same card in the thread as the CLI’s.

import { describePermission } from './claude-stream.mjs';

/**
 * Answers one canUseTool call of a turn. ctx is the turn’s context (agent-sdk.mjs, deliver), which asks the person.
 * @param {any} ctx @param {string} toolName @param {any} input @param {any} [opts]
 */
export async function canUseTool(ctx, toolName, input, opts = {}) {
  // Postbox’s own tools only show things in the thread.
  if (toolName.startsWith('mcp__postbox__')) return { behavior: 'allow', updatedInput: input };
  const { summary, detail } = describePermission(toolName, input);
  // The prompt’s own suggestions go to Always allow (none, when it has none or says a saved rule would grant more
  // than this call), and its agent id names the subagent that asks (#66).
  const answer = await ctx.askPermission({
    tool: toolName,
    summary,
    detail,
    input,
    suggestions: Array.isArray(opts.suggestions) ? opts.suggestions : [],
    suppressAlways: opts.suppressAlwaysAllowRule === true,
    agentId: opts.agentID ?? null,
    ...(opts.toolUseID ? { toolUseId: opts.toolUseID } : {}),
  });
  return answer.allow
    ? {
        behavior: 'allow',
        updatedInput: answer.updatedInput ?? input,
        ...(answer.updatedPermissions ? { updatedPermissions: answer.updatedPermissions } : {}),
      }
    : { behavior: 'deny', message: answer.message ?? 'The person didn’t allow this.' };
}
