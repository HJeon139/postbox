// Where server code makes a session write that a published session read decides (#796's class in sessions,
// designs/508/601-held-view.md, “a read that decides a write reads pending”): the condition on the write's own line, or
// on the `if` line just above it, reads a session bound from a published read in that function, or the loop it's in
// walks published sessions (`for (const se of rt.sessions.in(t))`). Behind a held commit, that read missed what is
// held: Stop's “stopping”, so a stopped turn's exit didn't set its session idle, and an unread a turn counted, so
// viewing didn't clear it. The guard reads source text, so a decision it doesn't see on the write passes: an early
// return (`if (!se.x) return;`), a condition further up, or a result passed in; review reads for those.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DECL, withProbes } from './server-sources-fixture.mjs';
import { BIND, GETTER, PUBLISHED_SESSION } from './session-read-forms.mjs';

/**
 * The writes whose condition still reads a published session, each a follow-up of #796's class in sessions: behind a
 * held commit, the read decides on a session that misses what is held.
 */
const DECIDED_PUBLISHED = {
  'permission-cards.mjs': ['resolveDenial'], // allowOnce, also built from the published session (session-write-guard’s FROM_PUBLISHED)
};

/** A published read of one session or of a thread's: what a deciding read reads. */
const PUBLISHED_READ = new RegExp(`${PUBLISHED_SESSION.source}|\\bsessions\\.in\\(`);
/** A session write: Sessions.update, a put, or a raw session emit. */
const ANY_WRITE = /\bsessions\.update\(|\bthis\.update\(|\bsessions\.put\(|\bemit\(\s*['"`]session(?:\.patch)?['"`]/;

/** file → the function of each session write whose condition reads a published session. @param {string[]} [extra] */
function decidedByPublished(extra = []) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [path, text] of withProbes(extra)) {
    const lines = text.split('\n');
    const getters = [...text.matchAll(GETTER)].filter((m) => PUBLISHED_READ.test(m[2])).map((m) => String.raw`${m[1]}\(\)`);
    lines.forEach((line, i) => {
      const at = line.search(ANY_WRITE);
      if (at < 0 || /^\s*(\/\/|\*)/.test(line)) return;
      let decl = i;
      while (decl > 0 && !DECL.test(lines[decl])) decl--;
      const body = lines.slice(decl, i + 1).join('\n');
      // Bound from a published read, or from a getter of one, but not from a pending one (`pending.session(id) ?? …`).
      const bound = [...body.matchAll(BIND)].filter(
        (m) => (PUBLISHED_READ.test(m[2]) || getters.some((g) => new RegExp(g).test(m[2]))) && !/\bpending\./.test(m[2]),
      );
      const walked = [...body.matchAll(/\bfor\s*\(\s*(?:const|let)\s+(\w+)\s+of\s+([^\n]*)/g)].filter((m) => PUBLISHED_READ.test(m[2]));
      const names = [...bound, ...walked].map((m) => String.raw`${m[1]}\b`);
      const root = new RegExp(String.raw`(?<![\w$.])(?:${[...names, ...getters].join('|') || '(?!)'})|\bs\.sessions\[`);
      const before = line.slice(0, at);
      const above = /^\s*(?:\}\s*)?(?:else\s+)?if\s*\(.*\)\s*\{?\s*$/.test(lines[i - 1] ?? '') ? lines[i - 1] : '';
      const cond = `${before.match(/\b(?:if|while)\s*\((.*)$/)?.[1] ?? ''} ${before.match(/^(.*)(?:&&|\?)[^&?]*$/)?.[1] ?? ''} ${above}`;
      if (root.test(cond)) {
        const m = lines[decl].match(DECL);
        (out[path] ??= []).push(m ? (m[1] ?? m[2] ?? m[3]) : '(top)');
      }
    });
  }
  return out;
}

test('every session write in server/ that a published session read decides is placed', () => {
  assert.deepEqual(decidedByPublished(), DECIDED_PUBLISHED, 'read the session that decides the write pending: store.pending.session, or sessions.pendingIn');
});

test('the guard finds a write a published read decides, on its line, the line above, or the loop it is in, and not a pending one', () => {
  const probes = [
    // turnExited's published read, and view's loop over the published sessions, as they were: found.
    "export function zz1(rt, id) {\n  const se = rt.s.sessions[id];\n  if (se.state === 'stopping')\n    rt.sessions.update(id, { state: 'idle' });\n}",
    'export function zz2(rt, t) {\n  for (const se of rt.sessions.in(t)) if (se.unread) rt.sessions.update(se.id, { unread: 0 });\n}',
    'export function zz3(rt, id) { if (rt.s.sessions[id]?.sideTurn) rt.sessions.update(id, { sideTurn: null }); }',
    "export function zz4(rt, id) {\n  const se = () => rt.s.sessions[id];\n  se().unread && rt.store.emit('session.patch', { id, unread: 0 });\n}",
    // Read pending, or a published read that doesn't decide the write: not found.
    "export function zz5(rt, id) {\n  const se = rt.store.pending.session(id) ?? rt.s.sessions[id];\n  if (se.state === 'stopping') rt.sessions.update(id, { state: 'idle' });\n}",
    'export function zz6(rt, t) {\n  for (const se of rt.sessions.pendingIn(t)) if (se.unread) rt.sessions.update(se.id, { unread: 0 });\n}',
    'export function zz7(rt, id, on) {\n  const se = rt.s.sessions[id];\n  if (on) rt.sessions.update(id, { currentStep: se.handle });\n}',
    // A parameter's s.sessions, as setupFor reads the state it's given: found.
    'export function zz8(rt, s, id) { if (s.sessions[id].sideTurn) rt.sessions.update(id, { sideTurn: null }); }',
  ];
  const found = Object.keys(decidedByPublished(probes)).filter((k) => k.startsWith('extra-'));
  assert.deepEqual(found, ['extra-0.mjs', 'extra-1.mjs', 'extra-2.mjs', 'extra-3.mjs', 'extra-7.mjs']);
});
