// Listing Claude Code’s models with a real CLI (server/adapters/claude-models.mjs): no hook of the person’s runs. It
// needs Claude Code installed, and runs no model: it asks the CLI with initialize alone, in a config folder of its own
// whose settings hold a SessionStart hook.

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
