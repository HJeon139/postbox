// What each backend does with an agent’s memory, as the persona sheet says it in one line (#480): Claude Code
// keeps one per agent (#208), here and on a host (#491); Codex’s is off everywhere (#479); Kiro’s is off for
// an isolated agent on this computer (#479), while on a host each isolated agent has a Kiro home of its own, keeping
// whatever memory that Kiro is set to, and with your setup it’s that account’s; Antigravity’s, if it keeps any, is your
// sign-in’s (inferred from its delete_knowledge tool, agy-bypass.mjs, not seen in a turn).

import { MEMORY_CLAUDE_MIN } from './agent-facts.mjs';
import { olderThan } from './versions.mjs';

const OWN = 'Memory: its own. No other agent, and none of your own sessions, reads it.';

/** Kiro’s line, by its setup and where it runs. @param {boolean} isolated @param {boolean} onHost */
function kiroLine(isolated, onHost) {
  if (onHost)
    return isolated
      ? 'Memory: if Kiro keeps any, it’s in a Kiro home of its own on the host, kept under its name.'
      : 'Memory: the host account’s own Kiro memory, with your setup.';
  return isolated
    ? 'Memory: off. Isolated agents share one Kiro home, so Postbox turns it off there.'
    : 'Memory: yours. With your setup, it reads and adds to your own Kiro memory.';
}

/**
 * The persona sheet’s memory line for a backend, or null for the mock. Kiro’s follows the persona’s setup, which is
 * yours unless it’s isolated, as the server reads it (setupOf), and where it runs. A Claude Code here older than
 * MEMORY_CLAUDE_MIN keeps one memory for the project, as the overview says (installNote).
 * @param {string} backend @param {{ usesHostSetup?: boolean, remote?: string|null }} [persona]
 * @param {{ claudeCode?: string|null }} [versions]  this computer’s
 */
export function memoryLine(backend, { usesHostSetup, remote } = {}, { claudeCode } = {}) {
  if (backend === 'claude-code' && !remote && claudeCode && olderThan(claudeCode, MEMORY_CLAUDE_MIN))
    return `Memory: one for every agent in the project and your own sessions there, until Claude Code is ${MEMORY_CLAUDE_MIN} or later.`;
  if (backend === 'claude-code') return OWN;
  if (backend === 'codex') return 'Memory: off. Codex keeps one memory for everything it runs, so Postbox turns it off.';
  if (backend === 'kiro-cli') return kiroLine(usesHostSetup === false, Boolean(remote));
  if (backend === 'antigravity-cli') return 'Memory: if Antigravity keeps any, it’s your sign-in’s, shared with every Antigravity agent and your own sessions.';
  return null;
}
