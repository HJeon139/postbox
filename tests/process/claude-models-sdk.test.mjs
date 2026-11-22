// Listing the Agent SDK’s models with its real CLI (sdkModels in server/adapters/claude-models.mjs): no SessionStart
// hook of the person’s runs, as for Claude Code’s own listing (#1302). It needs the SDK installed, and runs no model: the
// query is sent no message, in a config folder of its own whose settings hold a SessionStart hook.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sdkModels } from '../../server/adapters/claude-models.mjs';
import { removeListing } from './listing-folder.mjs';

/** @type {any} */
let sdk = null;
try {
  sdk = await import('@anthropic-ai/claude-agent-sdk');
} catch {} // Not installed (it’s optional): the test is skipped.

test('an Agent SDK listing runs none of the person’s SessionStart hooks', { skip: !sdk && 'the Agent SDK isn’t installed here' }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-sdk-hooks-'));
  /** @type {number | undefined} */
  let closedAt;
  try {
    const marker = join(dir, 'hook-ran');
    const config = join(dir, 'config');
    mkdirSync(config);
    const hook = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${JSON.stringify(marker)}` }] }] } };
    writeFileSync(join(config, 'settings.json'), JSON.stringify(hook));
    // The CLI closes after the listing answers, and goes on writing in its config folder until it has: the hook is
    // checked and the folder removed only once it has closed (#1484).
    /** @type {Promise<unknown>} */
    let closed = Promise.resolve();
    /** @type {any} */
    const spawnClaudeCodeProcess = ({ command, args, cwd, env, signal }) => {
      const child = spawn(command, args, { cwd, env: { ...env, CLAUDE_CONFIG_DIR: config }, signal, stdio: ['pipe', 'pipe', 'ignore'] });
      closed = once(child, 'close');
      return child;
    };
    const atHome = { query: (/** @type {any} */ q) => sdk.query({ ...q, options: { ...q.options, spawnClaudeCodeProcess } }) };
    const models = await sdkModels(atHome);
    await closed;
    closedAt = Date.now();
    assert.ok(models.length > 0, 'it listed, so it started');
    assert.equal(existsSync(marker), false, 'the SessionStart hook in its settings didn’t run');
  } finally {
    // The same folder, and the same race, as the CLI’s own listing’s (#1562).
    removeListing(t, dir, closedAt);
  }
});
