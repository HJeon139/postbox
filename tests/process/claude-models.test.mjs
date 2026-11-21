// Listing Claude Code’s models with real processes (server/adapters/claude-models.mjs): no hook of the person’s runs,
// and a CLI that traps SIGTERM doesn’t outlive its listing. The first needs Claude Code installed, and runs no model:
// it asks the CLI with initialize alone, in a config folder of its own whose settings hold a SessionStart hook.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { claudeModels } from '../../server/adapters/claude-models.mjs';

const claudeHere = spawnSync('claude', ['--version'], { timeout: 20_000 }).status === 0;

/** When a file last changed, from the CLI’s close. @param {number | undefined} at @param {number | undefined} closedAt */
function changed(at, closedAt) {
  if (at === undefined) return 'gone';
  if (closedAt === undefined) return 'the CLI never closed';
  return `+${Math.round(at - closedAt)} ms`;
}

/**
 * What still writes in the listing’s folder: each file left, with how long after the CLI closed it last changed, and
 * every process whose environment names the folder, by its command alone (an environment can hold secrets).
 * @param {string} dir @param {string} config @param {number | undefined} closedAt
 */
function writers(dir, config, closedAt) {
  const left = (/** @type {string} */ d) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return [`${relative(dir, d)}/ (gone)`];
    }
    return entries.flatMap((f) => {
      const p = join(d, f.name);
      if (f.isDirectory()) return left(p);
      return [`${relative(dir, p)} (${changed(statSync(p, { throwIfNoEntry: false })?.mtimeMs, closedAt)})`];
    });
  };
  const ps = (/** @type {string[]} */ args) => spawnSync('ps', args, { maxBuffer: 256 * 1024 * 1024 }).stdout?.toString() ?? '';
  const pids = ps(['eww', '-axo', 'pid=,command='])
    .split('\n')
    .filter((l) => l.includes(config))
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid);
  const procs = pids.length
    ? ps(['-o', 'pid=,ppid=,comm=', '-p', pids.join(',')])
        .trim()
        .split('\n')
    : [];
  return `files: ${left(dir).join(', ') || 'none'}; processes: ${procs.join(' | ') || 'none'}`;
}

/**
 * Removes the listing’s folder. Something the CLI started can still write there after it closed: seen once under a
 * full run’s load, never alone (#1562), so the removal retries, and when it had to, the test’s diagnostics say what
 * was still writing. Only a folder that can’t be removed at all fails the test.
 * @param {import('node:test').TestContext} t @param {string} dir @param {string} config @param {number | undefined} closedAt
 */
function removeListing(t, dir, config, closedAt) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    const report = writers(dir, config, closedAt);
    t.diagnostic(`#1562: the listing’s folder was still being written after the CLI closed, so its removal retried. ${report}`);
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    } catch (again) {
      throw new Error(`Couldn’t remove the listing’s folder: ${writers(dir, config, closedAt)}`, { cause: new AggregateError([e, again]) });
    }
  }
}

test('a listing runs none of the person’s SessionStart hooks', { skip: !claudeHere && 'Claude Code isn’t installed here' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-claude-hooks-'));
  const config = join(dir, 'config');
  /** @type {number | undefined} */
  let closedAt;
  try {
    const marker = join(dir, 'hook-ran');
    mkdirSync(config);
    const hook = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${JSON.stringify(marker)}` }] }] } };
    writeFileSync(join(config, 'settings.json'), JSON.stringify(hook));
    // The listing answers before the CLI has closed: it goes on writing in its config folder for a moment after
    // SIGTERM, so the hook is checked and the folder removed only once it has closed (#1484).
    /** @type {Promise<unknown>} */
    let closed = Promise.resolve();
    /** @type {any} */
    const spawnImpl = (bin, args, options) => {
      const child = spawn(bin, args, { ...options, env: { ...process.env, CLAUDE_CONFIG_DIR: config } });
      closed = once(child, 'close');
      return child;
    };
    const models = await claudeModels('claude', { spawnImpl });
    await closed;
    closedAt = Date.now();
    assert.ok(models.length > 0, 'it listed, so it started');
    assert.equal(existsSync(marker), false, 'the SessionStart hook in its settings didn’t run');
  } finally {
    removeListing(t, dir, config, closedAt);
  }
});

test('a CLI that traps SIGTERM is killed once its listing runs out of time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-claude-trap-'));
  try {
    // Never answers, and ignores SIGTERM.
    const script = join(dir, 'stubborn.mjs');
    writeFileSync(script, "process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\nprocess.stdin.resume();\n");
    let pid = 0;
    let closed = false;
    /** @type {any} */
    const spawnImpl = (_bin, args, options) => {
      const child = spawn(process.execPath, [script, ...args], options);
      pid = /** @type {number} */ (child.pid);
      child.on('close', () => {
        closed = true;
      });
      return child;
    };
    assert.deepEqual(await claudeModels('claude', { spawnImpl, timeoutMs: 500, graceMs: 300 }), []);
    const until = Date.now() + 5000;
    while (!closed && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    assert.ok(closed, `the CLI (pid ${pid}) was still running after SIGTERM and the grace`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
