// The hostwakes triggers on a run made on the Redis store (#508; #553’s review, blocker 4): the messages each agent
// received come from the running Postbox’s state and the followed stream, since the data folder holds no log to read.

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readReceived } from '../tools/uat/run-files.mjs';
import { HOSTWAKE_TRIGGERS as T } from '../tools/uat/triggers-hostwakes.mjs';
import { check, facts, received, s, turn } from './uat-hostwakes-fixture.mjs';

test('#553: on the Redis store, readReceived takes what each agent received from the running Postbox’s state, not from a log it hasn’t got', () => {
  // A run’s folder on the Redis store: data/ holds redis/, no snapshot or events-*.jsonl; the runner saved events.jsonl
  // (sessions cut to their state) and state.json (the whole state, each session with its agentMessages).
  const dir = mkdtempSync(join(tmpdir(), 'pb-received-'));
  cpSync(new URL('./fixtures/uat/received-redis/', import.meta.url), dir, { recursive: true });
  try {
    assert.deepEqual(readReceived(join(dir, 'data')), [], 'the data folder alone has nothing to read');
    const { state } = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    const got = readReceived(join(dir, 'data'), [], { state });
    assert.deepEqual(
      got.map((r) => [r.handle, r.from, r.text]),
      [
        ['critic', 'researcher', '@critic Ready for your task.'],
        ['critic', 'developer', '@critic, I’m ready for your task.'],
        ['researcher', 'critic', 'critic to researcher'],
      ],
      'messages each session received, in order; what a session sent isn’t received',
    );
    // The stream the runner follows adds what it saw a session hold, merged with the state’s and with earlier reads.
    const history = { received: () => [received('developer', 'researcher', s(5), 'an older one the six-cap dropped')] };
    const merged = readReceived(join(dir, 'data'), got, { state, history });
    assert.deepEqual(
      merged.map((r) => [r.handle, r.at]),
      [
        ['developer', s(5)],
        ['critic', s(11)],
        ['critic', s(31)],
        ['researcher', s(405)],
      ],
    );
    const f = { ...facts({ extraItems: [turn('critic', s(50)), turn('researcher', s(410))] }), received: got };
    const seen = T['held-wake-delivered-after-allow'].run(f);
    assert.equal(seen.length, 1, 'the refused hand-off reached @researcher after the Allow');
    assert.deepEqual(
      check('refused-wake-lost')
        .run(f)
        .map((x) => x.title),
      ['@developer’s hand-off to @critic was refused and lost'],
      'critic’s hand-off was delivered, so only developer’s is lost',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
