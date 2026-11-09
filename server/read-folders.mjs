// Folders an agent may read in one conversation, from Always allow on a read card (#338): Antigravity’s workspace for
// reads, as the person decided on 27 October 2026. They’re kept on the session as readDirs, apart from addDirs, the
// folders it may work in: Antigravity’s hook reads readDirs only in its read branch, so a readable folder is never one
// it may edit with no card, and it isn’t passed as --add-dir. Claude Code keeps its own offer (harness first), Codex
// makes no read cards, and a host card has none, since the list is this computer’s.

import { realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { httpError } from './helpers.mjs';

/** The backend whose read cards offer a readable folder. */
const READ_FOLDER_BACKENDS = new Set(['antigravity-cli']);
/** As many readable folders as a conversation may add folders (permissions-panel.mjs’s MAX_ADD_DIRS). */
export const MAX_READ_DIRS = 20;

/**
 * A path as it really is, links followed and in its true case, or null when it doesn’t exist. The native call, since
 * realpathSync keeps the case it’s given, and macOS’s disk ignores case: /USERS/<you>/.ssh would pass the home checks
 * (#338). @param {string} p
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
  // Outside home is .. or ../…, never ..notes, a dot-folder in it (#1074).
  if (inHome === '..' || inHome.startsWith(`..${sep}`) || isAbsolute(inHome)) return true;
  return !inHome.split(sep)[0].startsWith('.');
}

/**
 * The folder a read card is about, by its real path, or null: the path itself when it’s a folder, as Antigravity’s
 * list_dir, grep_search and find_by_name send one, else the folder of the file it leads to, so a link to ~/.ssh/id_rsa
 * is judged as ~/.ssh. A file that doesn’t exist yet is judged by its folder.
 * @param {any} input
 */
function folderOf(input) {
  const path = typeof input?.file_path === 'string' ? input.file_path.trim() : '';
  if (!isAbsolute(path)) return null;
  const target = real(path);
  if (!target) return real(dirname(path));
  const isFolder = statSync(target, { throwIfNoEntry: false })?.isDirectory() ?? false;
  return isFolder ? target : dirname(target);
}

/**
 * Every path a read card names: its file_path, or all of paths when Antigravity’s hook names more than one, as a
 * grep_search with both Path and SearchPath outside the folders does (agy-hook.mjs, #1074). Allowing the card allows
 * them all, so each is judged.
 * @param {any} input @returns {unknown[]}
 */
const readPaths = (input) => (Array.isArray(input?.paths) && input.paths.length ? input.paths : [input?.file_path]);

/** Whether a card is one this module answers: a read on this computer by an Antigravity agent. */
const answersRead = ({ backend, tool, hostId }) => !hostId && READ_FOLDER_BACKENDS.has(String(backend)) && tool === 'Read';

/**
 * The card’s Always allow for a read outside the agent’s folders, or null for none: the folder it’s about, by its real
 * path, so a link to a dot-folder is judged by where it leads.
 * @param {{ backend?: string, tool: unknown, input: any, hostId?: string | null, home: string }} req
 * @returns {{ lines: { text: string, rule: string }[], readDir: string } | null}
 */
export function readFolderOffer({ backend, tool, input, hostId = null, home }) {
  // One folder’s offer on a card about two paths would allow the other with it.
  if (!answersRead({ backend, tool, hostId }) || readPaths(input).length !== 1) return null;
  const dir = folderOf(input);
  const realHome = real(home);
  if (!dir || !realHome || !offerable(dir, realHome)) return null;
  // The agent’s, not the conversation’s: kept on its session, so another Antigravity agent there asks again (#1074).
  return { lines: [{ text: `Always allow ${dir} for this agent to read, in this conversation`, rule: dir }], readDir: dir };
}

/**
 * Whether a read card needs no asking, since its folder is in one the conversation saved as readable: by the session as
 * it is now, so a folder allowed earlier in the turn counts at once, where the hook’s list is the turn’s start (#338).
 * O(folders saved), at most MAX_READ_DIRS.
 * @param {any} rt @param {string} sessionId @param {{ tool: unknown, input?: any, hostPrompt?: { hostId: string } | null }} req
 */
export function inReadFolder(rt, sessionId, { tool, input, hostPrompt = null }) {
  const se = rt.s.sessions[sessionId];
  const backend = se ? rt.persona(se.personaId)?.backend : undefined;
  if (!se?.readDirs?.length || !answersRead({ backend, tool, hostId: hostPrompt?.hostId ?? null })) return false;
  // Where each read leads, so a link in a saved folder to ~/.ssh isn’t inside it. A saved folder passed the offer’s
  // checks, so it never holds home or a dot-folder in it.
  const saved = (/** @type {string | null} */ dir) => dir !== null && se.readDirs.some((/** @type {string} */ d) => dir === d || dir.startsWith(d + sep));
  return readPaths(input).every((file_path) => saved(folderOf({ file_path })));
}

/**
 * Saves a readable folder for the conversation, read at once by inReadFolder and by the hook from its next turn, built from the pending session (#796’s class), so
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
