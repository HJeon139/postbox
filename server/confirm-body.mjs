// The file a confirmed `gh pr|issue … --body-file <path>` posts (#852). The command shows only the file’s path, so the
// confirm shows the file too: read here from the agent’s places only (its folder, its project’s, or a temp folder of
// this user’s), through links, as UTF-8 text of at most 64 KB, and kept on the item with its SHA-256, so what runs
// can be checked against what the person read (bodyStillSame).

import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, sep } from 'node:path';
import { splitCommand } from '../shared/command-chains.mjs';
import { confirmShape } from '../shared/confirm-shapes.mjs';
import { words } from './adapters/agy-auto.mjs';
import { pushConsequence, pushOf } from './push-on-request.mjs';

/** The most a body file may hold, in bytes, and how many of its lines the confirm keeps. */
export const BODY_MAX = 64 * 1024;
export const BODY_LINES = 40;

/** @typedef {{ path: string, real: string, sha256: string, size: number, text: string }} BodyFile */

/**
 * The paths a command’s body-file options name: `--body-file <path>` or `--body-file=<path>`, and `-F <path>` in
 * gh pr and gh issue, where it means the same. unclear is set where Postbox can’t read the command’s words, or an
 * option has no value, so the confirm is refused rather than shown without its file.
 * @param {string} command @returns {{ paths: string[], unclear: boolean }}
 */
function bodyOptions(command) {
  /** @type {string[]} */
  const paths = [];
  let unclear = false;
  for (const part of splitCommand(command)) {
    const w = words(part);
    if (!w) {
      unclear ||= /--body-file|\s-F\b/.test(part);
      continue;
    }
    const ghBody = w[0] === 'gh' && (w[1] === 'pr' || w[1] === 'issue');
    w.forEach((word, i) => {
      if (word.startsWith('--body-file=')) paths.push(word.slice('--body-file='.length));
      else if (word === '--body-file' || (ghBody && word === '-F')) {
        if (i + 1 < w.length) paths.push(w[i + 1]);
        else unclear = true;
      }
    });
  }
  return { paths, unclear };
}

/**
 * The file a command posts with --body-file, or null when it names none.
 * @param {string} command @returns {string | null}
 */
export function bodyFileOf(command) {
  return bodyOptions(command).paths[0] ?? null;
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const inside = (real, place) => real === place || real.startsWith(`${place}${sep}`);
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * A body file, read from inside one of places, or why it can’t be.
 * @param {string} path  as the command names it @param {string[]} places  absolute folders, as real paths
 * @returns {Promise<{ ok: true, file: BodyFile } | { ok: false, why: string }>}
 */
export async function readBodyFile(path, places) {
  if (!isAbsolute(path)) return { ok: false, why: `The body file “${path}” isn’t an absolute path. Name it from the root, such as /tmp/…/body.md.` };
  /** @type {string} */
  let real;
  try {
    real = await realpath(path);
  } catch (e) {
    return { ok: false, why: `Postbox couldn’t find the body file “${path}” (${/** @type {any} */ (e)?.code ?? e}). Write it, then show the block again.` };
  }
  if (!places.some((place) => inside(real, place)))
    return { ok: false, why: `The body file “${path}” is outside your folders. Write it in your folder or your project’s, then show the block again.` };
  const info = await lstat(real);
  if (!info.isFile()) return { ok: false, why: `The body file “${path}” isn’t a regular file. Name the file the command posts.` };
  if (info.size > BODY_MAX) return { ok: false, why: `The body file “${path}” is over 64 KB. Make it shorter.` };
  const bytes = await readFile(real);
  if (bytes.length > BODY_MAX) return { ok: false, why: `The body file “${path}” is over 64 KB. Make it shorter.` };
  /** @type {string} */
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return { ok: false, why: `The body file “${path}” isn’t UTF-8 text. Save it as UTF-8.` };
  }
  return { ok: true, file: { path, real, sha256: sha256(bytes), size: bytes.length, text } };
}

/**
 * Whether a body file is still the one the person read: the same real path, with the same bytes. Unreadable is false.
 * @param {Pick<BodyFile, 'path' | 'real' | 'sha256'>} file @returns {Promise<boolean>}
 */
export async function bodyStillSame(file) {
  try {
    const real = await realpath(file.path);
    return real === file.real && sha256(await readFile(real)) === file.sha256;
  } catch {
    return false; // gone or unreadable: not the file the person read
  }
}

/** A real path, or null where there’s none to have. @param {string | null | undefined} p */
const realOrNull = async (p) => (p ? realpath(p).catch(() => null) : null);

/**
 * Where a session’s body files may be: its own folder, its project’s, and the folder in the system temp folder the
 * file is in, when this user made it (a temp folder of another user’s could hold anything).
 * @param {any} rt @param {string} sessionId @param {string} path
 * @returns {Promise<string[]>}
 */
