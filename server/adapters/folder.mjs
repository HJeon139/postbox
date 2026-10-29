// The folder an agent works in, the same for every backend: its persona’s, else its project’s root folder (where
// sessions start, per designs/intent.md, “Agents and sessions”), else a workspace of its own. Its permission mode
// decides what it may change there.

import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { personaMemory } from './setup.mjs';

/**
 * The agent’s folder, made if it’s missing. A folder that can’t be made fails the turn with its reason: a CLI
 * started in it would fail as ENOENT, the same code as a CLI that isn’t installed, and say so.
 * @param {{ handle: string, folder?: string|null }} persona
 * @param {{ folder?: string|null } | null | undefined} project
 * @param {string} workRoot  where agents without a folder get one of their own
 * @returns {Promise<string>}
 */
export async function agentFolder(persona, project, workRoot) {
  const dir = persona.folder || project?.folder || join(workRoot, persona.handle);
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    throw new Error(
      `Postbox couldn’t open the folder ${dir} for @${persona.handle}: ${e.code ?? e.message}. Check that it exists and that you can write to it, or choose another folder for the project or the agent.`,
      { cause: e },
    );
  }
  return dir;
}

/**
 * Where personas’ own memory folders go on this computer (#208, setup.mjs’s memoryFolder): `memory` in the data
 * folder, beside the workspaces at workRoot.
 * @param {string} workRoot
 */
export const memoryRootFor = (workRoot) => join(dirname(workRoot), 'memory');

/**
 * Removes a deleted persona’s memory folders on this computer (#208), for the Claude Code and Agent SDK adapters,
 * which share them. On a host they stay, in Postbox’s folder there: nothing removes a host’s files yet.
 * @param {string} workRoot @param {{ id?: string, handle: string }} persona
 */
export const forgetMemory = (workRoot, persona) => rm(personaMemory(memoryRootFor(workRoot), persona), { recursive: true, force: true });
