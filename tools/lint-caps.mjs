// Checks that no change loosens a length limit (designs/architecture.md, “Module and function size: a ceiling that
// only comes down”). It fails closed: biome.json is compared with its copy at the merge base with main, and every
// difference fails unless it is one of the few known to be safe:
// - a length rule's maxLines lowered, at the same level and with its other options unchanged;
// - an override removed, unless that raises a limit it held under the default;
// - a new override whose length rules, if any, are at a failing level with a maxLines at or under the default;
// - an includes list that only gains positive entries or loses `!` ones;
// - any change under a key that can't touch a length rule (FREE), or to a rule other than the two length rules.
// It also fails a Biome config other than the root one, added or changed, and an added suppression that covers a length
// rule. A suppression in a file git ignores isn't read, and Biome skips that file too. With no base, it fails in CI
// and skips elsewhere. `npm run lint:project` runs it.
//
//   node tools/lint-caps.mjs            against origin/main and upstream/main, whichever is newer (#786), or
//                                       origin/$BASE_REF when that is set (CI's check job sets neither, and has no
//                                       upstream, so a pull request into another branch is compared with main)
//   node tools/lint-caps.mjs REF        against REF

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isEntry } from './lint-lib.mjs';
import { baseRefs, comparedWith, mergeBase, noBase } from './merge-base.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LENGTH = /** @type {const} */ ({ style: ['file', 'noExcessiveLinesPerFile'], complexity: ['function', 'noExcessiveLinesPerFunction'] });
// The levels that fail the gate, which runs `biome check --error-on-warnings`.
const FAILS = new Set(['error', 'warn', 'on']);
// Keys whose changes can't touch a length rule, at the top and in an override.
const FREE = new Set(['$schema', 'formatter', 'javascript', 'json', 'css', 'graphql', 'html', 'grit', 'assist']);
// A suppression for every rule (`lint`), for the group of a length rule, or for a length rule itself, of any form.
const SUPPRESSION = /biome-ignore(?:-all|-start|-end)?\s+(?:[^:\n]*\s)?lint(?:\/(?:style|complexity)(?:\/noExcessiveLines\w*)?)?(?=[\s:(),]|$)/;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keys = (/** @type {any} */ a, /** @type {any} */ b) => [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
const level = (/** @type {any} */ v) => (typeof v === 'string' ? v : v?.level);
const options = (/** @type {any} */ v) => (typeof v === 'object' && v ? (v.options ?? {}) : {});

/** A rule's ceiling: Infinity when its level doesn't fail the gate, the default with no maxLines, undefined when unset. */
function ruleCap(v, def) {
  if (v === undefined) return undefined;
  if (!FAILS.has(level(v))) return Number.POSITIVE_INFINITY;
  return Number.isFinite(options(v).maxLines) ? options(v).maxLines : def;
}

/**
 * The ceilings biome.json sets, for measuring them: the defaults, and each override's by its includes.
 * @param {any} biome
 */
export function ceilings(biome) {
  const rules = biome.linter?.rules ?? {};
  /** @type {Record<string, number>} */
  const defaults = {};
  for (const [group, [kind, rule]] of Object.entries(LENGTH)) defaults[kind] = ruleCap(rules[group]?.[rule], 0) ?? 0;
  /** @type {Map<string, Record<string, number>>} */
  const paths = new Map();
  for (const o of biome.overrides ?? []) {
    /** @type {Record<string, number>} */
    const caps = {};
    for (const [group, [kind, rule]] of Object.entries(LENGTH)) {
      const cap = ruleCap(o.linter?.rules?.[group]?.[rule], defaults[kind]);
      if (cap !== undefined) caps[kind] = cap;
    }
    if (Object.keys(caps).length) for (const p of o.includes ?? []) paths.set(p, { ...paths.get(p), ...caps });
  }
  return { defaults, paths };
}

/** An includes list may only gain positive entries or lose `!` ones, in the same order. A missing list is `**`. */
function includesChange(where, b = ['**'], h = ['**']) {
  if (
    !same(
      h.filter((p) => b.includes(p)),
      b.filter((p) => h.includes(p)),
    )
  )
    return [`${where} was reordered.`];
  return [
    ...b.filter((p) => !h.includes(p) && !p.startsWith('!')).map((p) => `${where} no longer has “${p}”.`),
    ...h.filter((p) => !b.includes(p) && p.startsWith('!')).map((p) => `${where} gained “${p}”.`),
  ];
}

/** One length rule: only a lower maxLines at the same level, or a new one at or under the default, passes. */
function lengthChange(where, b, h, def, top) {
  if (same(b, h)) return [];
  if (h === undefined) {
    if (top) return [`${where} was removed, which leaves no limit.`];
    return ruleCap(b, def) >= def ? [] : [`${where} was removed, which raises it to the default ${def}.`];
  }
  const max = options(h).maxLines;
  const strict = FAILS.has(level(h)) && Number.isFinite(max);
  // A new rule holds only a level and a maxLines: any other option, such as skipBlankLines, counts fewer lines.
  const bare = typeof h === 'object' && same(Object.keys(h).sort(), ['level', 'options']) && same(Object.keys(options(h)), ['maxLines']);
  if (b === undefined)
    return strict && bare && max <= def ? [] : [`${where} was added; a new one may hold only a failing level and a maxLines at or under the default ${def}.`];
  const sameRest = same({ ...options(b), maxLines: 0 }, { ...options(h), maxLines: 0 });
  if (strict && level(h) === level(b) && sameRest && max < (options(b).maxLines ?? def)) return [];
  return [`${where} went from ${JSON.stringify(b)} to ${JSON.stringify(h)}; only a lower maxLines passes.`];
}

/** `linter.rules`: the two length rules are checked, and their groups must stay lists of rules. */
function rulesChange(where, b = {}, h = {}, def, top) {
  return Object.entries(LENGTH).flatMap(([group, [kind, rule]]) => {
    const bg = b[group] ?? {};
    const hg = h[group] ?? {};
    if (typeof bg !== 'object' || typeof hg !== 'object') return same(bg, hg) ? [] : [`${where}: the ${group} group changed.`];
    return lengthChange(`${where}: its ${kind} length rule`, bg[rule], hg[rule], def[kind], top);
  });
}

/** A `linter` block, at the top or in an override: anything but its rules and includes must not change. */
function linterChange(where, b = {}, h = {}, def, top) {
  return keys(b, h).flatMap((k) => {
    if (k === 'rules') return rulesChange(where, b.rules, h.rules, def, top);
    if (k === 'includes') return includesChange(`${where}: linter.includes`, b.includes, h.includes);
    return same(b[k], h[k]) ? [] : [`${where}: linter.${k} changed.`];
  });
}

/** One override, matched to the base by its includes (b is undefined for a new one). */
function overrideChange(where, b, h, def) {
  return keys(b, h).flatMap((k) => {
    if (k === 'includes' || FREE.has(k)) return [];
    if (k === 'linter') return linterChange(where, b?.linter, h.linter, def, false);
    return same(b?.[k], h[k]) ? [] : [`${where}: “${k}” changed.`];
  });
}

/** The overrides: matched by their includes, kept in the same order, and each checked. */
function overridesChange(b = [], h = [], def) {
  const id = (/** @type {any} */ o) => JSON.stringify(o.includes ?? []);
  const bk = b.map(id);
  const hk = h.map(id);
  const out = [];
  if (new Set(hk).size !== hk.length) out.push('Two overrides have the same includes.');
  if (
    !same(
      hk.filter((k) => bk.includes(k)),
      bk.filter((k) => hk.includes(k)),
    )
  )
    out.push('The overrides were reordered.');
  b.forEach((o, i) => {
    if (!hk.includes(bk[i])) out.push(...overrideChange(bk[i], o, {}, def));
  });
  h.forEach((o, i) => {
    out.push(...overrideChange(hk[i], b[bk.indexOf(hk[i])], o, def));
  });
  return out;
}

/**
 * Every difference between two biome.json files that could loosen a length limit. Empty when it passes.
 * @param {any} base @param {any} head
 */
export function configDiff(base, head) {
  const def = ceilings(base).defaults;
  return keys(base, head).flatMap((k) => {
    if (FREE.has(k)) return [];
    if (k === 'overrides') return overridesChange(base.overrides, head.overrides, def);
    if (k === 'linter') return linterChange('biome.json', base.linter, head.linter, def, true);
    if (k === 'files')
      return keys(base.files, head.files).flatMap((f) =>
        f === 'includes'
          ? includesChange('files.includes', base.files?.includes, head.files?.includes)
          : same(base.files?.[f], head.files?.[f])
            ? []
            : [`files.${f} changed.`],
      );
    return same(base[k], head[k]) ? [] : [`biome.json: “${k}” changed.`];
  });
}

/**
 * Biome configs other than the root biome.json that were added or changed: a nested one can turn a rule off for its
 * folder. The root one is compared key by key (configDiff).
 * @param {Map<string, string>} base @param {Map<string, string>} head  path → blob id
 */
export function configChanges(base, head) {
  return [...head]
    .filter(([p, id]) => p !== 'biome.json' && /(^|\/)biome\.jsonc?$/.test(p) && base.get(p) !== id)
    .map(([p]) => `A Biome config was added or changed: ${p}.`);
}

/** The lines, as `path:text`, that hold a suppression covering a length rule. */
export const suppressions = (/** @type {string[]} */ lines) => lines.filter((l) => SUPPRESSION.test(l));

/**
 * The lines in head that aren't in base, matched one for one, so removing one and adding another counts as one added.
 * @param {string[]} base @param {string[]} head
 */
export function addedLines(base, head) {
  const left = new Map();
  for (const l of base) left.set(l, (left.get(l) ?? 0) + 1);
  return head.filter((l) => {
    const n = left.get(l) ?? 0;
    if (n) left.set(l, n - 1);
    return !n;
  });
}

const git = (/** @type {string[]} */ args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const SKIP = [':!tools/lint-caps.mjs', ':!tests/lint-caps.test.mjs'];

/** Lines with a Biome suppression, as `path:text`, at a commit or (with none) in the working tree, untracked included. */
function suppressionLines(rev) {
  try {
    const out = git(['grep', ...(rev ? [] : ['--untracked']), '-F', 'biome-ignore', ...(rev ? [rev] : []), '--', ...SKIP]);
    return suppressions(
      out
        .split('\n')
        .filter(Boolean)
        .map((l) => (rev ? l.slice(rev.length + 1) : l)),
    );
  } catch (e) {
    // git grep exits 1 when nothing matches; any other failure must not read as "no suppressions".
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

if (isEntry(import.meta.url, process.argv[1])) {
  const candidates = baseRefs(process.argv[2], process.env);
  const { at, refs } = mergeBase(git, candidates);
  if (!at) {
    const r = noBase('lint-caps', candidates.join(' or '), process.env);
    console.log(r.message);
    process.exit(r.code);
  }
  const problems = [
    ...configDiff(JSON.parse(git(['show', `${at}:biome.json`])), JSON.parse(readFileSync(`${ROOT}biome.json`, 'utf8'))),
    ...configChanges(configs(at), configs('')),
    ...addedLines(suppressionLines(at), suppressionLines('')).map((l) => `A suppression that covers a length rule was added: ${l}`),
  ];
  for (const p of problems) console.log(`✖ ${p}`);
  if (problems.length) {
    console.log(
      `\nlint-caps: ${problems.length} problem${problems.length === 1 ? '' : 's'}. A length limit only comes down: move a concern into a module of its own instead (designs/architecture.md, “Module and function size: a ceiling that only comes down”).`,
    );
    console.log(comparedWith(at, refs, process.env));
    process.exitCode = 1;
  } else console.log(`lint-caps: no length limit loosened since ${at.slice(0, 8)}.`);
}
