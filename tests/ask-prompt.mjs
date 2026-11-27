// A scripted turn’s permission prompt, for tests whose adapter stands in for a harness that asks: the call goes to the
// person through the turn’s context, as every adapter’s does, and the answer comes back in the shape Claude Code’s
// prompt tool answers with (server/permission-prompt.mjs).

import { describePermission } from '../server/adapters/claude-stream.mjs';

/**
 * @param {any} ctx  the turn’s context @param {string} tool @param {any} input @param {string} toolUseId
 * @returns {Promise<{ behavior: 'allow', updatedInput: any } | { behavior: 'deny', message: string }>}
 */
export async function promptFor(ctx, tool, input, toolUseId) {
  const { summary, detail } = describePermission(tool, input);
  const answer = await ctx.askPermission({ tool, summary, detail, input, toolUseId });
  return answer.allow
    ? { behavior: 'allow', updatedInput: answer.updatedInput ?? input }
    : { behavior: 'deny', message: answer.message ?? 'The person didn’t allow this.' };
}
