// A Claude Code mod, or any hook in the person’s settings or plugins, that approves a call in its tool check skips
// Postbox’s ask rules for writes outside (WRITE_TOOLS, #112) and its permission prompt (#817, confirmed by #806). So in
// the modes where Postbox adds those ask rules (Ask me and Accept edits), its own settings overlay (`--settings`, the
// SDK’s `settings`, a host turn’s `--settings`) carries `disableAllHooks: true`. It sits in the flag-settings layer,
// above user, project and local settings, so a `disableAllHooks: false` in any of them doesn’t undo it; hooks from
// managed settings still run. In Auto (harness first, #961) Postbox adds no ask rules for writes, so there’s no card
// for a hook to skip: the person’s hooks run, as in their terminal, and so in an unset or unknown mode (which runs as
// Auto) and in bypass (#806).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sdkOptions } from '../server/adapters/agent-sdk.mjs';
import { claudeArgs } from '../server/adapters/claude-code.mjs';
import { settingsFor, shimServer, WRITE_TOOLS, writeRules } from '../server/adapters/setup.mjs';

// Each mode as a persona stores it, and whether Postbox’s turns turn hooks off in it. Undefined and an unknown value
// (a plan mode Postbox doesn’t have, a typo) run as Auto.
const HOOKS_OFF = new Map([
  ['ask', true],
  ['acceptEdits', true],
  ['auto', false],
  [undefined, false],
  ['plan', false],
  ['not-a-mode', false],
]);
// Host setup (undefined is the default, as for personas from before the choice existed) and Isolated.
const SETUPS = [undefined, true, false];
const cliBase = { sessionId: 's', resume: false, mcpUrl: 'http://x/mcp', guide: 'g' };
const sdkBase = { cwd: '/w', sessionId: 's', resume: false, mcpUrl: 'u', guide: 'g', abortController: new AbortController() };
const after = (args, flag) => args[args.indexOf(flag) + 1];
const cliSettings = (args) => JSON.parse(after(args, '--settings'));
const conversationRules = { ask: ['Bash(npm publish:*)'] };
/** The whole overlay a turn in this mode gets, with the conversation’s ask rule. */
const overlay = (off) => ({
  outputStyle: 'default',
  ...(off ? { disableAllHooks: true } : {}),
  permissions: { ask: [...(off ? WRITE_TOOLS : []), 'Bash(npm publish:*)'] },
});

test('a Claude Code turn’s --settings turns hooks and mods off in Ask me and Accept edits only, with either setup', () => {
  for (const [permissionMode, off] of HOOKS_OFF) {
    for (const usesHostSetup of SETUPS) {
      const label = `mode ${permissionMode}, host setup ${usesHostSetup}`;
      const args = claudeArgs({ ...cliBase, persona: { model: 'mock', permissionMode, usesHostSetup }, rules: conversationRules });
      assert.deepEqual(cliSettings(args), overlay(off), label);
      // The fix sits beside what reaches a card, and takes none of it away.
      assert.equal(after(args, '--permission-prompt-tool'), 'mcp__postbox__permission_prompt', label);
      assert.equal(after(args, '--setting-sources'), usesHostSetup === false ? 'project,local' : 'user,project,local', label);
    }
  }
});

test('an Agent SDK turn’s settings turn hooks and mods off in Ask me and Accept edits only, with either setup', () => {
  const canUseTool = async () => ({ behavior: 'deny', message: 'test' });
  for (const [permissionMode, off] of HOOKS_OFF) {
    for (const usesHostSetup of SETUPS) {
      const label = `mode ${permissionMode}, host setup ${usesHostSetup}`;
      const o = sdkOptions({ ...sdkBase, canUseTool, persona: { model: 'mock', permissionMode, usesHostSetup }, rules: conversationRules });
      assert.deepEqual(o.settings, overlay(off), label);
      assert.equal(o.canUseTool, canUseTool, label);
      assert.deepEqual(o.settingSources, usesHostSetup === false ? ['project', 'local'] : ['user', 'project', 'local'], label);
    }
  }
});

test('the overlay that turns hooks off still carries the conversation’s ask rules, the memory folder and the servers turned off', () => {
  const persona = { model: 'mock', permissionMode: 'ask', mcpOff: ['github'] };
  const want = {
    outputStyle: 'default',
    autoMemoryDirectory: '/m',
    deniedMcpServers: [{ serverName: 'github' }],
    disableAllHooks: true,
    permissions: { ask: [...WRITE_TOOLS, 'Bash(npm publish:*)'] },
  };
  const args = claudeArgs({ ...cliBase, persona, rules: conversationRules, memoryDir: '/m' });
  assert.deepEqual(cliSettings(args), want);
  const o = sdkOptions({ ...sdkBase, persona, rules: conversationRules, memoryDir: '/m' });
  assert.deepEqual(o.settings, want);
});

test('a host turn follows the same rule per mode, with its shim and with prompts turned off (--permission-prompts none)', () => {
  const server = shimServer({ command: 'node', args: ['shim.mjs', 't'], timeout: 1000 });
  for (const [permissionMode, off] of HOOKS_OFF) {
    for (const denyPrompts of [false, true]) {
      const label = `mode ${permissionMode}, denyPrompts ${denyPrompts}`;
      const args = claudeArgs({ ...cliBase, persona: { model: 'mock', permissionMode }, server, denyPrompts, rules: conversationRules });
      assert.deepEqual(cliSettings(args), overlay(off), label);
      assert.equal(args.includes('--permission-prompts'), denyPrompts, label);
    }
  }
});

test('hooks are off in exactly the modes that get Postbox’s ask rules for writes, so the two can’t drift apart', () => {
  for (const permissionMode of [...HOOKS_OFF.keys(), 'bypass']) {
    const persona = { model: 'mock', permissionMode };
    assert.equal(settingsFor(persona).disableAllHooks === true, writeRules(persona).length > 0, `mode ${permissionMode}`);
  }
});

// Bypass runs every call with no ask rule and no prompt, so a mod that approves can’t skip anything there, and the
// person’s own hooks may be the only check left: bypass keeps them, and its overlay is what it was.
test('bypass keeps the person’s hooks: its overlay has no disableAllHooks and no ask rules, in both adapters', () => {
  for (const usesHostSetup of SETUPS) {
    const label = `host setup ${usesHostSetup}`;
    const persona = { model: 'mock', permissionMode: 'bypass', usesHostSetup };
    const args = claudeArgs({ ...cliBase, persona });
    assert.deepEqual(cliSettings(args), { outputStyle: 'default' }, label);
    assert.ok(!args.includes('--permission-prompt-tool'), label);
    const o = sdkOptions({ ...sdkBase, persona });
    assert.deepEqual(o.settings, { outputStyle: 'default' }, label);
    assert.equal(o.allowDangerouslySkipPermissions, true, label);
  }
});
