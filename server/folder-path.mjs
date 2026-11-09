// The check a folder’s path passes before Postbox works in it, a project’s (#547) or an agent’s (#990): a full path,
// as text, with nothing hidden in it and nothing to resolve. Moved out of server/projects.mjs.

import { isAbsolute } from 'node:path';
import { hasControl, hiddenInFolder, INVISIBLE } from '../shared/invisible.mjs';
import { httpError } from './helpers.mjs';

// Every control character, to show each as its escape (shownFolder).
const CONTROL_ALL = /\p{Cc}/gu;
// The longest folder path taken, in UTF-16 code units: Linux’s PATH_MAX is 4096 bytes, which no longer path fits.
const MAX_FOLDER = 4096;

/** Whether a full path other than / has an empty, `.` or `..` part: //, /./, /../ or a / at its end. @param {string} path */
const hasOddPart = (path) =>
  path !== '/' &&
  path
    .slice(1)
    .split('/')
    .some((part) => part === '' || part === '.' || part === '..');

/**
 * A 422 refusing a folder, with `why`, what’s wrong with it and nothing the person should do, kept apart for a message
 * about a folder the person didn’t write (sessionFolder).
 * @param {string} message @param {string} why
 */
const refused = (message, why) => Object.assign(httpError(422, message), { why });

/**
 * A project’s folder as the person wrote it: a full path, as text, of at most MAX_FOLDER characters, with no control
 * or hidden character and no empty, `.` or `..` part, so no `//`; `/` itself is taken. One `/` at its end, which a
 * shell’s tab completion adds, is dropped. It bounds the file picker and is where the project’s agents start, so
 * anything else is refused rather than normalized or resolved against the folder Postbox was started from (#547).
 * @param {unknown} folder @param {string} [whose]  whose folder it is, in the message for one that isn’t text
 * @returns {string}
 */
export function fullPath(folder, whose = 'A project’s') {
  if (folder === undefined || folder === null || (typeof folder === 'string' && !folder.trim()))
    throw refused('Write the folder’s full path.', 'Its path is blank.');
  if (typeof folder !== 'string') {
    const why = `${whose} folder is its full path, as text.`;
    throw refused(`${why} Write the folder’s full path.`, why);
  }
  if (folder.length > MAX_FOLDER) {
    const why = `A folder’s path is at most ${MAX_FOLDER} characters.`;
    throw refused(`${why} Pick a folder with a shorter path.`, why);
  }
  if (hasControl(folder)) {
    const why = 'A folder’s path can’t contain control characters, such as a new line.';
    throw refused(`${why} Write the folder’s full path.`, why);
  }
  if (hiddenInFolder(folder)) {
    const why = 'A folder’s path can’t contain invisible characters, such as a zero-width space or a bidi control, or a lone surrogate.';
    throw refused(`${why} Write the folder’s full path.`, why);
  }
  if (!isAbsolute(folder))
    throw refused(
      'Write the folder’s full path, starting with /. Postbox doesn’t guess where a relative one is.',
      'It isn’t a full path, starting with /, and Postbox doesn’t guess where a relative one is.',
    );
  const path = folder !== '/' && folder.endsWith('/') && !folder.endsWith('//') ? folder.slice(0, -1) : folder;
  if (hasOddPart(path)) {
    const why = 'A folder’s path can’t have an empty, . or .. part, such as //, /./ or /../.';
    throw refused(`${why} Write the folder’s full path without them.`, why);
  }
  return path;
}

/**
 * An agent’s folder (its sheet’s Folder, “Where it works”), checked as a project’s is (#990), where its agent starts
 * with shell and edit access. It’s kept as written, but for one / at its end, and not looked for: the agent’s folder
 * is made at its first turn (server/adapters/folder.mjs). Empty, missing or null is '': the project’s root folder, or
 * one of the agent’s own. Blank is refused, as a project’s is.
 * @param {unknown} folder @returns {string}
 */
export const agentFolderPath = (folder) => (folder === undefined || folder === null || folder === '' ? '' : fullPath(folder, 'An agent’s'));

/**
 * An agent’s folder as it’s stored, by where it runs (#990, #120). On this computer it passes agentFolderPath. On a
 * host its turn works in the project’s folder there, or one of its own there (server/remote/turns-start.mjs), never
 * this one, so it’s kept as written, unchecked, as text of at most MAX_FOLDER characters, and anything else is refused
 * as fullPath refuses it: the sheet re-sends Folder with every save, and one stored before #990 would refuse them all.
 * It’s checked again when the agent moves back here, and read here as none while the check refuses it (storedFolder).
 * @param {unknown} folder @param {{ hostId?: string } | null | undefined} remote  where the agent runs, after the change
 * @returns {string}
 */
