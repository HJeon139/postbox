// The real run() of tools/signoff/deps.mjs counts a child a signal ended as a failure (#845): its exit code is null
// then, and reading null as 0 would pass a Biome or a lint that was killed partway.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultDeps } from '../../tools/signoff/deps.mjs';

test('a child that a signal ends exits non-zero, not 0', { timeout: 10_000 }, async () => {
  const r = await defaultDeps().run([process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"]);
  assert.notEqual(r.code, 0);
});

test('a child stopped through started’s kill exits non-zero, and a child that ends well exits 0', { timeout: 10_000 }, async () => {
  const run = defaultDeps().run;
  const killed = await run([process.execPath, '-e', 'setTimeout(() => {}, 30_000)'], { started: (kill) => kill('SIGTERM') });
  assert.notEqual(killed.code, 0);
  const ok = await run([process.execPath, '-e', "console.log('ok')"]);
  assert.deepEqual(ok, { code: 0, out: 'ok\n' });
});
