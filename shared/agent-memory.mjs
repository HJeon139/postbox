// What each backend does with an agent’s memory, as the persona sheet says it in one line (#480): Claude Code and the
// Agent SDK keep one per agent (#208), Codex’s is off (#479), Kiro’s follows its setup (#479), and Antigravity keeps
// none. Here and on a host alike: a host keeps each agent’s Claude Code memory in its own folder too (#491).

const OWN = 'Memory: its own. No other agent, and none of your own sessions, reads it.';

/**
 * The persona sheet’s memory line for a backend, or null for the mock. Kiro’s follows the persona’s setup, which is
 * yours unless it’s isolated, as the server reads it (setupOf).
 * @param {string} backend @param {{ usesHostSetup?: boolean }} [persona]
 */
export function memoryLine(backend, { usesHostSetup } = {}) {
  if (backend === 'claude-code' || backend === 'agent-sdk') return OWN;
  if (backend === 'codex') return 'Memory: off. Codex keeps one memory for everything it runs, so Postbox turns it off.';
  if (backend === 'kiro-cli')
    return usesHostSetup === false
      ? 'Memory: off. Isolated agents share one Kiro home, so Postbox turns it off there.'
      : 'Memory: yours. With your setup, it reads and adds to your own Kiro memory.';
  if (backend === 'antigravity-cli') return 'Memory: none on this backend.';
  return null;
}
