// #587: Codex can return a thread id before any rollout exists. Only the recorded missing-rollout resume error
// permits a fresh thread; a failed fork must not silently discard the checkpoint the person requested.
export async function openCodexThread(ctx, request, { sourceThreadId, fork, cwd, model, openConfig }) {
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
