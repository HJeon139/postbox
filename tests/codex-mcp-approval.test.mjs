// Codex’s Ask me mode applies a separate approval policy to third-party MCP tools (#421).
// The Ask me fixtures are claude-ssh-aarch64’s real Codex 0.164.0 runs, with IDs and internal tool details redacted.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CodexAdapter, codexApproval, codexConfigArgs } from '../server/adapters/codex.mjs';
import { codexMcpApprovalConfig } from '../server/adapters/codex-mcp-policy.mjs';
import { fakeAppServer } from './codex-fixture.mjs';

test('Ask me prompts for raw, plugin, and built-in MCP tools while Postbox tools run directly', async () => {
  assert.ok(codexConfigArgs('http://127.0.0.1:1/mcp').includes('mcp_servers.postbox.default_tools_approval_mode="approve"'));

  const seen = [];
  const adapter = new CodexAdapter({
    workRoot: '/tmp/postbox-codex-test',
    spawnImpl: () =>
      fakeAppServer(seen, {
        mcpServers: ['builder-mcp', 'postbox', { name: 'sample', pluginId: 'sample@test' }, { name: 'codex_apps' }],
      }),
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
    'plugins.sample@test.mcp_servers.sample.default_tools_approval_mode': 'prompt',
    'apps._default.default_tools_approval_mode': 'prompt',
  });
});

test('Auto sends no MCP setting, so Codex’s own reviewer and policy decide, and lists no servers', async () => {
  const permissionMode = 'auto';
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

  assert.ok(!seen.some((request) => request.method === 'mcpServerStatus/list'), 'Auto makes no inventory call, so it can’t fail on one');
  assert.equal(seen.find((request) => request.method === 'thread/start').params.config, undefined);
});

test('Accept edits prompts for every third-party MCP tool', async () => {
  const seen = [];
  const adapter = new CodexAdapter({
    workRoot: '/tmp/postbox-codex-test',
    spawnImpl: () => fakeAppServer(seen, { mcpServers: ['builder-mcp'] }),
  });
  const ctx = {
    persona: { handle: 'researcher', model: 'gpt-5.6-terra', permissionMode: 'acceptEdits' },
    project: { folder: '/tmp/postbox-codex-test/project' },
    handles: ['researcher'],
    state: {},
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=s3',
    text: () => {},
    activity: () => {},
    status: () => {},
    saveState: () => {},
    checkpoint: () => {},
    pathOf: () => null,
  };

  await adapter.deliver({}, { kind: 'user', text: 'Create.' }, ctx);

  assert.deepEqual(seen.find((request) => request.method === 'thread/start').params.config, {
    'mcp_servers.builder-mcp.default_tools_approval_mode': 'prompt',
  });
});

test('Ask me refuses a server name that Codex cannot address as an override path', async () => {
  const request = async () => ({ data: [{ name: 'docs.with-dot' }], nextCursor: null });

  await assert.rejects(
    codexMcpApprovalConfig(request, 'ask'),
    /Codex MCP server “docs\.with-dot” has a dot in its name or plugin ID, so Postbox can’t apply this permission mode to its tools\./,
  );
});

test('Ask me explains that it fails closed when Codex cannot list its MCP servers', async () => {
  const cause = new Error('method not found');
  const request = async () => {
    throw cause;
  };

  await assert.rejects(codexMcpApprovalConfig(request, 'ask'), (error) => {
    assert.equal(error.message, 'Codex couldn’t list its MCP servers, so Postbox can’t apply this permission mode to them: method not found');
    assert.equal(error.cause, cause);
    return true;
  });
});

test('real Codex Ask me streams map third-party MCP approval requests to named cards', async () => {
  for (const [fixture, allow] of [
    ['ask-mcp-allow.jsonl', true],
    ['ask-mcp-deny.jsonl', false],
  ]) {
    const events = readFileSync(new URL(`fixtures/codex-app-server/${fixture}`, import.meta.url), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    const request = events.find((event) => event.method === 'mcpServer/elicitation/request');
    const started = events.findIndex((event) => event.method === 'item/started');
    const asked = events.indexOf(request);
    const completed = events.findIndex((event) => event.method === 'item/completed');
    let card;

    const answer = await codexApproval(
      {
        askPermission: async (value) => {
          card = value;
          return { allow };
        },
      },
      request,
    );

    assert.ok(started < asked && asked < completed, `${fixture}: Codex asked before the tool completed`);
    assert.equal(card.tool, 'mcp__acme-mcp__LookupTerm');
    assert.equal(card.summary, 'use acme-mcp tool LookupTerm');
    assert.match(card.detail, /"term": "XYZ"/);
    assert.deepEqual(answer, allow ? { action: 'accept', content: {} } : { action: 'decline' });
    if (!allow) assert.equal(events[completed].params.item.durationMs, 0, 'the denied call never reached its server');
  }
});

test('real Codex plugin streams show Ask me blocks before completion and Auto runs without a card', async () => {
  const eventsOf = (name) =>
    readFileSync(new URL(`fixtures/codex-app-server/${name}`, import.meta.url), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
  const ask = eventsOf('plugin-ask-deny.jsonl');
  const inventory = ask.find((event) => event.result?.data);
  const request = ask.find((event) => event.method === 'mcpServer/elicitation/request');
  const started = ask.findIndex((event) => event.method === 'item/started');
  const completed = ask.findIndex((event) => event.method === 'item/completed');
  let card;
  const denied = await codexApproval(
    {
      askPermission: async (value) => {
        card = value;
        return { allow: false };
      },
    },
    request,
  );

  assert.equal(inventory.result.data[0].pluginId, 'pbtest@pbmarket');
  assert.ok(started < ask.indexOf(request) && ask.indexOf(request) < completed);
  assert.equal(card.tool, 'mcp__pbtest__pb_read');
  assert.equal(card.summary, 'use pbtest tool pb_read');
  assert.deepEqual(denied, { action: 'decline' });
  assert.equal(ask[completed].params.item.durationMs, 0);

  const auto = eventsOf('plugin-auto.jsonl');
  assert.equal(
    auto.some((event) => event.method === 'mcpServer/elicitation/request'),
    false,
  );
  assert.equal(auto.find((event) => event.method === 'item/completed').params.item.status, 'completed');
});
