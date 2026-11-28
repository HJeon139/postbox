// The Postbox checkout’s own steering, kept from an agent whose folder is in Postbox’s data folder (#319). A clone
// whose data/ holds a store uses it as the data folder (server/home.mjs, dataFolder), so an agent with no folder of its
// own works in <clone>/data/workspaces/<handle>, and a project made there sits in <clone>/data too. Claude Code loads
// every AGENTS.md from its folder up to the filesystem root, so such an agent started with Postbox’s developer rules.
// Only the files from the checkout, the Postbox repository the data folder is in, down to the data folder’s parent are kept
// from it: one in the data folder or in the agent’s own folder is the person’s, and a project whose folder is the
// checkout itself, someone developing Postbox, isn’t under the data folder and keeps them. Claude Code’s claudeMdExcludes applies to AGENTS.md too, and the
// checkout’s CLAUDE.md files, which none ship today, go with it
// (tools/uat/steering.mjs does the same for a UAT run’s workspaces, #316).

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * The steering files Claude Code reads from a folder as project memory: AGENTS.md and CLAUDE.md, in it and in its
 * .claude folder, and CLAUDE.local.md. The rules in .claude/rules are listed file by file (rulesIn).
 */
const STEERING = ['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md', join('.claude', 'AGENTS.md'), join('.claude', 'CLAUDE.md')];

/**
 * The files in a folder’s .claude/rules, by path. claudeMdExcludes matches with picomatch, so a glob under the
 * checkout’s path would read a name such as “postbox (copy)” as glob syntax and match nothing; a path that names a
 * file matches itself. @param {string} dir
 */
function rulesIn(dir) {
  const rules = join(dir, '.claude', 'rules');
  try {
    return readdirSync(rules, { recursive: true }).map((f) => join(rules, String(f)));
  } catch {
    return [];
  }
}

/** Whether `inner` is `outer` or a folder inside it. @param {string} inner @param {string} outer */
const within = (inner, outer) => {
  const rel = relative(outer, inner);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
};

/** A path as given and, when it exists, through its links. @param {string} p */
function spellings(p) {
  try {
    return [...new Set([resolve(p), realpathSync.native(p)])];
  } catch {
    return [resolve(p)];
  }
}

/**
 * The Postbox checkout a folder is in: the nearest folder at or above it with a .git, when its package.json names
 * Postbox; else null. A home folder kept in git, holding ~/.postbox, isn’t a checkout, and its AGENTS.md is the person’s.
 * @param {string} dir
 */
function checkoutOf(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return isPostbox(d) ? d : null;
    if (d === dirname(d)) return null;
  }
}

/** Whether a folder’s package.json names Postbox. @param {string} dir */
function isPostbox(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'postbox';
  } catch {
    return false;
  }
}

/**
 * Whether an agent in `folder` works in Postbox’s data folder while that folder is inside a Postbox checkout (a
 * clone’s data/), by each path as given or through its links: the one case whose agents are kept from the checkout’s
 * own steering. A data folder in no repository (~/.postbox), or a folder outside the data folder, isn’t it (#319).
 * @param {string} folder @param {string} dataDir
 */
export function inCheckoutData(folder, dataDir) {
  return spellings(dataDir).some((data) => checkoutOf(dirname(data)) !== null && spellings(folder).some((f) => within(f, data)));
}

/**
 * The checkout’s steering files an agent in `folder` mustn’t load, as claudeMdExcludes: those from the repository the
 * data folder is in, a clone, down to the data folder’s parent. None when the folder isn’t in the data folder, or the
 * data folder is in no repository (~/.postbox), each by its path as given or through its links.
 * @param {string} folder  the agent’s working folder @param {string} dataDir  Postbox’s data folder
 * @returns {string[]}
 */
export function checkoutSteering(folder, dataDir) {
  const out = new Set();
  for (const data of spellings(dataDir)) {
    const root = checkoutOf(dirname(data));
    if (!root || !spellings(folder).some((f) => within(f, data))) continue;
    // The checkout is above the data folder (checkoutOf walked up to it), so the walk ends there.
    for (let dir = dirname(data); ; dir = dirname(dir)) {
      for (const f of STEERING) out.add(join(dir, f));
      for (const f of rulesIn(dir)) out.add(f);
      if (dir === root) break;
    }
  }
  return [...out];
}

/**
 * A turn’s settings with those steering files excluded, beside any it excluded already; as they were with none.
 * @param {Record<string, any>} settings @param {string[]} excludes
 */
export const withSteering = (settings, excludes) =>
  excludes.length ? { ...settings, claudeMdExcludes: [...new Set([...(settings.claudeMdExcludes ?? []), ...excludes])] } : settings;
