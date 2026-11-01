// Every timer and poller in server/ is placed (the 1b invariants, I1; the integrator’s review of #598, rule 14): a
// callback that writes to the store or kills a process does nothing while writes are closed, and a timer in rt.timers is
// re-armed from the recovered state at Retry (server/store-outage.mjs). Timers taken through an injected setTimer
// (lint-delivery.mjs, remote/wake.mjs, remote/turns.mjs’s flush) count where they are called with parentheses. The table of sites and their behavior is in the
// 1b PR body and docs/508/storage-design.md; this spec counts the setTimeout and setInterval sites per file, so a new
// one fails here until it has a row there and a count here. server/remote/host is the host daemon, another process
// with no store, and is left out; the store’s own files are its own concern.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

/** file → number of `setTimeout(` and `setInterval(` sites, each placed in the timers table (the 1b PR body). */
const PLACED = {
  'adapters/agy-hook.mjs': 1, // a request’s socket timeout: no store
  'adapters/antigravity-cli.mjs': 2, // kills a CLI probe: no store
  'adapters/claude-code.mjs': 1, // kills a CLI probe: no store
  'adapters/codex-models.mjs': 2, // kills a CLI probe: no store
  'adapters/codex-remote.mjs': 1, // an interrupt’s reach: no store
  'adapters/kiro-cli-models.mjs': 2, // kills a CLI probe: no store
  'adapters/mock.mjs': 1, // the mock’s pacing: no store
  'adapters/process-group.mjs': 4, // SIGKILL after a Stop’s grace: Stop is allowed while closed
  'kept-jobs.mjs': 1, // pollKept: skips its tick while closed
  'live-streams.mjs': 2, // sends frames: reads
  'narration/narrator.mjs': 1, // stops the narrator: no store
  'permission-cards.mjs': 1, // expireWait: gated
  'persona-delete.mjs': 2, // delp: purgePersona does nothing while closed; re-armed at Retry
  'remote/host-admin.mjs': 1, // a wait: no store
  'remote/hosts.mjs': 1, // a reconnect’s timer: no store
  'remote/install.mjs': 1, // a wait: no store
  'remote/process-receive.mjs': 1, // an ack: no store
  'remote/ssh-connection.mjs': 1, // a reconnect’s timer: no store
  'remote/ssh-reconnect.mjs': 1, // a reconnect’s timer: no store
  'remote/turns.mjs': 1, // tick: stops a hung host turn (the outage’s stop ended the turns); a sign-in resume’s start is held
  'remote/turns-stops.mjs': 1, // a wait: no store
  'runtime.mjs': 9, // the stop watchdog (turnExited defers); two Stop grace waits; a `!` command’s output flush (memory-only, I1); the mirror (skips its tick); del: and delt:, armed in two places each (do nothing while closed; re-armed at Retry)
  'scheduled-wakes.mjs': 1, // armWake: cleared and re-armed at Retry; the start is held
  'shell.mjs': 1, // SIGKILL after a Stop’s grace: Stop is allowed while closed
  'telemetry.mjs': 1, // sweeps its own folder: no store
  'thread-summary.mjs': 2, // an abort; settleThread skips while closed
  'write-intent.mjs': 1, // an abort: no store
};

async function sites(dir, rel = '') {
  /** @type {Record<string, number>} */
  const out = {};
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (path !== 'remote/host') Object.assign(out, await sites(dir, path));
      continue;
    }
    if (!e.name.endsWith('.mjs') || e.name.startsWith('store')) continue;
    const code = (await readFile(join(dir, path), 'utf8')).replace(/^\s*(\/\/|\*).*$/gm, ''); // comments and JSDoc out
    const n = (code.match(/\b(setTimeout|setInterval)\(/g) ?? []).length;
    if (n) out[path] = n;
  }
  return out;
}

/** Files whose row says the callback is gated: each must carry the rule in its source, so it can’t be dropped silently. */
const GATED = ['kept-jobs.mjs', 'permission-cards.mjs', 'persona-delete.mjs', 'runtime.mjs', 'thread-summary.mjs'];
const RULE = /\bstore\.writable\b|\bwhenWritable\(|\bgated\(/;

test('every file whose timers table row says “gated” checks the store, defers through whenWritable or runs through gated()', async () => {
  const dir = new URL('../server', import.meta.url).pathname;
  for (const f of GATED) assert.match(await readFile(join(dir, f), 'utf8'), RULE, `${f} dropped the rule its timers table row promises`);
});

test('every setTimeout and setInterval in server/ is placed in the timers table, with its behavior while the store is closed', async () => {
  const found = await sites(new URL('../server', import.meta.url).pathname);
  assert.deepEqual(
    found,
    PLACED,
    'a timer was added, moved or removed: give it a row in the timers table (the 1b PR body, docs/508/storage-design.md) saying what it does while the store is closed, and update PLACED here',
  );
});
