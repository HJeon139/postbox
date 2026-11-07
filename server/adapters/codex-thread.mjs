import { postboxSkillDirs } from './skill-config.mjs';

/**
 * Gives this turn’s app-server the folders of Postbox’s skills the persona left on (postboxSkillDirs,
 * skill-config.mjs) as extra skills roots, which that process holds only in memory: nothing is written to ~/.codex or
 * the project. Checked with codex-cli 0.167.0: after skills/extraRoots/set, skills/list named
 * postbox:visual-explainer, from agent-plugin/skills or from its own folder given as the root, before any thread, and
 * no file in ~/.codex changed. A Codex without the method answers with an error, and the turn goes on without them. A
 * turn on a host gets none: the folders are on this computer. Says whether Codex took them.
 * @param {(method: string, params?: any) => Promise<any>} request
 * @param {{ persona?: any, remote?: boolean, env?: NodeJS.ProcessEnv }} [turn]
 */
export async function addPostboxSkills(request, { persona, remote = false, env = process.env } = {}) {
  const extraRoots = remote ? [] : postboxSkillDirs(persona, env);
  if (!extraRoots.length) return false;
  return request('skills/extraRoots/set', { extraRoots }).then(
    () => true,
    () => false,
  );
}

// Postbox’s skills go on the app-server first, so the thread it opens has them.
// #587: Codex can return a thread id before any rollout exists. Only the recorded missing-rollout resume error
// permits a fresh thread; a failed fork must not silently discard the checkpoint the person requested.
export async function openCodexThread(ctx, request, { sourceThreadId, fork, cwd, model, openConfig }) {
  await addPostboxSkills(request, { persona: ctx.persona, remote: Boolean(ctx.remote) });
  const start = () => request('thread/start', { cwd, ...(model ? { model } : {}), ...openConfig });
  if (fork?.turnId && sourceThreadId)
    return { opened: await request('thread/fork', { threadId: sourceThreadId, lastTurnId: fork.turnId, excludeTurns: true, ...openConfig }), fresh: false };
  if (!sourceThreadId) return { opened: await start(), fresh: false };
  try {
    return { opened: await request('thread/resume', { threadId: sourceThreadId, cwd, ...openConfig }), fresh: false };
  } catch (error) {
    // -32600 is a generic invalid request, with no missing-rollout discriminator. Match the recorded text and exact
    // thread id deliberately: a broader regex would discard saved history on unrelated resume errors (#587).
    if (ctx.signal.aborted || error.code !== -32600 || error.message !== `no rollout found for thread id ${sourceThreadId}`) throw error;
    const cleared = { codexThreadId: null, fork: null, forkFrom: null };
    Object.assign(ctx.state, cleared);
    ctx.saveState(cleared);
    return { opened: await start(), fresh: true };
  }
}
