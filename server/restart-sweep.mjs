// What a restart does with the turns that were running when the server stopped (server/index.mjs).

/** Turns that were running when the server stopped can't resume: mark them so nothing looks stuck. @param {any} rt */
export function settleInterrupted(rt) {
  for (const se of Object.values(rt.s.sessions))
    if (['think', 'gen', 'tool', 'stopping'].includes(se.state))
      rt.updateSession(se.id, { state: 'idle', subagents: [], currentStep: 'Interrupted by a restart', stopAsk: null });
}
