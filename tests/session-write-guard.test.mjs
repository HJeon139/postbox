// Where server code builds a session's field from a session it read (#796's class in sessions,
// designs/508/601-held-view.md, “a read that decides a write reads pending”). A session.patch replaces each field
// whole, so a field built from the published session (its context, its backend state, its jobs) overwrites the same
// field a write still held behind a commit left: a Postbox notice, or a backend's resume id, was lost. Sessions.update
// (server/sessions.mjs) takes a function of the pending session for these. This guard finds every Sessions.update
// change that spreads, or filters, maps or slices, a field of a session it didn't get as that function's parameter,
// directly or through a local, and places each by file and function. The ones still placed below are follow-ups, each
// a write built from the published session: a new one fails until it's built from the pending session instead.
// A count built from a session's own (`unread: se.unread + 1`) is found too: behind a held commit it lost an increment.
// Every other write of a session, a put or a removal, and Sessions.update's own patch, is placed by file and function, as
// the thread writes are (tests/thread-write-guard.test.mjs), so a raw emit or a put built from the published session fails.
// A write a published read decides is found by tests/session-decided-guard.test.mjs.
// The guard reads source text, so a field reached through a call it doesn't see (`settledNeed(rt, se)`) passes, and
// review reads for those. A published read is matched through any `s`, a parameter's too, and a copy
// made by a spread, `.slice()`, `structuredClone(` or `Object.assign(` is followed; destructuring `sessions` out of the
// state and reaching it by a string key fail outright (tests/session-read-guard.test.mjs).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DECL, placed, sites, withProbes } from './server-sources-fixture.mjs';
import { BIND, GETTER, PUBLISHED_SESSION } from './session-read-forms.mjs';

