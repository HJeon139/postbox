// Where an Antigravity file call’s paths lead, for its PreToolUse hook (agy-hook.mjs). Moved from agy-hook.mjs, which
// is at its size ceiling (designs/architecture.md, “Module and function size”).

import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

/**
 * Resolves a path as the file system does, one segment at a time through the real path of each one that exists, so
 * symlinks can’t escape a folder, and a .. after a link climbs from where the link leads, not lexically (#1074). The
 * part that doesn’t exist yet is kept as written.
 */
export function realTarget(rawPath, baseDir = process.cwd()) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const raw = rawPath.trim();
  let cur = realOr(isAbsolute(raw) ? parse(raw).root : resolve(baseDir));
  for (const segment of raw.split(sep)) {
    if (!segment || segment === '.') continue;
    cur = segment === '..' ? dirname(cur) : realOr(join(cur, segment));
  }
  return cur;
}

/** A path’s real path, or the path itself when it doesn’t exist (or can’t be read), so it’s judged as written. */
function realOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return p; // doesn’t exist yet, as a file about to be written: nothing to follow
  }
}

export const inside = (target, dir) => Boolean(target && dir && (target === dir || target.startsWith(`${dir}${sep}`)));
/** agy’s names for a file tool’s paths (recorded: read_file’s Path, view_file’s AbsolutePath, write_to_file’s TargetFile). */
export const PATH_FIELDS = Object.freeze(['Path', 'TargetFile', 'AbsolutePath', 'DirectoryPath', 'SearchPath', 'SearchDirectory']);

/**
 * Every path a file call names, in PATH_FIELDS’ order: one call can name two, as { Path, SearchPath }, and each is
 * judged (#1074). A blank one names nothing; a value that isn’t a string is kept, so the call is judged unreadable.
 * @param {any} args @returns {unknown[]}
 */
export const pathArgs = (args) => PATH_FIELDS.map((k) => args?.[k]).filter((v) => v !== undefined && v !== null && !(typeof v === 'string' && !v.trim()));

/**
 * Whether a path leads into one of the folders, by its real path.
 * @param {string} raw @param {string[]} dirs @param {{ cwd: string }} where
 */
export const leadsInto = (raw, dirs, { cwd }) => {
  const real = realTarget(raw, cwd);
  return dirs.some((d) => inside(real, d));
};
