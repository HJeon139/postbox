// Listing Claude Code’s models with real processes (server/adapters/claude-models.mjs): no hook of the person’s runs,
// and a CLI that traps SIGTERM doesn’t outlive its listing. The first needs Claude Code installed, and runs no model:
// it asks the CLI with initialize alone, in a config folder of its own whose settings hold a SessionStart hook.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeModels } from '../../server/adapters/claude-models.mjs';

const claudeHere = spawnSync('claude', ['--version'], { timeout: 20_000 }).status === 0;

test('a listing runs none of the person’s SessionStart hooks', { skip: !claudeHere && 'Claude Code isn’t installed here' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-claude-hooks-'));
  try {
    const marker = join(dir, 'hook-ran');
    const config = join(dir, 'config');
    mkdirSync(config);
    const hook = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${JSON.stringify(marker)}` }] }] } };
    writeFileSync(join(config, 'settings.json'), JSON.stringify(hook));
    /** @type {any} */
    const spawnImpl = (bin, args, options) => spawn(bin, args, { ...options, env: { ...process.env, CLAUDE_CONFIG_DIR: config } });
    const models = await claudeModels('claude', { spawnImpl });
    assert.ok(models.length > 0, 'it listed, so it started');
    assert.equal(existsSync(marker), false, 'the SessionStart hook in its settings didn’t run');
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
