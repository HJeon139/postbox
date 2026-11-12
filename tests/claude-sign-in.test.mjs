// The Loop study kit (POSTBOX_CLAUDE_SIGN_IN): an Isolated Claude Code agent on Bedrock gets the person's sign-in keys,
// as the tester does (tools/uat/tester.mjs), and never their settings' `env`. v4.0.7 had dropped it, so every
// sf-evalgen-wf1 builder turn failed with "Could not load AWS credentials" (11/12 00:54).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { claudeArgs } from '../server/adapters/claude-code-args.mjs';
import { agentSignIn } from '../server/adapters/setup.mjs';

const settingsOf = (args) => JSON.parse(args[args.indexOf('--settings') + 1]);
const base = { sessionId: 's1', resume: false, mcpUrl: 'http://127.0.0.1:1/mcp', guide: 'g' };

test('the sign-in keys come from the person’s settings only when POSTBOX_CLAUDE_SIGN_IN is set, and env never does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-sign-in-'));
  try {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ awsCredentialExport: 'cat /x/credentials.json', modelOverrides: { a: 'b' }, env: { AWS_PROFILE: 'other' }, theme: 'dark' }),
    );
    assert.deepEqual(agentSignIn({ dir, enabled: '1' }), { awsCredentialExport: 'cat /x/credentials.json', modelOverrides: { a: 'b' } });
    assert.deepEqual(agentSignIn({ dir, enabled: undefined }), {});
    assert.deepEqual(agentSignIn({ dir: join(dir, 'missing'), enabled: '1' }), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an Isolated persona’s --settings carry the sign-in; a host-setup persona’s don’t, since it loads the person’s own', () => {
  const signIn = { awsCredentialExport: 'cat /x/credentials.json' };
  const isolated = settingsOf(claudeArgs({ ...base, persona: { model: 'm', permissionMode: 'auto', usesHostSetup: false }, signIn }));
  assert.equal(isolated.awsCredentialExport, 'cat /x/credentials.json');
  const host = settingsOf(claudeArgs({ ...base, persona: { model: 'm', permissionMode: 'auto', usesHostSetup: true }, signIn }));
  assert.equal(host.awsCredentialExport, undefined);
});