export function placedFolder(folder, remote) {
  if (!remote?.hostId || folder === undefined || folder === null) return agentFolderPath(folder);
  if (typeof folder === 'string' && folder.length <= MAX_FOLDER) return folder;
  return fullPath(folder, 'An agent’s');
}

/**
 * A session’s persona snapshot (Runtime.personaFor) without a folder the check refuses (agentFolderPath), as one
 * taken while the agent’s folder was stored unchecked, before #990. The live persona’s folder shows through it then,
 * so a folder fixed in the agent’s sheet, as the refusal asks (storedFolder), reaches a conversation already going at
 * its next turn, and one still bad there is refused. A snapshot’s folder that passes keeps winning. It writes
 * nothing: the session keeps its snapshot, and this runs wherever a session’s persona is read.
 * @template {{ folder?: unknown }} T @param {T} snapshot @returns {Omit<T, 'folder'> | T}
 */
export function checkedSnapshot(snapshot) {
  try {
    agentFolderPath(snapshot.folder);
    return snapshot;
  } catch {
    // Refused: drop it, so the live persona’s folder is the one used.
    const { folder: _refused, ...rest } = snapshot;
    return rest;
  }
}

// The longest a folder is shown in a message, before it’s cut: a refused one can be any length.
const SHOWN = 200;

/**
 * A folder for a message: quoted, with a control or invisible character as its escape, so it can’t hide or reorder
 * the text around it, and cut short when long. One that isn’t text shows as JSON.
 * @param {unknown} folder
 */
function shownFolder(folder) {
  const asEscape = (c) => {
    const code = /** @type {number} */ (c.codePointAt(0)).toString(16);
    return code.length > 4 ? `\\u{${code}}` : `\\u${code.padStart(4, '0')}`;
  };
  const shown = String(JSON.stringify(folder)).replace(CONTROL_ALL, asEscape).replace(INVISIBLE, asEscape);
  return shown.length > SHOWN ? `${shown.slice(0, SHOWN)}…` : shown;
}

/**
 * The folder an attached Claude Code session ran in, from its transcript, as its agent’s folder
 * (Runtime.attachClaudeSession), checked as an agent’s is (#990). The person wrote none of it, so one refused names
 * where the session ran and says what to do instead, rather than asking them to write a folder.
 * @param {unknown} cwd @returns {string}
 */
export function sessionFolder(cwd) {
  try {
    return agentFolderPath(cwd);
  } catch (e) {
    const message = `This Claude Code session ran in ${shownFolder(cwd)}, which Postbox can’t use as an agent’s folder: ${e.why} Start the session from a different folder, or attach a different one.`;
    throw Object.assign(httpError(422, message), { cause: e });
  }
}

/**
 * A persona’s stored folder, '' for none, for Postbox to work in: its turn, `!` commands, the permissions panel, the
 * files it names and the work ledger. One stored before it was checked (#990), a relative one say, is refused with a
 * 409 rather than used: it would be resolved against the folder Postbox was started from. A 409, not a 422: the
 * request that reads it is fine, the agent’s stored folder isn’t, and the person changes it in the agent’s sheet.
 * An agent on a host keeps its folder unchecked (placedFolder), and never works in it here: one the check refuses is
 * read here as none of its own, and checked again once the agent moves back.
 * @param {{ handle: string, folder?: unknown, remote?: { hostId?: string } | null } | null | undefined} persona @returns {string}
 */
export function storedFolder(persona) {
  const folder = persona?.folder;
  try {
    agentFolderPath(folder);
  } catch (e) {
    if (persona?.remote?.hostId) return '';
    const handle = persona?.handle;
    const why = `Postbox couldn’t open the folder ${shownFolder(folder)} for @${handle}: ${e.message} Change it in @${handle}’s sheet, under Folder, or leave it empty to work in the project’s root folder.`;
    throw Object.assign(httpError(409, why), { cause: e });
  }
  return /** @type {string} */ (folder || '');
}

/**
 * A persona’s stored folder for what only reads from it, the persona sheet’s MCP servers and skills: '' for one
 * storedFolder refuses, as for none, so nothing is read relative to the folder Postbox was started from (#990).
 * @param {{ handle: string, folder?: unknown } | null | undefined} persona @returns {string}
 */
export function folderOrNone(persona) {
  try {
    return storedFolder(persona);
  } catch {
    // Refused: read as no folder of its own.
    return '';
  }
}
