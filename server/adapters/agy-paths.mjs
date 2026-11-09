// Where an Antigravity file call’s paths lead, for its PreToolUse hook (agy-hook.mjs). Moved from agy-hook.mjs, which
// is at its size ceiling (designs/architecture.md, “Module and function size”).

import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** Resolves a path through the real path of its nearest existing ancestor, so symlinks can’t escape a folder. */
export function realTarget(rawPath, baseDir = process.cwd()) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return null;
  const abs = resolve(baseDir, rawPath.trim());
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  try {
    const real = realpathSync(cur);
    const tail = relative(cur, abs);
    return tail ? join(real, tail) : real;
  } catch {
    return abs;
  }
}

export const inside = (target, dir) => Boolean(target && dir && (target === dir || target.startsWith(`${dir}${sep}`)));
export const pathArg = (args) =>
  args?.Path ?? args?.TargetFile ?? args?.AbsolutePath ?? args?.DirectoryPath ?? args?.SearchPath ?? args?.SearchDirectory ?? null;
