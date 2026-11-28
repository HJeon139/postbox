// Opens a Codex thread for the conformance probe (#585) the way Postbox’s adapter does: through openCodexThread, with
// the params codexOpenConfig builds. So a change to the field the guide goes in, as in #584, reaches the probe too.

import { codexOpenConfig, openCodexThread } from '../../server/adapters/codex-thread.mjs';

/**
 * Starts a thread, resumes `sourceThreadId`, or forks it at `forkTurnId`, with `guide` as Postbox gives it. A turn
 * on a host gets no skills root (`remote`), and neither does the probe: it checks the guide alone. Resolves with the
 * opened thread’s answer.
 * @param {(method: string, params?: any) => Promise<any>} request
 * @param {{ cwd: string, guide: string, sourceThreadId?: string, forkTurnId?: string }} open
 */
export async function openThread(request, { cwd, guide, sourceThreadId, forkTurnId }) {
  const ctx = { remote: true, persona: null, signal: new AbortController().signal, state: {}, saveState() {} };
  const fork = forkTurnId ? { turnId: forkTurnId } : undefined;
  const { opened } = await openCodexThread(ctx, request, { sourceThreadId, fork, cwd, model: undefined, openConfig: codexOpenConfig(guide) });
  return opened;
}
