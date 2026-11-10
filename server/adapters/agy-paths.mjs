// Where an Antigravity file call’s paths lead, for its PreToolUse hook (agy-hook.mjs). Moved from agy-hook.mjs, which
// is at its size ceiling (designs/architecture.md, “Module and function size”).

import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

/**
 * Resolves a path as the file system does, one segment at a time through the real path of each one that exists, so
 * symlinks can’t escape a folder, and a .. after a link climbs from where the link leads, not lexically (#1074). The
 * part that doesn’t exist yet is kept as written. Only the path agy names is trimmed, and a blank one names nothing.
 */
export function realTarget(rawPath, baseDir = process.cwd()) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  return walk(rawPath.trim(), baseDir, { followed: 0 });
}

/**
 * Walks a path exactly as written, spaces included, since a link’s target is never trimmed by the file system (#1134).
 * @param {string} path @param {string} baseDir @param {{ followed: number }} links counted for the whole path
 */
function walk(path, baseDir, links) {
  let cur = realOr(isAbsolute(path) ? parse(path).root : resolve(baseDir), links);
  for (const segment of path.split(sep)) {
    if (links.followed > MAX_LINKS) break; // gave up: the kernel fails the whole path, so nothing after it counts
    if (!segment || segment === '.') continue;
    cur = segment === '..' ? dirname(cur) : realOr(join(cur, segment), links);
  }
  return cur;
}

/** How many links one path may follow before the walk gives up. Like the kernel’s own limit, it counts the whole path (#1134). */
const MAX_LINKS = 40;

/**
 * A path’s real path. One that doesn’t exist yet, as a file about to be written, is kept as written, unless it is a
 * link whose target doesn’t exist: then it’s where the link leads, since a write through it creates that target, wherever
 * it points (#1134). A chain of such links is followed to its end; past MAX_LINKS, as a loop goes, it gives up as the
 * outside path “/”, so it asks.
 * @param {string} p @param {{ followed: number }} links
 */
function realOr(p, links) {
  try {
    return realpathSync(p);
  } catch {
    let link;
    try {
      link = lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null;
    } catch {
      link = null;
    }
    if (link === null) return p; // doesn’t exist yet, and isn’t a link: nothing to follow
    links.followed += 1;
    if (links.followed > MAX_LINKS) return parse(p).root;
    // The target is walked as any path is, so a link on its way is followed too; p’s own folder is already real.
    return walk(link, dirname(p), links);
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
export function pathArgs(args) {
  const named = (/** @type {unknown} */ v) => v !== undefined && v !== null;
  const blank = (/** @type {unknown} */ v) => typeof v === 'string' && !v.trim();
  return PATH_FIELDS.map((k) => args?.[k]).filter((v) => named(v) && !blank(v));
}

/**
 * A path as a card names it: its . segments and doubled separators dropped, which never change where it leads, so a
 * run of ./ can’t push the call’s other paths off the card (#1074). Its .. stay: after a link, one climbs from where
 * the link leads (realTarget), so dropping one with the segment before it could name another place.
 * @param {string} raw
 */
export function tidyPath(raw) {
  const p = raw.trim();
  const root = isAbsolute(p) ? parse(p).root : '';
  const kept = p
    .slice(root.length)
    .split(sep)
    .filter((s) => s && s !== '.');
  const trailing = kept.length && p.endsWith(sep) ? sep : '';
  return `${root}${kept.join(sep)}${trailing}` || '.';
}

/** A ~ path’s home: ~ alone, or ~ and a name, as ~root/.ssh names root’s, whose home Postbox can’t know (#1074). */
const TILDE = /^~[^\\/]*/;
/** Whether a path starts at another person’s home by name, as ~root/.ssh does: ~ and a name, not ~ or ~/. */
const othersHome = (/** @type {string} */ p) => (TILDE.exec(p.trim())?.[0].length ?? 0) > 1;

/**
 * The places a path may name, absolute but with its .. kept for realTarget: from cwd, and for one that starts with ~,
 * from home too, since whether agy expands ~ is unproved (#1074). A ~user path is read from this home as well, as it
 * may name it, so one protected there is refused. A call is allowed only when every one is, and refused when any is
 * protected.
 * @param {string} raw @param {string} cwd @param {string} home
 */
export function readingsOf(raw, cwd, home) {
  const p = raw.trim();
  const fromCwd = isAbsolute(p) ? p : `${cwd}${sep}${p}`;
  const tilde = TILDE.exec(p);
  return tilde ? [fromCwd, `${home}${p.slice(tilde[0].length)}`] : [fromCwd];
}

/**
 * Where one absolute reading of a path really leads, both ways a .. may be read: as the file system climbs from where a
 * link leads (realTarget), and as text first (resolve), since whether agy normalizes a path before using it is as
 * unproved as ~ (#1074). Every guard that turns a path into inside, in .git or protected reads both, here.
 * @param {string} at @returns {string[]}
 */
export const realReadings = (at) => [realTarget(at, '/'), realTarget(resolve(at), '/')].filter((r) => r !== null);

/**
 * Whether a path leads into one of the folders, by its real path, every way it may be read (readingsOf, realReadings).
 * A ~user path never does: its home could be anywhere, so it asks, as Auto’s routine commands refuse one (agy-auto.mjs,
 * staysIn).
 * @param {string} raw @param {string[]} dirs @param {{ cwd: string, home: string }} where
 */
export const leadsInto = (raw, dirs, { cwd, home }) =>
  !othersHome(raw) &&
  readingsOf(raw, cwd, home).every((at) => {
    const reals = realReadings(at);
    return reals.length === 2 && reals.every((real) => dirs.some((d) => inside(real, d)));
  });
