// The check a folder’s path passes before Postbox works in it, a project’s (#547) or an agent’s (#990): a full path,
// as text, with nothing hidden in it and nothing to resolve. Moved out of server/projects.mjs.

import { isAbsolute } from 'node:path';
import { hasInvisible, INVISIBLE } from '../shared/invisible.mjs';
import { httpError } from './helpers.mjs';

// A control character (C0, DEL or C1), NUL included: none belongs in a folder’s path.
const CONTROL = /\p{Cc}/u;
// Every one of them, to show each as its escape (shownFolder).
const CONTROL_ALL = /\p{Cc}/gu;
// A lone surrogate (Cs) isn’t text. The characters that change how a path displays, or display as nothing, are the
// ones an asset name refuses (shared/invisible.mjs), except ZWNJ and ZWJ (U+200C, U+200D): they join letters in some
// scripts and in emoji, and the folder exists under the name the person gave it.
const SURROGATE = /\p{Cs}/u;
const JOINERS = /[\u200c\u200d]/gu;
/** Whether a folder's path holds a character that isn't text, or one that hides or reorders what it shows. @param {string} s */
const hidden = (s) => SURROGATE.test(s) || hasInvisible(s.replace(JOINERS, ''));
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
 * A project’s folder as the person wrote it: a full path, as text, of at most MAX_FOLDER characters, with no control
 * or hidden character and no empty, `.` or `..` part, so no `//`; `/` itself is taken. One `/` at its end, which a
 * shell’s tab completion adds, is dropped. It bounds the file picker and is where the project’s agents start, so
 * anything else is refused rather than normalized or resolved against the folder Postbox was started from (#547).
 * @param {unknown} folder @param {string} [whose]  whose folder it is, in the message for one that isn’t text
 * @returns {string}
 */
export function fullPath(folder, whose = 'A project’s') {
  if (folder === undefined || folder === null || (typeof folder === 'string' && !folder.trim())) throw httpError(422, 'Write the folder’s full path.');
  if (typeof folder !== 'string') throw httpError(422, `${whose} folder is its full path, as text. Write the folder’s full path.`);
  if (folder.length > MAX_FOLDER) throw httpError(422, `A folder’s path is at most ${MAX_FOLDER} characters. Pick a folder with a shorter path.`);
  if (CONTROL.test(folder)) throw httpError(422, 'A folder’s path can’t contain control characters, such as a new line. Write the folder’s full path.');
  if (hidden(folder))
    throw httpError(
      422,
      'A folder’s path can’t contain invisible characters, such as a zero-width space or a bidi control, or a lone surrogate. Write the folder’s full path.',
    );
  if (!isAbsolute(folder)) throw httpError(422, 'Write the folder’s full path, starting with /. Postbox doesn’t guess where a relative one is.');
  const path = folder !== '/' && folder.endsWith('/') && !folder.endsWith('//') ? folder.slice(0, -1) : folder;
  if (hasOddPart(path))
    throw httpError(422, 'A folder’s path can’t have an empty, . or .. part, such as //, /./ or /../. Write the folder’s full path without them.');
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

// The longest a folder is shown in a message, before it’s cut: a refused one can be any length.
const SHOWN = 200;

/**
 * A folder for a message: quoted, with a control or invisible character as its escape, so it can’t hide or reorder
 * the text around it, and cut short when long. One that isn’t text shows as JSON.
 * @param {unknown} folder
 */
export function shownFolder(folder) {
  const asEscape = (c) => {
    const code = /** @type {number} */ (c.codePointAt(0)).toString(16);
    return code.length > 4 ? `\\u{${code}}` : `\\u${code.padStart(4, '0')}`;
  };
  const shown = String(JSON.stringify(folder)).replace(CONTROL_ALL, asEscape).replace(INVISIBLE, asEscape);
  return shown.length > SHOWN ? `${shown.slice(0, SHOWN)}…` : shown;
}