/** Every write of a session: Sessions.update's patch, the put of a new one, and the removal of one. */
const SESSION_WRITES = {
  // a new session; a session that exists, from store.pending.session; a removal, which a delete and an erase call; a
  // need's time as the store loads
  'sessions.mjs': ['ensure', 'update', 'remove', 'stampNeeds'],
  // a session an older Postbox stored on the Agent SDK, moved to Claude Code as the store loads, before any write is held
  'retired-backends.mjs': ['retireBackends'],
};
const SESSION_WRITE = /\bsessions\.put\(|\bemit\(\s*['"`]session(?:\.patch)?['"`]|\bemit\(\s*['"`]remove['"`]\s*,\s*\{\s*kind:\s*['"`]session['"`]/;

/**
 * The writes that still build a field from the published session, each a follow-up of #796's class in sessions: behind
 * a held commit, each drops what a held write of the same field left. Tracked in the follow-up issue drafted with QS-1,
 * “#796's class in sessions: thirteen writes still build a field from the published session”, which has no number yet;
 * the pending reads are #623's class (Refs #623).
 */
const FROM_PUBLISHED = {
  'kept-jobs.mjs': ['stopJob'], // jobs: a job's stopping mark
  'permission-cards.mjs': ['resolveDenial'], // allowOnce: Allow once on a denial card
  // rules: a conversation's rule, copied whole from the session (found once the guard read copies given whole, #623);
  // addDirs: a folder removed, or added
  'permissions-panel.mjs': ['changePermissionRule', 'changePermissionFolder', 'changePermissionFolder'],
  'remote/turns-shared.mjs': ['updateRemote'], // remoteTurn: a host turn's state
  'thread-catch-up.mjs': ['threadTail', 'threadCatchUp', 'reactionLines'], // seenIn and reactionsTold: catch-up markers per thread
};

/** A session's name in server code, bound from a published read or passed in as one: se, now, session. */
const NAMES = ['se', 'now', 'session'];

/** What names a published session: each name (`se`), each getter's call (`se()`), and an index into the published map. @param {string[]} roots */
const rootOf = (roots) => String.raw`(?:(?:${roots.join('|')})|[\w$.]*\b(?:s|state)\.sessions\[[^\]]*\])`;
const MEMBERS = String.raw`(?:\.[\w$]+|\[[^\]]*\])+`;
/** Not a member of something else (`x.se.unread`), but a spread may come before it. */
const START = String.raw`(?<![\w$])(?<![^.]\.)`;

/** A count added to or taken from a field of a session, or a local copy of one: `se.unread + 1`, `(se.toolCount ?? 0) + 1`, `1 + n`. @param {string[]} roots @param {string[]} copies */
function countOf(roots, copies) {
  const field = `(?:${rootOf(roots)}${MEMBERS}${copies.length ? String.raw`|(?:${copies.join('|')})\b` : ''})`;
  return String.raw`${START}${field}(?![\w$.[(])(?:\s*\?\?\s*[\w.]+\s*\))?\s*[-+](?![-+=])|[-+]\s*\(?\s*${field}(?![\w$.[(])`;
}

/**
 * A field of a session spread, or filtered, mapped, sliced or concatenated: `...se.context`, `(se.jobs ?? []).map(`,
 * `...dirs` for a local bound from one; copied by `structuredClone(` or `Object.assign(`; or a count added to or
 * taken from (countOf).
 * A conditional spread (`...(se.x ? {…} : {})`) reads a field, but builds none.
 * @param {string[]} roots  what names a published session here @param {string[]} copies  locals bound from a field of one
 */
function derivedFrom(roots, copies) {
  const local = copies.length ? String.raw`|(?:${copies.join('|')})\b` : '';
  const field = `(?:${rootOf(roots)}${MEMBERS}${local})`;
  const spread = String.raw`\.\.\.\(?\s*${field}(?![\w$.[(])(?!\s*\?(?!\?))`;
  const op = String.raw`${START}${field}(?:\s*\?\?\s*\[\]\s*\))?\.(?:filter|map|slice|concat|reduce)\(`;
  const clone = String.raw`${COPIER}[^;]*?${START}${field}(?![\w$.[(])`;
  return new RegExp(`${spread}|${op}|${clone}|${countOf(roots, copies)}`);
}

/** A call that copies what it's given: `structuredClone(se.jobs)`, `Object.assign({}, se.threadsTold)`. */
const COPIER = String.raw`\b(?:structuredClone|Object\.assign)\(`;
/** How a local copies a field: a spread, `.slice()`, or a copier (COPIER). */
const COPIES = new RegExp(String.raw`\.\.\.|\.slice\(|${COPIER}`);

/** A field of a session, or a local copy of one. @param {string[]} roots @param {string[]} copies */
const copyOf = (roots, copies) => `(?:${rootOf(roots)}${MEMBERS}${copies.length ? String.raw`|(?:${copies.join('|')})\b` : ''})`;

/** The arguments of the call whose `(` is just before `from`, split at its top-level commas. @param {string} text @param {number} from */
function argsAt(text, from) {
  const args = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    if ((c === ',' && depth === 0) || depth < 0) {
      args.push(text.slice(start, i));
      start = i + 1;
    }
    if (depth < 0) break;
  }
  return args;
}

/**
 * A local copied from a field of a session, then given whole as a field: `const told = { ...(se.threadsTold ?? {}) }`,
 * then `{ threadsTold: told }`, and the same by `.slice()`, `structuredClone(` or `Object.assign(` (COPIES). Behind a
 * held commit, the copy drops what a held write of the field left (#623).
 * @param {RegExpMatchArray[]} binds @param {string[]} copies @param {string} change
 */
function passesCopy(binds, copies, change) {
  const spread = binds.filter((m) => copies.includes(m[1]) && COPIES.test(m[2])).map((m) => m[1]);
  return spread.length > 0 && new RegExp(String.raw`[:{,]\s*(?:${spread.join('|')})(?![\w$.([])`).test(change);
}

/** The calls of Sessions.update: `sessions.update(` anywhere, and `this.update(` in Sessions itself. */
const UPDATE = /\bsessions\.update\(|\bthis\.update\(/;

/** file → the function of each Sessions.update call whose change builds a field from a session it read. @param {string[]} [extra] */
function builtFromSession(extra = []) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [path, text] of withProbes(extra)) {
    const lines = text.split('\n');
    const getters = [...text.matchAll(GETTER)].filter((m) => PUBLISHED_SESSION.test(m[2])).map((m) => m[1]);
    const called = getters.length ? new RegExp(String.raw`\b(?:${getters.join('|')})\(\)`) : null;
    for (let at = text.search(UPDATE); at >= 0; ) {
      const line = text.slice(0, at).split('\n').length - 1;
      const call = text.indexOf('(', at) + 1;
      const next = text.slice(call).search(UPDATE);
      if (!/^\s*(\/\/|\*|import\b)/.test(lines[line])) {
        // rt.sessions.update(id, change)
        const args = argsAt(text, call);
        const change = args.slice(1).join(',');
        const param = change.match(/^\s*\(?\s*(\w+)\s*\)?\s*=>/)?.[1];
        let decl = line;
        while (decl > 0 && !DECL.test(lines[decl])) decl--;
        const binds = [
          ...lines
            .slice(decl, line + 1)
            .join('\n')
            .matchAll(BIND),
        ];
        const published = binds.filter((m) => PUBLISHED_SESSION.test(m[2]) || called?.test(m[2])).map((m) => m[1]);
        const roots = [...[...NAMES, ...published].filter((x) => x !== param).map((x) => String.raw`${x}\b`), ...getters.map((x) => String.raw`${x}\(\)`)];
        // Locals bound from a field, or from a local that was: `const jobs = se.jobs ?? []`, then `const all = [...jobs, job]`.
        const copies = [];
        for (let more = true; more; ) {
          const field = copyOf(roots, copies);
          const of = new RegExp(String.raw`^\s*\[?\s*(?:\.\.\.)?\(?\s*${field}|\.\.\.\(?\s*${field}|${COPIER}[^;]*?${START}${field}`);
          const found = binds.filter((m) => !copies.includes(m[1]) && of.test(m[2])).map((m) => m[1]);
          copies.push(...found);
          more = found.length > 0;
        }
        // A local that is itself a count built from one: `const n = se().compactions + 1`, then `{ compactions: n }`.
        const counted = binds.filter((m) => copies.includes(m[1]) && new RegExp(countOf(roots, copies)).test(m[2])).map((m) => m[1]);
        const usesCount = counted.length > 0 && new RegExp(String.raw`${START}(?:${counted.join('|')})\b`).test(change);
        if (derivedFrom(roots, copies).test(change) || usesCount || passesCopy(binds, copies, change)) {
          const m = lines[decl].match(DECL);
          (out[path] ??= []).push(m ? (m[1] ?? m[2] ?? m[3]) : '(top)');
        }
      }
      at = next < 0 ? -1 : call + next;
    }
  }
  return out;
}

test('every session write in server/ built from a session it read, not from the pending one, is placed', () => {
  assert.deepEqual(builtFromSession(), FROM_PUBLISHED, 'build the field from the session Sessions.update passes a function of it');
});

test('the guard finds a session field built from a published read, directly or through a local, and not from the pending one', () => {
  const probes = [
    'export function zz1(rt, id, patch) {\n  const se = rt.s.sessions[id];\n  rt.sessions.update(id, { backendState: { ...(se.backendState ?? {}), ...patch } });\n}',
    "export function zz2(rt, id) {\n  const now = rt.session(id);\n  rt.sessions.update(id, { context: now.context.filter((x) => x !== 'a') });\n}",
    "export function zz3(rt, id) {\n  const ctx = rt.s.sessions[id].context ?? [];\n  rt.sessions.update(id, { context: [...ctx, 'b'] });\n}",
    'export function zz4(rt, id) { rt.sessions.update(id, { jobs: (rt.s.sessions[id].jobs ?? []).map((j) => ({ ...j, kept: true })) }); }',
    // Built from the pending session the function is given, or a published field read but not built into one: not found.
    'export function zz5(rt, id, patch) {\n  const se = rt.s.sessions[id];\n  rt.sessions.update(id, (se) => ({ backendState: { ...(se.backendState ?? {}), ...patch } }));\n}',
    "export function zz6(rt, id) {\n  const se = rt.s.sessions[id];\n  rt.sessions.update(id, { ...(se.remoteTurn ? { lastTurnId: 'x' } : {}), unread: 0 });\n}",
    'export function zz7(rt, id) {\n  const se = rt.s.sessions[id];\n  rt.sessions.update(id, (now) => ({ unread: now.unread + 1, toolCount: (now.toolCount ?? 0) + 1 }));\n}',
    // A count built from the published session, as #796's lost increment was, and the same through a local: found.
    'export function zz8(rt, id) {\n  const se = rt.s.sessions[id];\n  rt.sessions.update(id, { unread: se.unread + 1 });\n}',
    'export function zz9(rt, id) { rt.sessions.update(id, { toolCount: (rt.s.sessions[id].toolCount ?? 0) + 1 }); }',
    'export function zz10(rt, id) {\n  const n = rt.s.sessions[id].compactions;\n  rt.sessions.update(id, { compactions: 1 + n });\n}',
    // Through a getter of the published session, as a turn's handlers read it: a count, and a list built from it.
    'export function zz11(rt, id) {\n  const se = () => rt.s.sessions[id];\n  const n = se().compactions + 1;\n  rt.sessions.update(id, { compactions: n });\n}',
    'export function zz12(rt, id, step) {\n  const se = () => rt.s.sessions[id];\n  const s = se();\n  rt.sessions.update(id, { toolCalls: [step, ...s.toolCalls.filter((c) => c !== step)] });\n}',
    // A copy of a field, spread from the published session and given whole, as threadLines' threadsTold was: found.
    "export function zz13(rt, id) {\n  const now = rt.s.sessions[id];\n  const told = { ...(now.threadsTold ?? {}) };\n  told.t1 = 'i1';\n  rt.sessions.update(id, { threadsTold: told });\n}",
    // The same merged into the pending session the function is given: not found.
    "export function zz14(rt, id) {\n  const newly = { t1: 'i1' };\n  rt.sessions.update(id, (s) => ({ threadsTold: { ...(s.threadsTold ?? {}), ...newly } }));\n}",
    // Read through a parameter's s.sessions, and copied by .slice(), structuredClone( or Object.assign(: found.
    'export function zz15(rt, s, id) {\n  const cur = s.sessions[id];\n  rt.sessions.update(id, { unread: cur.unread + 1 });\n}',
    'export function zz16(rt, id, j) {\n  const jobs = rt.s.sessions[id].jobs.slice();\n  jobs.push(j);\n  rt.sessions.update(id, { jobs });\n}',
    'export function zz17(rt, id) {\n  const se = rt.s.sessions[id];\n  rt.sessions.update(id, { jobs: structuredClone(se.jobs) });\n}',
    "export function zz18(rt, id) {\n  const se = rt.s.sessions[id];\n  const told = Object.assign({}, se.threadsTold);\n  told.t1 = 'i1';\n  rt.sessions.update(id, { threadsTold: told });\n}",
    // The same copy made of the pending session the function is given: not found.
    'export function zz19(rt, id) { rt.sessions.update(id, (s) => ({ jobs: structuredClone(s.jobs) })); }',
  ];
  const found = Object.keys(builtFromSession(probes)).filter((k) => k.startsWith('extra-'));
  assert.deepEqual(found, [
    'extra-0.mjs',
    'extra-1.mjs',
    'extra-2.mjs',
    'extra-3.mjs',
    'extra-7.mjs',
    'extra-8.mjs',
    'extra-9.mjs',
    'extra-10.mjs',
    'extra-11.mjs',
    'extra-12.mjs',
    'extra-14.mjs',
    'extra-15.mjs',
    'extra-16.mjs',
    'extra-17.mjs',
  ]);
});

test('every session write in server/ is placed, by file and function, and a raw one is found', () => {
  placed(SESSION_WRITE, SESSION_WRITES, 'the session writes');
  // A patch emitted past Sessions.update, and a put built from the published session: each is found.
  const probes = [
    "export function zz1(rt, id) { rt.store.emit('session.patch', { id, unread: rt.s.sessions[id].unread + 1 }); }",
    'export function zz2(rt, id) { rt.sessions.put({ ...rt.s.sessions[id], unread: 0 }); }',
    "export function zz3(rt, id) { rt.store.emit('session', { ...rt.s.sessions[id], context: [] }); }",
    "export function zz4(rt, id) { rt.store.emit('remove', { kind: 'session', id }); }",
  ];
  const found = Object.keys(sites(SESSION_WRITE, probes)).filter((k) => k.startsWith('extra-'));
  assert.deepEqual(found, ['extra-0.mjs', 'extra-1.mjs', 'extra-2.mjs', 'extra-3.mjs']);
});
