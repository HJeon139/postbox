// Every file a command names (#852): a command the person confirmed runs once, as written, but a script it runs or a
// body file it sends could change between the card and the run. Postbox hashes each file the command names when the
// person confirms it, and runs it only while every hash still holds. A part the reader can’t be sure of refuses when
// it could name a file, rather than leave one out; a part that can’t name one (echo $(date)) is no file.
//
// A file is named by:
// - the script operand of a shell or an interpreter (bash a.sh, python3 -u b.py, source c.sh, . d.sh);
// - a command word that is a path (./run.sh, ../x, /usr/local/bin/y);
// - gh’s body and input files: --body-file f, --input f, and a field read from a file, -F k=@f or --field k=@f
//   (--raw-field never reads one);
// - a redirect from a file, < f.

import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { splitCommand } from '../shared/command-chains.mjs';
import { words } from './adapters/agy-auto.mjs';

// Commands whose first operand is a file they run.
const RUNNERS = new Set(['bash', 'sh', 'zsh', 'node', 'python', 'python3', 'source', '.']);
// Options whose value is a file, given as --x f or --x=f.
const FILE_OPTIONS = new Set(['--body-file', '--input']);
// Options whose value may read a file, as k=@f.
const FIELD_OPTIONS = new Set(['-F', '-f', '--field']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// A redirect from a file: < and a quoted or plain path. Not <<, <( nor <& and <>, which aren’t a file read here.
const REDIRECT = /(^|\s)0?<(?![<&(>])\s*('[^']*'|"[^"$`\\]*"|[^\s'"$`\\<>()|;&]+)(?=\s|$)/g;
// What makes a part that the reader can’t read one that might name a file.
const MIGHT_NAME = /--body-file|--input|@|</;

/** @typedef {{ ok: true, files: string[] } | { ok: false, why: string }} Named */

/** A redirect’s path, without its quotes. @param {string} token */
const unquote = (token) => (/^['"]/.test(token) ? token.slice(1, -1) : token);

/** The words that come before the command word: VAR=x assignments. @param {string[]} list */
function commandAt(list) {
  let at = 0;
  while (at < list.length && ASSIGNMENT.test(list[at])) at++;
  return at;
}

/** The paths one option names, from the word at i on: the value and, when it’s separate, how many words it used. */
function optionFile(list, i) {
  const word = list[i];
  const eq = word.indexOf('=');
  const name = word.startsWith('--') && eq > 0 ? word.slice(0, eq) : word;
  if (FILE_OPTIONS.has(name)) return eq > 0 && name !== word ? word.slice(eq + 1) : list[i + 1];
  const field = fieldValue(list, i);
  if (field === null) return null;
  const read = field.indexOf('=@');
  return read >= 0 ? field.slice(read + 2) : null;
}

/** A field option’s k=v, whether written -F k=v, -Fk=v, --field k=v or --field=k=v; null for any other word. */
function fieldValue(list, i) {
  const word = list[i];
  if (FIELD_OPTIONS.has(word)) return list[i + 1] ?? '';
  if (word.startsWith('--field=')) return word.slice('--field='.length);
  if (/^-[Ff]./.test(word)) return word.slice(2);
  return null;
}

/** The files one part names, as written, or null when the part can’t be read and might name one. @param {string} part */
function partFiles(part) {
  /** @type {string[]} */
  const found = [];
  const rest = part.replace(REDIRECT, (_, lead, token) => {
    found.push(unquote(token));
    return lead;
  });
  const list = words(rest);
  if (list === null) return mightName(rest) ? null : [];
  const at = commandAt(list);
  const command = list[at] ?? '';
  if (/^(?:\.\.?\/|\/)/.test(command)) found.push(command);
  if (RUNNERS.has(command)) {
    const operand = list.slice(at + 1).find((w) => !w.startsWith('-') || w === '-');
    if (operand !== undefined) found.push(operand);
  }
  for (let i = at; i < list.length; i++) {
    const file = optionFile(list, i);
    if (file !== null && file !== undefined) found.push(file);
  }
  return found;
}

/** Whether a part the reader can’t read might name a file. @param {string} part */
function mightName(part) {
  if (MIGHT_NAME.test(part)) return true;
  const list = part.trim().split(/\s+/);
  const command = list[commandAt(list)] ?? '';
  return RUNNERS.has(command) || /^(?:\.\.?\/|\/)/.test(command);
}

/**
 * Every file a command names, each as its real absolute path, or why it can’t tell.
 * @param {string} command @param {string|null} folder the folder it runs in, an absolute path @returns {Named}
 */
export function namedFiles(command, folder) {
  /** @type {Set<string>} */
  const files = new Set();
  for (const part of splitCommand(command)) {
    const found = partFiles(part);
    if (found === null) return { ok: false, why: `Postbox can’t read “${part}” well enough to know which files it uses.` };
    for (const file of found) {
      if (file === '-' || file === '') return { ok: false, why: `“${part}” reads its input, not a file Postbox can check.` };
      if (!isAbsolute(file) && folder === null) return { ok: false, why: `“${file}” is relative, and the command has no folder.` };
      try {
        files.add(realpathSync(resolve(folder ?? '/', file)));
      } catch {
        return { ok: false, why: `Postbox can’t find “${file}”, which “${part}” uses.` };
      }
    }
  }
  return { ok: true, files: [...files] };
}

/** @typedef {{ path: string, sha256: string }} Hashed */

/**
 * Each file’s real path and the sha256 of its bytes, or why one can’t be read.
 * @param {string[]} paths @returns {Promise<{ ok: true, files: Hashed[] } | { ok: false, why: string }>}
 */
export async function hashFiles(paths) {
  /** @type {Hashed[]} */
  const files = [];
  for (const path of paths) {
    try {
      const real = await realpath(path);
      const sha256 = createHash('sha256')
        .update(await readFile(real))
        .digest('hex');
      files.push({ path: real, sha256 });
    } catch {
      return { ok: false, why: `Postbox can’t read “${path}”.` };
    }
  }
  return { ok: true, files };
}

/** Whether every file still has the hash it had. @param {Hashed[]} recorded */
export async function sameFiles(recorded) {
  const now = await hashFiles(recorded.map((f) => f.path));
  if (!now.ok || now.files.length !== recorded.length) return false;
  return recorded.every((f, i) => now.files[i].path === f.path && now.files[i].sha256 === f.sha256);
}
