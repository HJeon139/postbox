// A Claude Code mod, or any hook in the person’s settings or plugins, that approves a call in its tool check skips
// Postbox’s ask rules for writes outside (WRITE_TOOLS, #112) and its permission prompt (#817, confirmed by #806). So
// in every mode but bypass, Postbox’s own settings overlay (`--settings`, the SDK’s `settings`) carries
// `disableAllHooks: true`. It sits in the flag-settings layer, above user, project and local settings, so a
// `disableAllHooks: false` in any of them doesn’t undo it; hooks from managed settings still run.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sdkOptions } from '../server/adapters/agent-sdk.mjs';
import { claudeArgs } from '../server/adapters/claude-code.mjs';
import { shimServer } from '../server/adapters/setup.mjs';

// Every mode but bypass, as a persona stores it; undefined and an unknown value both run as auto.
const ASKING_MODES = [undefined, 'auto', 'ask', 'acceptEdits', 'not-a-mode'];
// Host setup (undefined is the default, as for personas from before the choice existed) and Isolated.
const SETUPS = [undefined, true, false];
const cliBase = { sessionId: 's', resume: false, mcpUrl: 'http://x/mcp', guide: 'g' };
const sdkBase = { cwd: '/w', sessionId: 's', resume: false, mcpUrl: 'u', guide: 'g', abortController: new AbortController() };
const after = (args, flag) => args[args.indexOf(flag) + 1];
const cliSettings = (args) => JSON.parse(after(args, '--settings'));
const conversationRules = { ask: ['Bash(npm publish:*)'] };

test('a Claude Code turn’s --settings turns off hooks and mods in every mode but bypass, with either setup', () => {
  for (const permissionMode of ASKING_MODES) {
    for (const usesHostSetup of SETUPS) {
      const label = `mode ${permissionMode}, host setup ${usesHostSetup}`;
      const args = claudeArgs({ ...cliBase, persona: { model: 'mock', permissionMode, usesHostSetup }, rules: conversationRules });
      assert.equal(cliSettings(args).disableAllHooks, true, label);
      // The fix sits beside what reaches a card, and takes none of it away.
      assert.equal(after(args, '--permission-prompt-tool'), 'mcp__postbox__permission_prompt', label);
      assert.equal(after(args, '--setting-sources'), usesHostSetup === false ? 'project,local' : 'user,project,local', label);
    }
  }
});

test('an Agent SDK turn’s settings turn off hooks and mods in every mode but bypass, with either setup', () => {
  const canUseTool = async () => ({ behavior: 'deny', message: 'test' });
  for (const permissionMode of ASKING_MODES) {
    for (const usesHostSetup of SETUPS) {
      const label = `mode ${permissionMode}, host setup ${usesHostSetup}`;
      const o = sdkOptions({ ...sdkBase, canUseTool, persona: { model: 'mock', permissionMode, usesHostSetup }, rules: conversationRules });
      assert.equal(o.settings.disableAllHooks, true, label);
      assert.equal(o.canUseTool, canUseTool, label);
      assert.deepEqual(o.settingSources, usesHostSetup === false ? ['project', 'local'] : ['user', 'project', 'local'], label);
    }
  }
});

test('the overlay that turns hooks off still carries the conversation’s ask rules, the memory folder and the servers turned off', () => {
  const persona = { model: 'mock', permissionMode: 'auto', mcpOff: ['github'] };
  const want = {
    outputStyle: 'default',
    autoMemoryDirectory: '/m',
    deniedMcpServers: [{ serverName: 'github' }],
    disableAllHooks: true,
    // In Auto, only the conversation’s own ask rules: Postbox adds none of its own (harness first).
    permissions: { ask: ['Bash(npm publish:*)'] },
  };
  const args = claudeArgs({ ...cliBase, persona, rules: conversationRules, memoryDir: '/m' });
  assert.deepEqual(cliSettings(args), want);
  const o = sdkOptions({ ...sdkBase, persona, rules: conversationRules, memoryDir: '/m' });
  assert.deepEqual(o.settings, want);
});

test('a host turn turns hooks off too, with its shim and with prompts turned off (--permission-prompts none)', () => {
  const server = shimServer({ command: 'node', args: ['shim.mjs', 't'], timeout: 1000 });
  for (const denyPrompts of [false, true]) {
    const args = claudeArgs({ ...cliBase, persona: { model: 'mock', permissionMode: 'auto' }, server, denyPrompts });
    assert.equal(cliSettings(args).disableAllHooks, true, `denyPrompts ${denyPrompts}`);
    assert.equal(args.includes('--permission-prompts'), denyPrompts);
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
