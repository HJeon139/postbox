import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { discover, verdict } from '../tools/check-all.mjs';

test('check-all finds every headless check by name, and not itself or other tools', async () => {
  const tools = await mkdtemp(join(tmpdir(), 'pb-check-all-'));
  try {
    await mkdir(join(tools, 'checks'));
    for (const f of [
      'check-shell.mjs',
      'check-all.mjs',
      'check-header.mjs',
      'cdp.mjs',
      'harness.mjs',
      'lint-dom.mjs',
      'checks/app-send.mjs',
      'checks/notes.md',
    ])
      await writeFile(join(tools, f), '');
    assert.deepEqual(await discover(tools), ['check-header', 'check-shell', 'checks/app-send']);
    assert.deepEqual(await discover(tools, ['shell', 'app-']), ['check-shell', 'checks/app-send']);
    assert.deepEqual(await discover(tools, ['nothing']), []);
  } finally {
    await rm(tools, { recursive: true, force: true });
  }
});

test('the real tools folder has the checks, so CI runs them', async () => {
  const names = await discover();
  assert.ok(names.includes('check-header') && names.includes('checks/app-send'), names.join(', '));
  assert.ok(!names.includes('check-all'));
});

const cases = (...list) => ({ passed: list.filter((c) => c.ok).length, failed: list.filter((c) => !c.ok).length, cases: list });

test('a check passes on its results: every case passed, and it exited 0', () => {
  assert.deepEqual(verdict({ code: 0, results: cases({ name: 'a', ok: true }, { name: 'b', ok: true }) }), { ok: true, passed: 2, failed: 0, first: '' });
});

test('a check that exited 0 but recorded no case fails: it checked nothing (designs/developing.md)', () => {
  assert.deepEqual(verdict({ code: 0, results: cases() }), { ok: false, passed: 0, failed: 1, first: 'it recorded no cases, so it checked nothing' });
});

test('a failing check names its first failing case, with the first line of the reason', () => {
  const r = verdict({
    code: 1,
    results: cases({ name: 'a', ok: true }, { name: 'focus moves', ok: false, detail: 'Expected x\nGot y' }, { name: 'c', ok: false }),
  });
  assert.deepEqual(r, { ok: false, passed: 1, failed: 2, first: 'focus moves (Expected x)' });
});

test('a check that exits non-zero fails even when its cases passed', () => {
  const r = verdict({ code: 1, results: cases({ name: 'a', ok: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.first, 'exited with code 1');
});

test('a check that dies before it reports fails, with its last line', () => {
  assert.deepEqual(verdict({ code: 1, log: '  ok    a\nError: Chrome didn’t start.\n\n' }), {
    ok: false,
    passed: 0,
    failed: 1,
    first: 'exited with code 1 before it reported: Error: Chrome didn’t start.',
  });
  assert.match(verdict({ code: null, signal: 'SIGKILL' }).first, /^was killed \(SIGKILL\) before it reported$/);
});

test('a check killed at its timeout fails, and says so', () => {
  const r = verdict({ code: null, signal: 'SIGTERM', timedOut: true, timeout: 600 });
  assert.deepEqual(r, { ok: false, passed: 0, failed: 1, first: 'timed out after 600 s, and was killed' });
});
