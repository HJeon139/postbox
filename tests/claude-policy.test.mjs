// A study's deny rules for every Claude Code turn (POSTBOX_CLAUDE_POLICY, server/adapters/setup.mjs claudePolicyDeny),
// passed with --settings from outside the agent's folder, so the agent can't read them there. The file is the shape of
// the UC03 kit's claude-deny-attr3.json (study/uc03-round3/kit, wip/uc03-action5-setaside 636096cc).
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeArgs, settingsFile } from '../server/adapters/claude-code-args.mjs';
import { agentSignIn, claudePolicyDeny } from '../server/adapters/setup.mjs';

const deny = ['Bash(*LoopDemo/.scratch*)', 'Read(//Volumes/workplace/LoopDemo/.scratch/**)'];
const policyFile = (body) => {
  const file = join(mkdtempSync(join(tmpdir(), 'claude-policy-')), 'policy.json');
  writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
};
const settingsOf = (args) => JSON.parse(args[args.indexOf('--settings') + 1]);
const base = { sessionId: 's', resume: false, mcpUrl: 'http://127.0.0.1:1/mcp', guide: '' };

test('the policy file’s denies reach the --settings of every turn, beside Postbox’s own rules', () => {
  const file = policyFile({ _comment: 'kit note', permissions: { deny } });
  assert.deepEqual(claudePolicyDeny(file), deny);
  assert.deepEqual(claudePolicyDeny(''), []);
  const before = process.env.POSTBOX_CLAUDE_POLICY;
  process.env.POSTBOX_CLAUDE_POLICY = file;
  try {
    for (const permissionMode of ['bypass', 'ask', 'auto']) {
      const settings = settingsOf(claudeArgs({ ...base, persona: { permissionMode, usesHostSetup: false } }));
      assert.deepEqual(settings.permissions.deny, deny);
    }
    // The ask rules Postbox adds stay.
    const ask = settingsOf(claudeArgs({ ...base, persona: { permissionMode: 'ask', usesHostSetup: false }, rules: { ask: ['Write(/x)'] } }));
    assert.ok(ask.permissions.ask.includes('Write(/x)'));
  } finally {
    if (before === undefined) delete process.env.POSTBOX_CLAUDE_POLICY;
    else process.env.POSTBOX_CLAUDE_POLICY = before;
  }
  assert.equal(settingsOf(claudeArgs({ ...base, persona: { permissionMode: 'bypass' } })).permissions?.deny, undefined);
});

test('a policy that isn’t a list of deny rules, or doesn’t parse, stops the turn rather than being dropped', () => {
  assert.throws(() => claudePolicyDeny(policyFile('{')), /POSTBOX_CLAUDE_POLICY/);
  assert.throws(() => claudePolicyDeny(policyFile({ permissions: { allow: deny } })), /deny rules/);
  assert.throws(() => claudePolicyDeny(policyFile({ permissions: { deny: [1] } })), /deny rules/);
});

// An Isolated Claude Code agent signs in to Bedrock with the default AWS credentials unless it gets the person's sign-in
// (a UC03 generation 2 check: "AWS authentication failed" after 12 retries, while the tester, which copies the sign-in,
// worked). POSTBOX_CLAUDE_SIGN_IN opts in; only the sign-in keys pass, never `env`, which would reach the agent's shell.

test('the sign-in keys reach an Isolated agent’s --settings when asked for, and nothing else of the person’s setup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-signin-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    awsCredentialExport: 'sign-in-command', modelOverrides: { a: 'b' }, env: { AWS_REGION: 'us-west-2', AWS_PROFILE: 'other' },
    permissions: { allow: ['Bash(*)'] }, hooks: { Stop: [] },
  }));
  assert.deepEqual(agentSignIn({ dir, enabled: '1' }), { awsCredentialExport: 'sign-in-command', modelOverrides: { a: 'b' } });
  assert.deepEqual(agentSignIn({ dir, enabled: '' }), {});
  const signIn = agentSignIn({ dir, enabled: '1' });
  const isolated = settingsOf(claudeArgs({ ...base, persona: { permissionMode: 'bypass', usesHostSetup: false }, signIn }));
  assert.equal(isolated.awsCredentialExport, 'sign-in-command');
  assert.equal(isolated.env, undefined);
  assert.equal(isolated.permissions?.allow, undefined);
  // A persona on the person's own setup already loads its user settings, so nothing is added.
  const host = settingsOf(claudeArgs({ ...base, persona: { permissionMode: 'bypass', usesHostSetup: true }, signIn }));
  assert.equal(host.awsCredentialExport, undefined);
});

// Critic's review of cbd4c3fd: inline --settings put the sign-in, and an account in its model overrides, on the claude
// process's command line, which the agent can read with ps. With a sign-in, the settings go in a private file instead.

test('with a sign-in, the settings go in a file only this user can read, under the denied ~/.claude, and leave argv', () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-home-'));
  const args = claudeArgs({ ...base, persona: { permissionMode: 'bypass', usesHostSetup: false }, signIn: { awsCredentialExport: 'sign-in-command' } });
  const inline = args[args.indexOf('--settings') + 1];
  const { args: moved, remove } = settingsFile(args, { dir });
  const path = moved[moved.indexOf('--settings') + 1];
  assert.ok(path.startsWith(join(dir, 'postbox-agent-settings') + '/'));
  assert.equal(readFileSync(path, 'utf8'), inline);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.ok(!moved.join(' ').includes('sign-in-command'));
  remove();
  assert.equal(existsSync(path), false);
});
