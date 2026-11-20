// PR #1515’s review: agy runs its PreToolUse hook through /bin/sh -c and fails open on empty stdout under
// --dangerously-skip-permissions, so a hook whose `#!/usr/bin/env node` finds no node, as from launchd, would let
// every call through. The command Postbox writes names this Node, so it answers with no node on PATH. It runs the
// command as agy would, in a shell, which only a process test may.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HOOK_SCRIPT } from '../../server/adapters/agy-hook.mjs';
import { agyHookCommand, probeAgyHook } from '../../server/adapters/agy-hook-check.mjs';

test('the hook’s command answers with no node on PATH', { skip: process.platform === 'win32' && 'agy runs hooks with /bin/sh' }, () => {
  const command = agyHookCommand(HOOK_SCRIPT);
  assert.ok(command?.startsWith(`${process.execPath} `), String(command));
  const call = { toolCall: { name: 'call_mcp_tool', args: { ServerName: 'postbox_postbox', ToolName: 'permission_prompt' } } };
  const env = { PATH: '/nonexistent', HOME: process.env.HOME ?? '/' };
  const out = spawnSync('/bin/sh', ['-c', String(command)], { input: JSON.stringify(call), env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).decision, 'deny', out.stderr);
});

test('the hook’s command answers from a path with a space', { skip: process.platform === 'win32' && 'agy runs hooks with /bin/sh' }, (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pb agy hook '));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = join(dir, 'agy-hook.mjs');
  symlinkSync(HOOK_SCRIPT, script);
  const command = agyHookCommand(script);
  assert.ok(command, 'quoted, not refused');
  const call = { toolCall: { name: 'call_mcp_tool', args: { ServerName: 'postbox_postbox', ToolName: 'permission_prompt' } } };
  const out = spawnSync('/bin/sh', ['-c', String(command)], { input: JSON.stringify(call), env: { PATH: '/nonexistent' }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(JSON.parse(out.stdout).decision, 'deny', out.stderr);
});

// PR #1515’s second review: a hook whose import broke still passed the check, since it read only hooks.json and the
// script’s path. The check now runs the hook once on a web search, as Run everything with Web off, and wants deny.
test('the hook check runs the hook, and fails one that can’t answer or doesn’t refuse', async (t) => {
  assert.equal(await probeAgyHook(HOOK_SCRIPT), true);
  const dir = mkdtempSync(join(tmpdir(), 'pb-agy-probe-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const broken = join(dir, 'broken.mjs');
  writeFileSync(broken, "import './missing.mjs';\n");
  assert.equal(await probeAgyHook(broken), false, 'a broken import prints nothing');
  const allows = join(dir, 'allows.mjs');
  writeFileSync(allows, 'process.stdout.write(\'{"decision":"allow"}\\n\');\n');
  assert.equal(await probeAgyHook(allows), false, 'a hook that allows the web search');
  assert.equal(await probeAgyHook(join(dir, 'missing.mjs')), false);
});
