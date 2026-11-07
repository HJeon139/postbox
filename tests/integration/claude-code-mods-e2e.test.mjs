// #817 end to end: a PreToolUse hook that approves every call, in the person’s user settings and the project’s, with
// `disableAllHooks: false` in both, doesn’t run in a Postbox turn in Auto, so a push waits on the permission card. One
// real turn through each real adapter (the Claude Code CLI and the Agent SDK) asks for `git push origin
// HEAD:refs/heads/e2e`; the test answers the card no, and checks the branch never reached the remote and neither hook
// ran. A control turn through each adapter in Run everything, where Postbox keeps the person’s hooks, shows the
// fixture’s hooks do run.
//
// The harness (the fixture, the temp HOME, the turn, and when these skip) is in claude-e2e.mjs.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { landed, modelSettings, pushCard, pushTurn, sdkWhy, TURN_MS, why } from './claude-e2e.mjs';

for (const [backend, skip] of [
  ['claude-code', why],
  ['agent-sdk', sdkWhy],
]) {
  test(`#817 ${backend} in Auto: the approving hooks don’t run, the push waits on a card, and no answers no`, {
    skip,
    timeout: TURN_MS + 60_000,
  }, async (t) => {
    const r = await pushTurn(t, backend, 'auto');
    assert.ok(pushCard(r.answered), `a permission card for the push should show; the agent said: ${r.said.slice(0, 500)}`);
    assert.equal(landed(r.bare), false, 'refs/heads/e2e should not be on the remote');
    assert.equal(existsSync(r.markers.user), false, 'the user settings’ hook should not run');
    assert.equal(existsSync(r.markers.project), false, 'the project settings’ hook should not run');
  });
}

// One control per adapter, so neither adapter's “the hooks don't run” can pass because the fixture's hooks never load.
for (const [backend, skip] of [
  ['claude-code', why],
  ['agent-sdk', sdkWhy],
]) {
  test(`#817 control: ${backend} in Run everything, Postbox keeps the person’s hooks, so the fixture’s hooks run`, {
    skip,
    timeout: TURN_MS + 60_000,
  }, async (t) => {
    const r = await pushTurn(t, backend, 'bypass');
    assert.equal(existsSync(r.markers.user), true, `the user settings’ hook should run; the agent said: ${r.said.slice(0, 500)}`);
    assert.equal(existsSync(r.markers.project), true, 'the project settings’ hook should run');
  });
}

test('#817 the fixture copies only the allowlisted model settings from the person’s user settings', () => {
  const mine = {
    env: {
      AWS_REGION: 'us-west-2',
      AWS_PROFILE: 'p',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_MODEL: 'm',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h',
      ANTHROPIC_BEDROCK_BASE_URL: 'https://b',
      ANTHROPIC_DEFAULT_API_KEY_MODEL: 'k',
      ANTHROPIC_API_KEY: 'sk-secret',
      AWS_SECRET_ACCESS_KEY: 's',
      AWS_SESSION_TOKEN: 't',
      GITHUB_TOKEN: 'g',
      X_TOKEN: 'x',
      CLAUDE_CONFIG_DIR: '/elsewhere',
      // Headers can carry a credential under a name that says nothing of one.
      ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer x',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer x',
    },
    awsAuthRefresh: 'refresh',
    apiKeyHelper: 'helper',
    hooks: { PreToolUse: [] },
    permissions: { allow: ['Bash'] },
    mcpServers: { s: { command: 'x' } },
    enabledPlugins: { p: true },
    model: 'opus',
  };
  assert.deepEqual(modelSettings(mine), {
    awsAuthRefresh: 'refresh',
    apiKeyHelper: 'helper',
    env: {
      AWS_REGION: 'us-west-2',
      AWS_PROFILE: 'p',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_MODEL: 'm',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h',
      ANTHROPIC_BEDROCK_BASE_URL: 'https://b',
    },
  });
  assert.deepEqual(modelSettings(null), {});
});
