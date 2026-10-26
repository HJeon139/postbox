// Codex’s Ask me mode applies a separate approval policy to third-party MCP tools (#421).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAdapter, codexConfigArgs } from '../server/adapters/codex.mjs';
import { fakeAppServer } from './codex-fixture.mjs';

test('Ask me prompts for every third-party MCP tool while Postbox tools run directly', async () => {
  assert.ok(codexConfigArgs('http://127.0.0.1:1/mcp').includes('mcp_servers.postbox.default_tools_approval_mode="approve"'));

  const seen = [];
  const adapter = new CodexAdapter({
    workRoot: '/tmp/postbox-codex-test',
    spawnImpl: () => fakeAppServer(seen, { mcpServers: ['builder-mcp', 'postbox', 'docs.with-dot'] }),
  });
  const ctx = {
    persona: { handle: 'researcher', model: 'gpt-5.6-terra', effort: 'medium', permissionMode: 'ask' },
    project: { folder: '/tmp/postbox-codex-test/project' },
    handles: ['researcher'],
    state: {},
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=s1',
    text: () => {},
    activity: () => {},
    status: () => {},
    saveState: () => {},
    checkpoint: () => {},
    pathOf: () => null,
  };

  await adapter.deliver({}, { kind: 'user', text: 'Search.' }, ctx);

  assert.ok(seen.some((request) => request.method === 'mcpServerStatus/list'));
  const opened = seen.find((request) => request.method === 'thread/start');
  assert.deepEqual(opened.params.config, {
    'mcp_servers."builder-mcp".default_tools_approval_mode': 'prompt',
    'mcp_servers."docs.with-dot".default_tools_approval_mode': 'prompt',
  });
});

test('Auto and Accept edits keep Codex’s annotation-based MCP approval policy', async () => {
  for (const permissionMode of ['auto', 'acceptEdits']) {
    const seen = [];
    const adapter = new CodexAdapter({
      workRoot: '/tmp/postbox-codex-test',
      spawnImpl: () => fakeAppServer(seen, { mcpServers: ['builder-mcp'] }),
    });
    const ctx = {
      persona: { handle: 'researcher', model: 'gpt-5.6-terra', permissionMode },
      project: { folder: '/tmp/postbox-codex-test/project' },
      handles: ['researcher'],
      state: {},
      signal: new AbortController().signal,
      mcpUrl: 'http://127.0.0.1:1/mcp?session=s2',
      text: () => {},
      activity: () => {},
      status: () => {},
      saveState: () => {},
      checkpoint: () => {},
      pathOf: () => null,
    };

    await adapter.deliver({}, { kind: 'user', text: 'Search.' }, ctx);

    assert.equal(
      seen.some((request) => request.method === 'mcpServerStatus/list'),
      false,
    );
    assert.equal(seen.find((request) => request.method === 'thread/start').params.config, undefined);
  }
});
