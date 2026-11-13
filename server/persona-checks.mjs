// The checks on a persona’s setup that its create and update share (#57, #59, #60), moved out of server/runtime.mjs
// under the file-length rule.

import { HANDLE } from '../shared/limits.mjs';
import { EFFORT_LEVELS } from './adapters/setup.mjs';
import { httpError } from './helpers.mjs';

const MAX_MCP_OFF = 100;
/** A list of up to MAX_MCP_OFF names, each one 1–200 characters. */
const names = (v) => Array.isArray(v) && v.length <= MAX_MCP_OFF && v.every((n) => typeof n === 'string' && n.trim() && n.length <= 200);
/**
 * A persona’s setup choices (#57) are true or false, and the MCP servers (#59) and skills (#207) it turned off lists of names;
 * anything else is refused. Absent means the default.
 * @param {{ usesHostSetup?: unknown, canPublish?: unknown, allowRequested?: unknown, mcpOff?: unknown, skillsOff?: unknown }} setup
 */
export function checkSetup({ usesHostSetup, canPublish, allowRequested, mcpOff, skillsOff }) {
  if (usesHostSetup !== undefined && typeof usesHostSetup !== 'boolean') throw httpError(422, '“Uses your Claude Code setup” is true or false.');
  if (canPublish !== undefined && typeof canPublish !== 'boolean') throw httpError(422, '“Can publish outside Postbox” is true or false.');
  if (allowRequested !== undefined && typeof allowRequested !== 'boolean') throw httpError(422, '“Calls you asked for run without a card” is true or false.');
  if (mcpOff !== undefined && !names(mcpOff)) throw httpError(422, `The MCP servers turned off are a list of up to ${MAX_MCP_OFF} server names.`);
  if (skillsOff !== undefined && !names(skillsOff)) throw httpError(422, `The skills turned off are a list of up to ${MAX_MCP_OFF} skill names.`);
}
/** A persona’s effort is one of the levels Claude Code and the SDK take (#60). */
export function checkEffort(effort) {
  if (!EFFORT_LEVELS.includes(effort)) throw httpError(422, `Effort is one of ${EFFORT_LEVELS.join(', ')}.`);
}
/**
 * A model the person typed goes to the harness as its --model, listed or not (#1302). One that starts with - would be
 * read as one of the harness’s options, on every backend, so it’s refused.
 * @param {unknown} model
 */
export function checkModel(model) {
  if (String(model).startsWith('-'))
    throw httpError(422, 'A model can’t start with -, since its harness would read it as an option. Type the model’s ID, such as claude-opus-5-5.');
}
/**
 * A persona’s name as it’s stored: without a leading @ and the spaces around it. One that HANDLE refuses is refused here, so
 * createPersona and agents.json’s check before seeding read a name the same way (#990).
 * @param {unknown} handle
 */
export function handleOf(handle) {
  const name = String(handle ?? '')
    .replace(/^@/, '')
    .trim();
  if (!HANDLE.test(name)) throw httpError(422, 'A name uses 2–24 letters, digits, - or _, and starts with a letter.');
  return name;
}
