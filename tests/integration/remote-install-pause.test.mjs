// The install script’s test-only pauses (server/remote/install-script.mjs, `pause`), with a real sh: a pause whose
// path never comes ends at its limit, so a test killed mid-pause leaves no shell waiting forever (#824).

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { INSTALL_SCRIPT, pauseFunction, TEST_PAUSE_LIMIT_S } from '../../server/remote/install-script.mjs';
import { SKIP, temp } from './remote-install-fixtures.mjs';

/** Runs `pause` with a limit of `limitS`, then prints `after`. */
const runPause = (/** @type {number} */ limitS, /** @type {string} */ args) =>
  spawnSync('/bin/sh', ['-c', `${pauseFunction(limitS)} pause ${args}; echo after`], { encoding: 'utf8', timeout: 20_000 });

test('a pause whose path never comes ends at its limit, and the script goes on', { skip: SKIP }, () => {
  const go = join(temp('pbp-'), 'go');
  const started = Date.now();
  const r = runPause(1, `"${go}" paused`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'after\n');
  assert.ok(Date.now() - started < 10_000, `it ended in ${Date.now() - started} ms`);
  assert.ok(existsSync(`${go}.paused`), 'it said where it paused');
});

test('a pause with no path returns at once and makes nothing', { skip: SKIP }, () => {
  const dir = temp('pbp-');
  const r = runPause(TEST_PAUSE_LIMIT_S, `"" paused`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'after\n');
  assert.ok(!existsSync(join(dir, '.paused')));
});

test('the install script pauses through that function, at its limit, at each of its three pauses', () => {
  assert.ok(INSTALL_SCRIPT.includes(pauseFunction()), 'the script defines pause with the limit');
  for (const at of ['WAIT', 'BREAK', 'HOLD']) assert.match(INSTALL_SCRIPT, new RegExp(`pause "\\$\\{POSTBOX_INSTALL_TEST_${at}:-\\}" `));
  assert.doesNotMatch(INSTALL_SCRIPT, /until \[ -e "\$POSTBOX_INSTALL_TEST_/, 'no pause waits without a limit');
  assert.ok(TEST_PAUSE_LIMIT_S * 1000 > 60_000, 'the limit is past a test’s timeout');
});
