// Forms of a published session read the session write guard can't place (#623): it matches `rt.s.sessions[id]`, a
// parameter's `s.sessions[id]` and `state.sessions` by name (tests/session-write-guard.test.mjs), so a read through
// `const { sessions } = rt.s` or `s['sessions']` would decide or build a write it never sees. Each fails here outright,
// as threads' do (tests/thread-read-guard.test.mjs). A local named sessions from anything else isn't one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withProbes } from './server-sources-fixture.mjs';

/** Lines that reach the published sessions through a form the guard can't place. @param {string[]} [extra] */
function unplaceable(extra = []) {
  const FORM = /\{[^}]*\bsessions\b[^}]*\}\s*=\s*[\w$.]*\b(?:s|state|store)\b\s*[;,)]|\[\s*['"`]sessions['"`]\s*\]/;
  return withProbes(extra).flatMap(([path, text]) =>
    text
      .split('\n')
      .filter((l) => FORM.test(l) && !/^\s*(\/\/|\*)/.test(l))
      .map((l) => `${path}: ${l.trim()}`),
  );
}

test('no server file reaches the published sessions through a form the session guards can’t place', () => {
  assert.deepEqual(unplaceable(), [], 'read rt.s.sessions[id] or state.sessions[id] by name, so the guard can place it');
  const probes = [
    'export function zz1(rt, id) { const { sessions } = rt.s; return sessions[id]; }',
    'export function zz2(state, id) { const { sessions: all } = state; return all[id]; }',
    "export function zz3(rt, id) { return rt.s['sessions'][id]; }",
    'export function zz4(checks, id) { const { sessions, threads } = checks.store.state; return sessions[id] && threads; }',
    // A local named sessions from anything else, as the runtime's services are: not found.
    'export function zz5(rt) { const { sessions } = rt; return sessions.in("th_1"); }',
  ];
  assert.deepEqual(
    unplaceable(probes).map((l) => l.split(':')[0]),
    ['extra-0.mjs', 'extra-1.mjs', 'extra-2.mjs', 'extra-3.mjs'],
  );
});
