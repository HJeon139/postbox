// The suites leave nothing in their temp folder (#797): npm test and npm run test:integration run with TMPDIR set to an
// empty folder of this test’s own, under /tmp so the socket fixtures use it too, and every entry left there afterwards
// is a test that didn’t remove its folder. Playwright’s and Node’s own entries are out of scope. This runs the suites
// themselves, so it takes as long as they do; it’s the deterministic check the issue asks for.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeAll } from '../../tools/gate-tmp.mjs';
import { SLOT_DIR } from '../../tools/heavy-lock.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT_OF_SCOPE = /^(playwright[-_]|node-compile-cache$|mcs-telemetry-)/;

/** What `npm run <script>` leaves in an empty TMPDIR of its own: the entries, and how the run ended. */
function leftovers(/** @type {import('node:test').TestContext} */ t, /** @type {string} */ script, /** @type {number} */ timeout) {
  const dir = fs.mkdtempSync('/tmp/pb-leak-');
  t.after(() => removeAll(fs, dir));
  const env = { ...process.env, TMPDIR: dir, POSTBOX_HEAVY_DIR: SLOT_DIR };
  // Without this, the suite’s node --test reports to this one’s runner instead of running as a run of its own.
  delete env.NODE_TEST_CONTEXT;
  const options = { cwd: ROOT, env, timeout, encoding: /** @type {const} */ ('utf8'), maxBuffer: 1 << 28 };
  const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '-s', script], options);
  const left = fs.readdirSync(dir).filter((name) => !OUT_OF_SCOPE.test(name));
  // A suite that ran nothing leaves nothing: the count is a finding only once its tests ran.
  // Node 24 reports “ℹ tests N”; Node 22 reports TAP’s “# tests N”.
  const ran = Number(/^(?:ℹ|#) tests (\d+)$/m.exec(r.stdout ?? '')?.[1] ?? 0);
  return { left, ran, status: r.status, signal: r.signal };
}

/** The entries’ names with their random part cut, counted, so a failure says which helpers leak. */
const byPrefix = (/** @type {string[]} */ names) =>
  Object.entries(Object.groupBy(names, (n) => n.replace(/[A-Za-z0-9]{6}$/, '…')))
    .map(([p, l]) => `${p} ×${l?.length}`)
    .join(', ');

test('npm test leaves nothing in its temp folder', { skip: process.platform === 'win32' && 'needs /tmp', timeout: 660_000 }, (t) => {
  const { left, ran, status, signal } = leftovers(t, 'test', 600_000);
  assert.ok(ran > 1000, `npm test ran ${ran} tests (exit ${status ?? signal})`);
  assert.equal(left.length, 0, `npm test (exit ${status ?? signal}) left ${left.length} entries: ${byPrefix(left)}`);
});

test('npm run test:integration leaves nothing in its temp folder', { skip: process.platform === 'win32' && 'needs /tmp', timeout: 660_000 }, (t) => {
  const { left, ran, status, signal } = leftovers(t, 'test:integration', 600_000);
  assert.ok(ran > 10, `npm run test:integration ran ${ran} tests (exit ${status ?? signal})`);
  assert.equal(left.length, 0, `npm run test:integration (exit ${status ?? signal}) left ${left.length} entries: ${byPrefix(left)}`);
});
