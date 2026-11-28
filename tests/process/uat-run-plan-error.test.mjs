// #482: the runner’s plan (its scenario and options) is made before main() starts, so the run's folder is known for
// run.json’s exit code. A plan that throws must still fail as a run does, said and exiting 1, not crash with a stack
// and no word from the runner. It stops before any Postbox or agent starts.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('../../tools/uat-run.mjs', import.meta.url));

test('an unknown scenario fails as a run does: “UAT run failed:”, and exit 1', () => {
  const r = spawnSync(process.execPath, [runner, '--scenario', 'no-such-scenario-482'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^UAT run failed: /m, r.stderr);
});
