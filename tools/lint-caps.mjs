// Checks that no change raises a length ceiling in biome.json (designs/architecture.md, “Module and function size: a
// ceiling that only comes down”). It compares biome.json with its copy at the merge base with main, and fails when a
// file or function ceiling goes up, when a file that already existed gets a ceiling, when a length rule or the linter
// is turned off, when a file is taken out of what Biome checks, when a Biome config other than the root one is added
// or changed, or when a biome-ignore for a length rule is added. With no base, it fails in CI and skips elsewhere. A
// new module's ceiling is allowed, since code moved out of a file at its ceiling may take one, and is listed for the
// reviewer. `npm run lint:project` runs it.
//
//   node tools/lint-caps.mjs            against origin/main, or origin/$BASE_REF when that is set (CI's check job sets
//                                       neither, so a pull request into another branch is compared with main)
//   node tools/lint-caps.mjs REF        against REF

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RULES = /** @type {const} */ ([
  ['file', 'style', 'noExcessiveLinesPerFile'],
  ['fn', 'complexity', 'noExcessiveLinesPerFunction'],
]);
const IGNORE = 'biome-ignore.*noExcessiveLines';

/** A rule's ceiling: Infinity when it is off, the default when it has no maxLines, undefined when it isn't set. */
function ruleCap(v, def) {
  if (v === undefined) return undefined;
  if (v === 'off' || v?.level === 'off') return Number.POSITIVE_INFINITY;
  return typeof v === 'object' && Number.isFinite(v.options?.maxLines) ? v.options.maxLines : def;
}

/**
 * The ceilings biome.json sets: the defaults, and each override's, by the path or glob it includes.
 * @param {any} biome
 */
export function ceilings(biome) {
  const off = biome.linter?.enabled === false;
  const rules = biome.linter?.rules ?? {};
  /** @type {Record<string, number>} */
  const defaults = {};
  for (const [k, group, rule] of RULES) defaults[k] = off ? Number.POSITIVE_INFINITY : (ruleCap(rules[group]?.[rule], 0) ?? 0);
  /** @type {Map<string, Record<string, number>>} */
  const paths = new Map();
  for (const o of biome.overrides ?? []) {
    /** @type {Record<string, number>} */
    const caps = {};
    for (const [k, group, rule] of RULES) {
      const cap = o.linter?.enabled === false ? Number.POSITIVE_INFINITY : ruleCap(o.linter?.rules?.[group]?.[rule], defaults[k]);
      if (cap !== undefined) caps[k] = cap;
    }
    if (Object.keys(caps).length) for (const p of o.includes ?? []) paths.set(p, { ...paths.get(p), ...caps });
  }
  return { defaults, paths, includes: biome.files?.includes ?? [], extends: JSON.stringify(biome.extends ?? []) };
}

/**
 * What a change to biome.json does to the ceilings: problems fail the check, notes are for the reviewer.
 * @param {ReturnType<typeof ceilings>} base @param {ReturnType<typeof ceilings>} head
 * @param {(path: string) => boolean} existed  whether a path was a file at the base
 */
export function capChanges(base, head, existed) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const notes = [];
  const name = { file: 'file', fn: 'function' };
  for (const [k] of RULES)
    if (head.defaults[k] > base.defaults[k]) problems.push(`The default ${name[k]} ceiling went up from ${base.defaults[k]} to ${head.defaults[k]}.`);
  for (const [path, caps] of head.paths) {
    for (const [k] of RULES) {
      const now = caps[k];
      const was = base.paths.get(path)?.[k];
      if (now === undefined || now <= (was ?? base.defaults[k])) continue;
      if (was !== undefined) problems.push(`${path}: its ${name[k]} ceiling went up from ${was} to ${now}.`);
      else if (path.includes('*') || existed(path))
        problems.push(`${path}: it gets a ${name[k]} ceiling of ${now}, over the default ${base.defaults[k]}, and it isn’t a new module.`);
      else notes.push(`${path}: a new module with a ${name[k]} ceiling of ${now}. Allowed only for code moved out of a file at its ceiling.`);
    }
  }
  if (head.extends !== base.extends) problems.push('biome.json’s extends changed.');
  for (const p of base.includes) if (!p.startsWith('!') && !head.includes.includes(p)) problems.push(`Biome no longer checks “${p}”.`);
  for (const p of head.includes) if (p.startsWith('!') && !base.includes.includes(p)) problems.push(`Biome no longer checks “${p.slice(1)}”.`);
  return { problems, notes };
}

