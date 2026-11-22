// Where server code reads items, work and apps, and which of the two reads it uses (#601, designs/508/601-held-view.md).
// The published reads (store.items(), item(), and store.state directly) show only what was applied. The
// pending reads (store.pending, and the ledger's entries(), which uses it) show what is held behind a commit too. The
// rule: a reader whose result decides a write the turn or a sweep makes reads pending; a reader whose result leaves
// the process (the page, a read tool, a prompt, an HTTP answer), or a write the person aims at one item they can see,
// reads published. Every site is placed here by file and enclosing function, so a new reader of either kind fails until
// it is placed (the integrator's review of #611: a guard of pending sites alone let a new published reader through).
// Production commits are placed too: a commit in front of held emits that touches these lists makes a pending read
// inexact (§5). Lines the formatter split (`rt.store\n  .items(`) are joined before matching. Forms it can't follow
// fail outright: destructuring `pending`, `items`, `work` or `apps` out of the store or the state, reaching them by a
// string key, binding the store, its pending reads or the ledger to a local, and calling items(), item()
// or work() on anything but the store or its pending reads (the integrator's second review of #611: `const st =
// rt.store; st.items(t)` passed), or through call, apply or bind. Optional chaining is read as a plain member. The guard
// reads source text, not the program, so a form it doesn't match passes, and review reads for it: an optional call
// (`rt.store?.items?.(t)`), an optional bracket (`rt.store?.["items"](t)`) and `Reflect.apply(rt.store.items, …)` are three. It reads every .mjs, .js and .cjs file under server/ except the store's own and server/remote/host/,
// the host daemon, which has no store. Sessions have a pending read by id, for their writes and a delivery's wait
// (#796's class); schedules and the rest have none (§ Not in this change).
// Threads follow the same rule for their writes (#796): tests/thread-write-guard.test.mjs places them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalized, placed, sources } from './server-sources-fixture.mjs';

import { COMMITS, DIRECT, LEDGER, PENDING, PUBLISHED } from './store-held-sites.mjs';

test('every published read of items, work and apps in server/ is placed, by file and function', () => {
  placed(/\bstore\.(items|item)\(/, PUBLISHED, 'the published reads');
  placed(/\.s\.(items|work|apps)\b|state\.(items|work|apps)\b|\.(items|work|apps)\[/, DIRECT, 'the direct reads of state');
});

test('every pending read in server/ is placed, by file and function, the ledger’s entries() and entry() included', () => {
  placed(/\bstore\.pending\b/, PENDING, 'the pending reads');
  placed(/\bledger\.(entries|entry)\(|\bthis\.(entries|entry)\(/, LEDGER, 'the ledger’s pending reads');
});

test('every production commit in server/ is placed, with the lists it touches', () => {
  placed(/\.commit\s*\(/, COMMITS, 'the production commits');
});

test('no server file reaches the store’s reads through a form the guard can’t follow', () => {
  const ALIAS = /\{[^}]*\b(pending|items|work|apps)\b[^}]*\}\s*=\s*[\w.]*\b(store|s|state)\b\s*[;,)]|[\w$\])]\s*\[\s*['"`](pending|items|work|apps)['"`]\s*\]/;
  const found = sources().flatMap(([path, text]) =>
    text
      .split('\n')
      .filter((l) => ALIAS.test(l) && !/^\s*(\/\/|\*)/.test(l))
      .map((l) => `${path}: ${l.trim()}`),
  );
  assert.deepEqual(found, [], 'read through store.pending.items(), store.items() or state.<list> by name, so the guard can place it');
});

/** Lines of server code that reach a list read through a local the guard can't follow. @param {string[]} [extra] */
export function unfollowed(extra = []) {
  const BOUND = /\b(?:const|let|var)\s+[\w$]+\s*=\s*[\w$.]*\b(?:store(?:\.pending)?|ledger)\s*[;,)]/;
  const CALL = /([\w$\])]+)\s*\.\s*(?:items|item|work)\s*\(/g;
  const INDIRECT = /\.\s*(?:items|item|work)\s*\.\s*(?:call|apply|bind)\b/;
  return [...sources(), ...extra.map((text, i) => [`extra-${i}.mjs`, normalized(text)])].flatMap(([path, text]) =>
    text
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .filter((l) => BOUND.test(l) || INDIRECT.test(l) || [...l.matchAll(CALL)].some((m) => !/^(store|pending)$/.test(m[1])))
      .map((l) => `${path}: ${l.trim()}`),
  );
}

test('no server file binds the store or the ledger to a local, or calls a list read on anything but the store', () => {
  assert.deepEqual(
    unfollowed(),
    [],
    'call store.items(), store.pending.items() or ledger.entries() where the store or ledger is named, so the guard can place it',
  );
  // The integrator's probe, and the same through the pending reads and the ledger: each is found.
  const probes = [
    'export function zz6(rt, t) { const st = rt.store; return st.items(t).find((x) => x); }',
    'export function zz7(rt, t) { const p = rt.store.pending; return p.items(t); }',
    'export function zz8(rt, c) { const l = rt.ledger; return l.entries(c); }',
    // critic's read of the rule: the read called through call, apply or bind.
    'export function zz10(rt, t) { return rt.store.items.call(rt.store, t); }',
    'export function zz11(rt, t) { return rt.store.pending.items.apply(rt.store.pending, [t]); }',
    'export function zz12(rt, t) { const read = rt.store.item.bind(rt.store); return read(t, "x"); }',
  ];
  assert.deepEqual(
    unfollowed(probes).map((l) => l.split(':')[0]),
    ['extra-0.mjs', 'extra-1.mjs', 'extra-2.mjs', 'extra-3.mjs', 'extra-4.mjs', 'extra-5.mjs'],
  );
  // Optional chaining is a store call like any other, so the tables above place it: read as a plain member, it matches.
  assert.match(normalized('return rt.store?.items(t);'), /\bstore\.(items|item)\(/);
  assert.match(normalized('return rt.store?.pending?.items(t);'), /\bstore\.pending\b/);
});