async function placesFor(rt, sessionId, path) {
  const { folder, project } = await rt.panelTarget({ sessionId });
  const places = await Promise.all([realOrNull(folder), realOrNull(project?.folder)]);
  const tmp = await realOrNull(tmpdir());
  const real = await realOrNull(path);
  if (tmp && real?.startsWith(`${tmp}${sep}`)) {
    const child = `${tmp}${sep}${real.slice(tmp.length + 1).split(sep)[0]}`;
    const info = child === real ? null : await stat(child).catch(() => null);
    if (info?.isDirectory() && info.uid === process.getuid?.()) places.push(child);
  }
  return /** @type {string[]} */ (places.filter(Boolean));
}

/** The first BODY_LINES lines of a text, and how many it has (a last new line ends a line; it starts none). */
function cut(text) {
  const all = text.split('\n');
  if (all.at(-1) === '') all.pop();
  return { text: all.length > BODY_LINES ? all.slice(0, BODY_LINES).join('\n') : text, lines: all.length };
}

/**
 * The body files a show_block or update_block confirm posts, read before the tool runs, as the item keeps them, or
 * why the block is refused. Any other call has none.
 * @param {any} rt @param {string} sessionId @param {string} name  the tool @param {any} args
 * @returns {Promise<{ ok: true, bodyFiles?: any[] } | { ok: false, why: string }>}
 */
export async function confirmBodies(rt, sessionId, name, args) {
  const block = args?.block;
  if ((name !== 'show_block' && name !== 'update_block') || block?.type !== 'confirm' || !Array.isArray(block.commands)) return { ok: true };
  const bodyFiles = [];
  for (const [index, command] of block.commands.entries()) {
    if (typeof command !== 'string') continue; // the catalog refuses it
    const shape = confirmShape(command);
    const pinned = await pinShape(rt, sessionId, shape, command, index);
    if (!pinned.ok) return pinned;
    if (pinned.entry) bodyFiles.push(pinned.entry);
    const { paths, unclear } = bodyOptions(command);
    if (unclear || paths.length > 1)
      return { ok: false, why: `Postbox can’t tell which one file command ${index + 1}’s --body-file posts. Name one file, as --body-file /path/to/body.md.` };
    if (!paths.length) continue;
    const read = await readBodyFile(paths[0], await placesFor(rt, sessionId, paths[0]));
    if (!read.ok) return read;
    bodyFiles.push({ command: index, ...read.file, ...cut(read.file.text) });
  }
  return { ok: true, bodyFiles };
}

/**
 * Show_block’s and update_block’s refusal of a confirm whose body files weren’t read before it (a call that didn’t
 * come through confirmBodies), or null. It fails closed: the person would confirm a post they never saw.
 * @param {any} block  as the catalog passed it @param {any[] | undefined} bodyFiles
 */
export function unreadBody(block, bodyFiles) {
  if (block.type !== 'confirm' || !block.commands?.length) return null;
  const read = (command, index) => {
    const { paths, unclear } = bodyOptions(command);
    if (unclear) return false;
    return paths.every((path) => bodyFiles?.some((f) => f.command === index && f.path === path));
  };
  if (block.commands.every(read)) return null;
  return 'Postbox didn’t read the file this confirm’s --body-file posts, so it can’t show the person what it posts. Show it through Postbox’s MCP tools from this computer.';
}

/** The project’s GitHub repository, as `owner/name` from the push URL the person set, or null for any other host. */
export function subjectRepo(url) {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url ?? ''));
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/**
 * What a confirm’s command is tied to when it’s shown (critic’s read of r3): a gh shape’s `--repo` must be the
 * project’s GitHub repository; a push is pinned to the commit, branch and repository it would land, as the person
 * sees it under the command, and the call is refused if any has changed (confirm-grant.mjs).
 * @returns {Promise<{ ok: true, entry?: any } | { ok: false, why: string }>}
 */
async function pinShape(rt, sessionId, shape, command, index) {
  if (shape.kind === 'none') return { ok: true };
  const { folder, project } = await rt.panelTarget({ sessionId });
  if (shape.kind === 'gh') {
    const repo = subjectRepo(project?.pushUrl);
    if (repo && repo === shape.repo.toLowerCase()) return { ok: true };
    return {
      ok: false,
      why: `Command ${index + 1} posts to ${shape.repo}, but this project’s repository is ${repo ?? 'not one on github.com'}. A confirm can post only to the project’s own repository.`,
    };
  }
  const push = await (rt.pushes?.consequence ?? pushConsequence)({ folder, url: project?.pushUrl, push: pushOf(command), named: command.toLowerCase() });
  if (!push)
    return { ok: false, why: `Postbox can’t make command ${index + 1}’s push: it needs the project’s repository set, and a branch with a commit to push.` };
  return { ok: true, entry: { command: index, push: { branch: push.branch, sha: push.sha, url: push.url, sentence: push.sentence } } };
}
