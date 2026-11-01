// The checks on a persona’s setup that its create and update share (#57, #59, #60), moved out of server/runtime.mjs
// under the file-length rule.

import { EFFORT_LEVELS } from './adapters/setup.mjs';
import { httpError } from './helpers.mjs';

const MAX_MCP_OFF = 100;
/**
 * A persona’s setup choices (#57) are true or false, and the MCP servers it turned off (#59) a list of names;
 * anything else is refused. Absent means the default.
 * @param {{ usesHostSetup?: unknown, canPublish?: unknown, allowRequested?: unknown, mcpOff?: unknown }} setup
 */
export function checkSetup({ usesHostSetup, canPublish, allowRequested, mcpOff }) {
  if (usesHostSetup !== undefined && typeof usesHostSetup !== 'boolean') throw httpError(422, '“Uses your Claude Code setup” is true or false.');
  if (canPublish !== undefined && typeof canPublish !== 'boolean') throw httpError(422, '“Can publish outside Postbox” is true or false.');
  if (allowRequested !== undefined && typeof allowRequested !== 'boolean') throw httpError(422, '“Calls you asked for run without a card” is true or false.');
  if (
    mcpOff !== undefined &&
    (!Array.isArray(mcpOff) || mcpOff.length > MAX_MCP_OFF || mcpOff.some((n) => typeof n !== 'string' || !n.trim() || n.length > 200))
  )
    throw httpError(422, `The MCP servers turned off are a list of up to ${MAX_MCP_OFF} server names.`);
}
/** A persona’s effort is one of the levels Claude Code and the SDK take (#60). */
export function checkEffort(effort) {
  if (!EFFORT_LEVELS.includes(effort)) throw httpError(422, `Effort is one of ${EFFORT_LEVELS.join(', ')}.`);
}
