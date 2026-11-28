// Opens a Codex thread for the conformance probe (#585) the way Postbox’s adapter does: through openCodexThread, with
// the params codexOpenConfig builds. So a change to the field the guide goes in, as in #584, reaches the probe too.

import { codexOpenConfig, openCodexThread } from '../../server/adapters/codex-thread.mjs';
import { POSTBOX_SKILLS } from '../../server/adapters/skill-config.mjs';

/**
 * Starts a thread, resumes `sourceThreadId`, or forks it at `forkTurnId`, with `guide` as Postbox gives it. The
 * probe checks the guide alone, so it opens as a persona with every Postbox skill off, which sends no skills root
 * (#207). Resolves with the opened thread’s answer.
 * @param {(method: string, params?: any) => Promise<any>} request
 * @param {{ cwd: string, guide: string, sourceThreadId?: string, forkTurnId?: string }} open
 */
export async function openThread(request, { cwd, guide, sourceThreadId, forkTurnId }) {
  const ctx = { remote: null, persona: { skillsOff: [...POSTBOX_SKILLS] }, signal: new AbortController().signal, state: {}, saveState() {} };
  const fork = forkTurnId ? { turnId: forkTurnId } : undefined;
  const { opened } = await openCodexThread(ctx, request, { sourceThreadId, fork, cwd, model: undefined, openConfig: codexOpenConfig(guide) });
  return opened;
}
