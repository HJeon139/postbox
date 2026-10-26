// Codex’s Ask me mode applies a separate approval policy to third-party MCP tools (#421).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAdapter, codexConfigArgs } from '../server/adapters/codex.mjs';
import { codexMcpPromptConfig } from '../server/adapters/codex-mcp-policy.mjs';
import { fakeAppServer } from './codex-fixture.mjs';

test('Ask me prompts for every third-party MCP tool while Postbox tools run directly', async () => {
  assert.ok(codexConfigArgs('http://127.0.0.1:1/mcp').includes('mcp_servers.postbox.default_tools_approval_mode="approve"'));

  const seen = [];
  const adapter = new CodexAdapter({
    workRoot: '/tmp/postbox-codex-test',
    spawnImpl: () => fakeAppServer(seen, { mcpServers: ['builder-mcp', 'postbox'] }),
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
    'mcp_servers.builder-mcp.default_tools_approval_mode': 'prompt',
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

test('Ask me refuses a server name that Codex cannot address as an override path', async () => {
  const request = async () => ({ data: [{ name: 'docs.with-dot' }], nextCursor: null });

  await assert.rejects(
    codexMcpPromptConfig(request, true),
    /Codex MCP server “docs\.with-dot” has a dot in its name, so Ask me can’t make its tools ask first\./,
  );
});

test('Ask me explains that it fails closed when Codex cannot list its MCP servers', async () => {
  const cause = new Error('method not found');
  const request = async () => {
    throw cause;
  };

  await assert.rejects(codexMcpPromptConfig(request, true), (error) => {
    assert.equal(error.message, 'Codex couldn’t list its MCP servers, so Ask me can’t make them ask first: method not found');
    assert.equal(error.cause, cause);
    return true;
  });
});
