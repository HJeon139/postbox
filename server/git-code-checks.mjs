// Whether a repository runs its own code (#852): git runs a hook, a program a config key names, or a filter or driver
// an attribute picks, and each of those is a file the repository holds or a command its config holds. A git command
// there runs more than the person can read on its card, so Postbox checks first, reading files only and never running
// git. A .git file (a linked worktree or a submodule) points at config elsewhere, so it fails too.

import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * Config keys that name a program git runs, by their full lowercase name (section.subsection.key).
 * @type {{ name: string, test: RegExp }[]}
 */
export const RUNS_CODE = [
  { name: '*.command', test: /\.command$/ },
  { name: '*program', test: /program$/ },
  { name: '*helper', test: /helper$/ },
  { name: '*cmd', test: /cmd$/ },
  { name: 'pager.*', test: /^pager\./ },
  { name: '*uploadpack', test: /uploadpack$/ },
  { name: '*receivepack', test: /receivepack$/ },
  { name: 'core.fsmonitor', test: /^core\.fsmonitor$/ },
  { name: 'core.editor', test: /^core\.editor$/ },
  { name: 'core.pager', test: /^core\.pager$/ },
  { name: 'core.hookspath', test: /^core\.hookspath$/ },
  { name: 'core.sshcommand', test: /^core\.sshcommand$/ },
  { name: 'core.askpass', test: /^core\.askpass$/ },
  { name: 'diff.external', test: /^diff\.external$/ },
  { name: 'sequence.editor', test: /^sequence\.editor$/ },
  { name: 'include*', test: /^include/ },
  { name: 'url.*.insteadof', test: /^url\..*\.insteadof$/ },
  { name: 'url.*.pushinsteadof', test: /^url\..*\.pushinsteadof$/ },
  { name: 'alias.*', test: /^alias\./ },
  { name: 'filter.*', test: /^filter\./ },
  { name: 'merge.*.driver', test: /^merge\..*\.driver$/ },
  { name: 'diff.*.textconv', test: /^diff\..*\.textconv$/ },
  { name: 'gpg.program', test: /^gpg\.program$/ },
  { name: 'gpg.ssh.program', test: /^gpg\.ssh\.program$/ },
  { name: 'credential.*', test: /^credential\./ },
];

// Attributes that send a file through a filter, a diff driver or a merge driver: set to a name, not unset (-diff).
const ATTRIBUTE = /^(?:filter|diff|merge)=/;
const SECTION = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](.*)$/;
const KEY = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=|$|[#;])/;

/** @typedef {{ ok: true } | { ok: false, why: string }} Checked */

/** The nearest folder at or above `folder` that holds a .git, or null. @param {string} folder */
async function repoRoot(folder) {
  let dir = folder;
  for (;;) {
    const found = await lstat(join(dir, '.git')).catch(() => null);
    if (found) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Reads a file, or '' when it isn’t there; any other error throws. @param {string} path */
async function readIfThere(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === 'ENOENT') return '';
    throw e;
  }
}

/** The first hook git would run, by name, or null. @param {string} hooks */
async function liveHook(hooks) {
  const names = await readdir(hooks).catch(() => []);
  for (const name of names) {
    if (name.endsWith('.sample')) continue;
    const found = await stat(join(hooks, name)).catch(() => null);
    if (found?.isFile() && found.mode & 0o111) return name;
  }
  return null;
}

/**
 * Every key a config sets, as section.subsection.key in lowercase, or a string saying which line it can’t read.
 * @param {string} text @returns {string[] | string}
 */
export function configKeys(text) {
  /** @type {string[]} */
  const keys = [];
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      const header = SECTION.exec(line);
      if (!header) return line;
      section = header[2] === undefined ? header[1] : `${header[1]}.${header[2]}`;
      line = header[3].trim();
      if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    }
    const key = KEY.exec(line);
    if (!key || section === '') return line;
    // A value continued onto the next line could hide a key there from one reader and not the other.
    if (/\\$/.test(line)) return line;
    keys.push(`${section}.${key[1]}`.toLowerCase());
  }
  return keys;
}

/** The first line of an attributes file that sets a filter or a driver, or null. @param {string} text */
function attributeLine(text) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (
      line
        .split(/\s+/)
        .slice(1)
        .some((attr) => ATTRIBUTE.test(attr))
    )
      return line;
  }
  return null;
}

/**
 * Whether the repository `folder` is in runs code of its own when git runs there.
 * @param {string} folder an absolute path @returns {Promise<Checked>}
 */
export async function repoRunsCode(folder) {
  const root = await repoRoot(folder);
  if (root === null) return { ok: false, why: `“${folder}” isn’t in a git repository.` };
  const git = join(root, '.git');
  if (!(await lstat(git)).isDirectory()) return { ok: false, why: `“${git}” isn’t a folder, so its config is somewhere else.` };
  const hook = await liveHook(join(git, 'hooks'));
  if (hook) return { ok: false, why: `The repository has a hook git runs, .git/hooks/${hook}.` };
  try {
    const keys = configKeys(await readIfThere(join(git, 'config')));
    if (typeof keys === 'string') return { ok: false, why: `Postbox can’t read this line of .git/config: “${keys}”.` };
    for (const key of keys) {
      const pattern = RUNS_CODE.find((p) => p.test.test(key));
      if (pattern) return { ok: false, why: `.git/config sets ${key}, which can name a program git runs (${pattern.name}).` };
    }
    for (const [name, path] of [
      ['.gitattributes', join(root, '.gitattributes')],
      ['.git/info/attributes', join(git, 'info', 'attributes')],
    ]) {
      const line = attributeLine(await readIfThere(path));
      if (line !== null) return { ok: false, why: `${name} sends files through a filter or driver: “${line}”.` };
    }
  } catch (e) {
    return { ok: false, why: `Postbox can’t read the repository’s settings: ${/** @type {Error} */ (e).message}` };
  }
  return { ok: true };
}
