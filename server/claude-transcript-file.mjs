// Where Claude Code keeps a session’s transcript (#932): under its projects folder, in a folder named from the real
// path of the session’s working folder, every character but a letter or digit made a hyphen. A working folder given
// through a link is resolved first, as Claude Code resolves it; one that’s gone keeps the path it was given.

import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @param {string} projects  Claude Code’s projects folder, `~/.claude/projects`
 * @param {string} cwd  the session’s working folder
 * @param {string} sessionId  Claude Code’s session id
 */
export function claudeTranscriptFile(projects, cwd, sessionId) {
  const real = existsSync(cwd) ? realpathSync(cwd) : cwd;
  return join(projects, real.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}
