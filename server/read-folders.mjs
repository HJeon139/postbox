// Folders an agent may read in one conversation, from Always allow on a read card (#338): Antigravity’s workspace for
// reads, as the person decided on 27 October 2026. They’re kept on the session as readDirs, apart from addDirs, the
// folders it may work in: Antigravity’s hook reads readDirs only in its read branch, so a readable folder is never one
// it may edit with no card, and it isn’t passed as --add-dir. Claude Code keeps its own offer (harness first), Codex
// makes no read cards, and a host card has none, since the list is this computer’s.

import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { httpError } from './helpers.mjs';

/** The backend whose read cards offer a readable folder. */
const READ_FOLDER_BACKENDS = new Set(['antigravity-cli']);
/** As many readable folders as a conversation may add folders (permissions-panel.mjs’s MAX_ADD_DIRS). */
export const MAX_READ_DIRS = 20;

/**
 * A path as it really is, links followed and in its true case, or null when it doesn’t exist. The native call, since
 * realpathSync keeps the case it’s given, and macOS’s disk ignores case: /USERS/<you>/.ssh would pass the home checks
 * (critic’s read of 756ac89e). @param {string} p
 */
function real(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * Whether a folder may be offered: never /, home, a folder that holds home, nor a dot-folder in home or anything inside
 * one (~/.ssh, ~/.aws, ~/.config), where credentials live. Both are real paths.
 * @param {string} dir @param {string} home
 */
function offerable(dir, home) {
  if (dir === sep || dir === home) return false;
  if (home.startsWith(dir + sep)) return false;
  const inHome = relative(home, dir);
  if (inHome.startsWith('..') || isAbsolute(inHome)) return true;
  return !inHome.split(sep)[0].startsWith('.');
}

/**
 * The card’s Always allow for a read outside the agent’s folders, or null for none: the file’s folder, by its real
 * path, so a link to a dot-folder is judged by where it leads.
 * @param {{ backend?: string, tool: unknown, input: any, hostId?: string | null, home: string }} req
 * @returns {{ lines: { text: string, rule: string }[], readDir: string } | null}
 */
export function readFolderOffer({ backend, tool, input, hostId = null, home }) {
  if (hostId || !READ_FOLDER_BACKENDS.has(String(backend)) || tool !== 'Read') return null;
  const file = typeof input?.file_path === 'string' ? input.file_path.trim() : '';
  if (!isAbsolute(file)) return null;
  const dir = real(dirname(file));
  const realHome = real(home);
  if (!dir || !realHome || !offerable(dir, realHome)) return null;
  return { lines: [{ text: `Always allow reading files in ${dir} in this conversation`, rule: dir }], readDir: dir };
}

/**
 * Saves a readable folder for the conversation, from its next turn, built from the pending session (#796’s class), so
 * a write still held behind a commit isn’t lost. One already listed adds nothing.
 * @param {any} rt @param {string} sessionId @param {string} dir
 */
export function addReadFolder(rt, sessionId, dir) {
  rt.updateSession(sessionId, (/** @type {any} */ se) => {
    const dirs = se.readDirs ?? [];
    if (dirs.includes(dir)) return {};
    if (dirs.length >= MAX_READ_DIRS) throw httpError(422, `A conversation can have up to ${MAX_READ_DIRS} readable folders.`);
    return { readDirs: [...dirs, dir] };
  });
}

/**
 * A card’s Always allow when it’s a read outside an Antigravity agent’s folders, or null to leave the card to
 * permission-cards.mjs’s alwaysFor: never when the harness sent offers of its own, or said none would fit.
 * @param {any} rt @param {any} se
 * @param {{ tool: unknown, input: any, suggestions: unknown, suppressAlways: boolean, hostId?: string | null }} req
 */
export function readCardAlways(rt, se, { tool, input, suggestions, suppressAlways, hostId = null }) {
  if (suppressAlways || (suggestions !== null && suggestions !== undefined)) return null;
  return readFolderOffer({ backend: rt.persona(se.personaId)?.backend, tool, input, hostId, home: rt.home });
}