/**
 * Biome configs other than the root biome.json that were added or changed: a nested one can turn a rule off for its
 * folder, and Biome then checks nothing there. The root one is compared rule by rule (capChanges).
 * @param {Map<string, string>} base @param {Map<string, string>} head  path → blob id
 */
export function configChanges(base, head) {
  return [...head]
    .filter(([p, id]) => p !== 'biome.json' && /(^|\/)biome\.jsonc?$/.test(p) && base.get(p) !== id)
    .map(([p]) => `A Biome config was added or changed: ${p}.`);
}

/**
 * The biome-ignore lines for a length rule that are new, as `path:text`: matched one for one against the base, so
 * removing one and adding another still counts as one added.
 * @param {string[]} base @param {string[]} head
 */
export function addedIgnores(base, head) {
  const left = new Map();
  for (const l of base) left.set(l, (left.get(l) ?? 0) + 1);
  return head.filter((l) => {
    const n = left.get(l) ?? 0;
    if (n) left.set(l, n - 1);
    return !n;
  });
}

const git = (/** @type {string[]} */ args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/**
 * What a run with no base to compare with does: in CI it fails, since that is a broken checkout and must not pass as a
 * clean guard; elsewhere it skips.
 * @param {string} ref @param {Record<string, string | undefined>} env
 */
export function noBase(ref, env) {
  return env.CI
    ? { code: 1, message: `lint-caps: failed, there is no ${ref} to compare with.` }
    : { code: 0, message: `lint-caps: skipped, there is no ${ref} to compare with.` };
}

const SKIP = [':!tools/lint-caps.mjs', ':!tests/lint-caps.test.mjs'];

/** The biome-ignore lines for a length rule, as `path:text`, at a commit or (with none) in the working tree. */
function ignoreLines(rev) {
  try {
    const out = git(['grep', ...(rev ? [] : ['--untracked']), '-E', IGNORE, ...(rev ? [rev] : []), '--', ...SKIP]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => (rev ? l.slice(rev.length + 1) : l));
  } catch (e) {
    // git grep exits 1 when nothing matches; any other failure must not read as "no comments".
    if (/** @type {any} */ (e).status === 1) return [];
    throw e;
  }
}

/** Every Biome config's blob id, at a commit or (with none) in the working tree, untracked ones included. */
function configs(rev) {
  const isConfig = (/** @type {string} */ p) => /(^|\/)biome\.jsonc?$/.test(p);
  if (rev) {
    const rows = git(['ls-tree', '-r', rev]).split('\n').filter(Boolean);
    return new Map(
      rows
        .map((r) => r.split('\t'))
        .filter(([, p]) => isConfig(p))
        .map(([meta, p]) => [p, meta.split(' ')[2]]),
    );
  }
  const paths = git(['ls-files', '--cached', '--others', '--exclude-standard']).split('\n').filter(isConfig);
  return new Map(paths.map((p) => [p, git(['hash-object', p]).trim()]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ref = process.argv[2] ?? `origin/${process.env.BASE_REF || 'main'}`;
  let at = '';
  try {
    at = git(['merge-base', ref, 'HEAD']).trim();
  } catch {
    const r = noBase(ref, process.env);
    console.log(r.message);
    process.exit(r.code);
  }
  const files = new Set(git(['ls-tree', '-r', '--name-only', at]).split('\n'));
  const base = ceilings(JSON.parse(git(['show', `${at}:biome.json`])));
  const head = ceilings(JSON.parse(readFileSync(`${ROOT}biome.json`, 'utf8')));
  const { problems, notes } = capChanges(base, head, (p) => files.has(p));
  problems.push(...configChanges(configs(at), configs('')));
  for (const l of addedIgnores(ignoreLines(at), ignoreLines(''))) problems.push(`A biome-ignore for a length rule was added: ${l}`);
  for (const n of notes) console.log(`note: ${n}`);
  for (const p of problems) console.log(`✖ ${p}`);
  if (problems.length) {
    console.log(
      `\nlint-caps: ${problems.length} problem${problems.length === 1 ? '' : 's'}. A ceiling only comes down: move a concern into a module of its own instead (designs/architecture.md, “Module and function size: a ceiling that only comes down”).`,
    );
    process.exitCode = 1;
  } else console.log(`lint-caps: no ceiling raised since ${at.slice(0, 8)}.`);
}
