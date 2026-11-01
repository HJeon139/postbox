// Every timer and deferred callback in server/ is placed (the 1b invariants, I1; the integrator’s reviews of #598, rule
// 14): a callback that writes to the store or kills a process does nothing while writes are closed, and a timer in
// rt.timers is re-armed from the recovered state at Retry (server/store-outage.mjs). What this checks, and what it
// doesn’t:
// - it counts, per file, every mention of setTimeout, setInterval, setImmediate, queueMicrotask, process.nextTick,
//   AbortSignal.timeout and an injected setTimer, with comments removed, against PLACED, whose rows give each file’s
//   behavior while closed; a new call, or an alias bound to one of them, fails it;
// - it fails a file that names the timers module in any import or require (`timers`, `node:timers`, either’s
//   `/promises`), whose timers it couldn’t count;
// - it reads every .mjs, .js and .cjs file under server/ except server/remote/host/, the host daemon: a new file there
//   is not counted, and is reviewed as the daemon’s;
// - it doesn’t see a timer reached by a computed name (globalThis['set' + 'Timeout']), one inside a dependency, or a
//   child process’s own `timeout` option, which kills the child and writes nothing (the integrator’s re-review of #598);
// - it checks that each file whose row says gated still carries the rule somewhere in its source, one regex per file,
//   so a removed gate beside another in the same file passes here: the behavior specs (store-outage-*) catch that;
// - a call through an alias is counted once, where the alias is bound, not at each call; an injected timer is counted
//   at each mention (its parameter, its default and its calls), so a count is a fingerprint of the file, not of calls.
// server/remote/host is the host daemon, another process with no store; the Store’s own files are listed in STORE_OWN.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

/** file → number of timer mentions (SITE), each file placed in the timers table (the 1b PR body). */
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
  'lint-delivery.mjs': 5, // an injected setTimer before a lint turn: a start, held by heldTurn while closed
  'live-streams.mjs': 2, // sends frames: reads
  'narration/narrator.mjs': 1, // stops the narrator: no store
  'permission-cards.mjs': 1, // expireWait: gated
  'persona-delete.mjs': 2, // delp: purgePersona does nothing while closed; re-armed at Retry
  'remote/host-admin.mjs': 1, // a wait: no store
  'remote/host-status.mjs': 1, // a microtask after a host event publishes host status: an emit, memory-only while closed like stream text (I1)
  'remote/hosts-links.mjs': 5, // a link’s idle timer and listener microtasks: connections, no store
  'remote/hosts-requests.mjs': 2, // request timeouts on a host link: no store
  'remote/hosts-status.mjs': 1, // a host’s heard-from timer: connection status, no store
  'remote/hosts.mjs': 5, // a reconnect’s timer: no store
  'remote/install.mjs': 5, // a wait and an injected timeout: no store
  'remote/link.mjs': 7, // passes an injected setTimer through to a host link: no store
  'remote/process-receive.mjs': 1, // an ack: no store
  'remote/process.mjs': 1, // a nextTick that starts or reads a host turn’s process after spawn returns: messages to a host, no store
  'remote/ssh-connection.mjs': 6, // a reconnect timer, and the kill, welcome and exit timers of an ssh child: no store
  'remote/ssh-reconnect.mjs': 4, // reconnect timers: no store
  'remote/turns-resume.mjs': 1, // a microtask resumes turns waiting on a host: a start, held by heldTurn while closed
  'remote/turns-snapshot.mjs': 1, // flushes conversation snapshots to hosts: reads
  'remote/turns.mjs': 5, // tick: stops a hung host turn (the outage’s stop ended the turns); a sign-in resume’s start is held
  'remote/turns-stops.mjs': 1, // a wait: no store
  'remote/wake.mjs': 2, // an injected setInterval that reconnects hosts after sleep: no store
  'runtime.mjs': 9, // the stop watchdog (turnExited defers); two Stop grace waits; a `!` command’s output flush (memory-only, I1); the mirror (skips its tick); del: and delt:, armed in two places each (do nothing while closed; re-armed at Retry)
  'scheduled-wakes.mjs': 1, // armWake: cleared and re-armed at Retry; the start is held
  'shell.mjs': 1, // SIGKILL after a Stop’s grace: Stop is allowed while closed
  'telemetry.mjs': 1, // sweeps its own folder: no store
  'thread-summary.mjs': 2, // an abort; settleThread skips while closed
  'write-intent.mjs': 1, // an abort: no store
};

/**
 * The Store’s own files, which own their own timers and are reviewed with the Store; store-outage.mjs is runtime code
 * and is counted (the integrator’s re-review of #598).
 */
const STORE_OWN = new Set([
  'store.mjs',
  'store-commit.mjs',
  'store-lock.mjs',
  'store-recover.mjs',
  'store-replay.mjs',
  'store-retry.mjs',
  'store-snapshot.mjs',
]);
/** A timer or a deferred callback: the ways server code schedules work, an injected setTimer included. */
const SITE = /\b(setTimeout|setInterval|setImmediate|queueMicrotask|nextTick|setTimer)\b|\bAbortSignal\.timeout\b/g; // every mention, so an alias is counted where it is bound
/** Timers imported under another name, or as promises, would not match SITE: such an import fails the guard instead. */
const TIMERS_IMPORT = /['"](node:)?timers(\/promises)?['"]/;
/** @type {string[]} files that import node:timers */
const imports = [];

async function sites(dir, rel = '') {
  /** @type {Record<string, number>} */
  const out = {};
  for (const e of await readdir(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (path !== 'remote/host') Object.assign(out, await sites(dir, path));
      continue;
    }
    if (!/\.(mjs|js|cjs)$/.test(e.name) || STORE_OWN.has(path)) continue;
    const code = (await readFile(join(dir, path), 'utf8')).replace(/^\s*(\/\/|\*).*$/gm, ''); // comments and JSDoc out
    const n = (code.match(SITE) ?? []).length;
    if (n) out[path] = n;
    if (TIMERS_IMPORT.test(code)) imports.push(path);
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

test('no server file imports node:timers, whose aliased or promised timers the count above can’t see', async () => {
  imports.length = 0;
  await sites(new URL('../server', import.meta.url).pathname);
  assert.deepEqual(
    imports,
    [],
    'a timer imported from node:timers: call it through setTimeout or setInterval so it is counted, or add the file here with its row',
  );
});
