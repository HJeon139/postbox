// Where server code builds a session's field from a session it read (#796's class in sessions,
// designs/508/601-held-view.md, “a read that decides a write reads pending”). A session.patch replaces each field
// whole, so a field built from the published session (its context, its backend state, its jobs) overwrites the same
// field a write still held behind a commit left: a Postbox notice, or a backend's resume id, was lost. updateSession
// (server/session-write.mjs) takes a function of the pending session for these. This guard finds every updateSession
// change that spreads, or filters, maps or slices, a field of a session it didn't get as that function's parameter,
// directly or through a local, and places each by file and function. The ones still placed below are follow-ups, each
// a write built from the published session: a new one fails until it's built from the pending session instead.
// A count built from a session's own (`unread: se.unread + 1`) is found too: behind a held commit it lost an increment.
// Every other write of a session, a put or a removal, and updateSession's own patch, is placed by file and function, as
// the thread writes are (tests/thread-write-guard.test.mjs), so a raw emit or a put built from the published session fails.
// The guard reads source text, so a field reached through a call it doesn't see (`settledNeed(rt, se)`) passes, and
// review reads for it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DECL, placed, sites, withProbes } from './server-sources-fixture.mjs';

/** Every write of a session: updateSession's patch, the put of a new one, and the removal of one. */
const SESSION_WRITES = {
  'runtime.mjs': ['putSession', 'putSession', 'ensureSession', 'purgeSession'], // putSession and its emit, called only by ensureSession for a new session; a purge's removal
  'session-write.mjs': ['updateSession'], // a session that exists, from store.pending.session
  'thread-erase.mjs': ['eraseThreads'], // the sessions of the threads a delete erases
};
const SESSION_WRITE = /\bputSession\(|\bemit\(\s*['"`]session|\bemit\(\s*['"`]remove['"`]\s*,\s*\{\s*kind:\s*['"`]session['"`]/;

/**
 * The writes that still build a field from the published session, each a follow-up of #796's class in sessions: behind
 * a held commit, each drops what a held write of the same field left. Tracked in the follow-up issue drafted with QS-1,
 * “#796's class in sessions: thirteen writes still build a field from the published session”, which has no number yet;
 * the pending reads are #623's class (Refs #623).
 */
const FROM_PUBLISHED = {
  'kept-jobs.mjs': ['stopJob'], // jobs: a job's stopping mark
  'permission-cards.mjs': ['resolveDenial'], // allowOnce: Allow once on a denial card
  'permissions-panel.mjs': ['changePermissionFolder', 'changePermissionFolder'], // addDirs: a folder removed, or added
  'remote/turns-shared.mjs': ['updateRemote'], // remoteTurn: a host turn's state
  'runtime.mjs': ['recordJob', 'recordJob', 'endJob', 'rememberDiagrams'], // jobs (a job recorded, kept, ended) and diagramsLinted
  'session-run.mjs': ['setSessionRun'], // personaSnapshot: a model or effort set for the session
  'side-threads.mjs': ['recordAgentMessage'], // agentMessages: the last messages between two agents
  'thread-summary.mjs': ['threadCatchUp', 'reactionLines'], // seenIn and reactionsTold: catch-up markers per thread
};

/** A published read of a session: `rt.s.sessions[id]`, `state.sessions`, `rt.session(id)`. */
const PUBLISHED_SESSION = /\.s\.sessions\b|\bstate\.sessions\b|\b(?:rt|this)\.session\(/;
/** A session's name in server code, bound from a published read or passed in as one: se, now, session. */
const NAMES = ['se', 'now', 'session'];
/** A getter of a published session, as a turn's handlers read theirs: `const se = () => rt.s.sessions[turn.sessionId]`. */
const GETTER = /\b(?:const|let)\s+(\w+)\s*=\s*\(\)\s*=>([^;\n]*)/g;
/** A local bound in a function, with what it's bound from. */
const BIND = /\b(?:const|let|var)\s+(\w+)\s*=([^;]*)/g;

/** What names a published session: each name (`se`), each getter's call (`se()`), and an index into the published map. @param {string[]} roots */
const rootOf = (roots) => String.raw`(?:(?:${roots.join('|')})|[\w$.]*\.s\.sessions\[[^\]]*\])`;
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
 * `...dirs` for a local bound from one; or a count added to or taken from (countOf).
 * A conditional spread (`...(se.x ? {…} : {})`) reads a field, but builds none.
 * @param {string[]} roots  what names a published session here @param {string[]} copies  locals bound from a field of one
 */
function derivedFrom(roots, copies) {
  const local = copies.length ? String.raw`|(?:${copies.join('|')})\b` : '';
  const field = `(?:${rootOf(roots)}${MEMBERS}${local})`;
  const spread = String.raw`\.\.\.\(?\s*${field}(?![\w$.[(])(?!\s*\?(?!\?))`;
  const op = String.raw`${START}${field}(?:\s*\?\?\s*\[\]\s*\))?\.(?:filter|map|slice|concat|reduce)\(`;
  return new RegExp(`${spread}|${op}|${countOf(roots, copies)}`);
}

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

/** file → the function of each updateSession call whose change builds a field from a session it read. @param {string[]} [extra] */
function builtFromSession(extra = []) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [path, text] of withProbes(extra)) {
    const lines = text.split('\n');
    const getters = [...text.matchAll(GETTER)].filter((m) => PUBLISHED_SESSION.test(m[2])).map((m) => m[1]);
    const called = getters.length ? new RegExp(String.raw`\b(?:${getters.join('|')})\(\)`) : null;
    for (let at = text.search(/\bupdateSession\(/); at >= 0; ) {
      const line = text.slice(0, at).split('\n').length - 1;
      const call = text.indexOf('(', at) + 1;
      const next = text.slice(call).search(/\bupdateSession\(/);
      if (!/^\s*(\/\/|\*|import\b|export\s+function\s+updateSession\b)/.test(lines[line]) && !/^\s*updateSession\(id, patch\)/.test(lines[line])) {
        // rt.updateSession(id, change) or updateSession(rt, id, change)
        const args = argsAt(text, call);
        const change = args.slice(text[at - 1] === '.' ? 1 : 2).join(',');
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
          const of = new RegExp(String.raw`^\s*\[?\s*(?:\.\.\.)?\(?\s*${copyOf(roots, copies)}|\.\.\.\(?\s*${copyOf(roots, copies)}`);
          const found = binds.filter((m) => !copies.includes(m[1]) && of.test(m[2])).map((m) => m[1]);
          copies.push(...found);
          more = found.length > 0;
        }
        // A local that is itself a count built from one: `const n = se().compactions + 1`, then `{ compactions: n }`.
        const counted = binds.filter((m) => copies.includes(m[1]) && new RegExp(countOf(roots, copies)).test(m[2])).map((m) => m[1]);
        const usesCount = counted.length > 0 && new RegExp(String.raw`${START}(?:${counted.join('|')})\b`).test(change);
        if (derivedFrom(roots, copies).test(change) || usesCount) {
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
  assert.deepEqual(builtFromSession(), FROM_PUBLISHED, 'build the field from the session updateSession passes a function of it');
});

test('the guard finds a session field built from a published read, directly or through a local, and not from the pending one', () => {
  const probes = [
    'export function zz1(rt, id, patch) {\n  const se = rt.s.sessions[id];\n  rt.updateSession(id, { backendState: { ...(se.backendState ?? {}), ...patch } });\n}',
    "export function zz2(rt, id) {\n  const now = rt.session(id);\n  rt.updateSession(id, { context: now.context.filter((x) => x !== 'a') });\n}",
    "export function zz3(rt, id) {\n  const ctx = rt.s.sessions[id].context ?? [];\n  updateSession(rt, id, { context: [...ctx, 'b'] });\n}",
    'export function zz4(rt, id) { rt.updateSession(id, { jobs: (rt.s.sessions[id].jobs ?? []).map((j) => ({ ...j, kept: true })) }); }',
    // Built from the pending session the function is given, or a published field read but not built into one: not found.
    'export function zz5(rt, id, patch) {\n  const se = rt.s.sessions[id];\n  rt.updateSession(id, (se) => ({ backendState: { ...(se.backendState ?? {}), ...patch } }));\n}',
    "export function zz6(rt, id) {\n  const se = rt.s.sessions[id];\n  rt.updateSession(id, { ...(se.remoteTurn ? { lastTurnId: 'x' } : {}), unread: 0 });\n}",
    'export function zz7(rt, id) {\n  const se = rt.s.sessions[id];\n  rt.updateSession(id, (now) => ({ unread: now.unread + 1, toolCount: (now.toolCount ?? 0) + 1 }));\n}',
    // A count built from the published session, as #796's lost increment was, and the same through a local: found.
    'export function zz8(rt, id) {\n  const se = rt.s.sessions[id];\n  rt.updateSession(id, { unread: se.unread + 1 });\n}',
    'export function zz9(rt, id) { rt.updateSession(id, { toolCount: (rt.s.sessions[id].toolCount ?? 0) + 1 }); }',
    'export function zz10(rt, id) {\n  const n = rt.s.sessions[id].compactions;\n  rt.updateSession(id, { compactions: 1 + n });\n}',
    // Through a getter of the published session, as a turn's handlers read it: a count, and a list built from it.
    'export function zz11(rt, id) {\n  const se = () => rt.s.sessions[id];\n  const n = se().compactions + 1;\n  rt.updateSession(id, { compactions: n });\n}',
    'export function zz12(rt, id, step) {\n  const se = () => rt.s.sessions[id];\n  const s = se();\n  rt.updateSession(id, { toolCalls: [step, ...s.toolCalls.filter((c) => c !== step)] });\n}',
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
  ]);
});

test('every session write in server/ is placed, by file and function, and a raw one is found', () => {
  placed(SESSION_WRITE, SESSION_WRITES, 'the session writes');
  // A patch emitted past updateSession, and a put built from the published session: each is found.
  const probes = [
    "export function zz1(rt, id) { rt.store.emit('session.patch', { id, unread: rt.s.sessions[id].unread + 1 }); }",
    'export function zz2(rt, id) { rt.putSession({ ...rt.s.sessions[id], unread: 0 }); }',
    "export function zz3(rt, id) { rt.store.emit('session', { ...rt.s.sessions[id], context: [] }); }",
    "export function zz4(rt, id) { rt.store.emit('remove', { kind: 'session', id }); }",
  ];
  const found = Object.keys(sites(SESSION_WRITE, probes)).filter((k) => k.startsWith('extra-'));
  assert.deepEqual(found, ['extra-0.mjs', 'extra-1.mjs', 'extra-2.mjs', 'extra-3.mjs']);
});
