// Codex’s Ask me mode applies a separate approval policy to third-party MCP tools (#421).
// The Ask me fixtures are claude-ssh-aarch64’s real Codex 0.164.0 runs, with IDs and internal tool details redacted.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CodexAdapter, codexApproval, codexConfigArgs } from '../server/adapters/codex.mjs';
import { codexMcpApprovalConfig } from '../server/adapters/codex-mcp-policy.mjs';
import { CODEX_ROOT, fakeAppServer } from './codex-fixture.mjs';

test('Ask me prompts for raw, plugin, and built-in MCP tools while Postbox tools run directly', async () => {
  assert.ok(codexConfigArgs('http://127.0.0.1:1/mcp').includes('mcp_servers.postbox.default_tools_approval_mode="approve"'));

  const seen = [];
  const adapter = new CodexAdapter({
    workRoot: CODEX_ROOT,
    spawnImpl: () =>
      fakeAppServer(seen, {
        mcpServers: ['builder-mcp', 'postbox', { name: 'sample', pluginId: 'sample@test' }, { name: 'codex_apps' }],
      }),
  });
  const ctx = {
    persona: { handle: 'researcher', model: 'gpt-5.6-terra', effort: 'medium', permissionMode: 'ask' },
    project: { folder: `${CODEX_ROOT}/project` },
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
    workRoot: CODEX_ROOT,
    spawnImpl: () => fakeAppServer(seen, { mcpServers: ['builder-mcp'] }),
  });
  const ctx = {
    persona: { handle: 'researcher', model: 'gpt-5.6-terra', permissionMode },
    project: { folder: `${CODEX_ROOT}/project` },
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
    workRoot: CODEX_ROOT,
    spawnImpl: () => fakeAppServer(seen, { mcpServers: ['builder-mcp'] }),
  });
  const ctx = {
    persona: { handle: 'researcher', model: 'gpt-5.6-terra', permissionMode: 'acceptEdits' },
    project: { folder: `${CODEX_ROOT}/project` },
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

test('#1937 an MCP server’s request for input shows on its card cleaned and bounded, as Codex’s other words are', async () => {
  /** @type {any[]} */
  const asked = [];
  const ctx = {
    askPermission: async (/** @type {any} */ a) => {
      asked.push(a);
      return { allow: false };
    },
  };
  // What a server’s own message could carry: a right-to-left override, a zero-width space, a bell, a line break and a
  // line separator, and far more text than a card holds, with an emoji where the cut falls.
  const said = 'Please confirm the \u0007deploy \u202Edeliated \u202C\u200B\nnext line\u2028more ';
  // Cleaning drops three invisible characters, the bell’s extra space and the space before the line break, so the
  // emoji starts at 1,199, across the cut.
  const message = `${said}${'x'.repeat(1199 - (said.length - 5))}\u{1F600} and the rest`;
  await codexApproval(ctx, { id: 7, method: 'mcpServer/elicitation/request', params: { serverName: 'deploy', message } });
  const detail = String(asked[0]?.detail ?? '');
  assert.match(detail, /^Please confirm the deploy/);
  assert.doesNotMatch(detail, /[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2028\u2029\r]/u);
  assert.doesNotMatch(detail, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, 'no lone surrogate');
  assert.ok(detail.length <= 1200, `bounded, not ${detail.length}`);
  assert.match(detail, /deliated\nnext line\nmore/, 'a line break stays one, on a card that shows its lines; a separator becomes one');
});

test('#1937 an MCP tool’s description on its card is cleaned too: it’s the server’s words', async () => {
  /** @type {any[]} */
  const asked = [];
  const ctx = {
    askPermission: async (/** @type {any} */ a) => {
      asked.push(a);
      return { allow: false };
    },
  };
  const meta = { codex_approval_kind: 'mcp_tool_call', tool_name: 'ship', tool_description: 'Ships \u202Eliated the build.', tool_params: { to: 'prod' } };
  await codexApproval(ctx, { id: 8, method: 'mcpServer/elicitation/request', params: { serverName: 'deploy', message: '', _meta: meta } });
  const detail = JSON.parse(String(asked[0]?.detail ?? '{}'));
  assert.equal(detail.description, 'Ships liated the build.');
  assert.deepEqual(detail.arguments, { to: 'prod' }, 'the arguments as sent');
});

test('#1937 an ordinary request for input reads on its card as the server wrote it, its lines kept', async () => {
  /** @type {any[]} */
  const asked = [];
  const ctx = {
    askPermission: async (/** @type {any} */ a) => {
      asked.push(a);
      return { allow: false };
    },
  };
  const message = 'Deploy which build?\n\n- 1.4.2 (staging)\n- 1.4.1 (prod)';
  const spaced = message.replace('\n\n', '\n\n\n\n');
  await codexApproval(ctx, { id: 9, method: 'mcpServer/elicitation/request', params: { serverName: 'deploy', message } });
  assert.equal(asked[0]?.detail, message);
  await codexApproval(ctx, { id: 12, method: 'mcpServer/elicitation/request', params: { serverName: 'deploy', message: spaced } });
  assert.equal(asked[1]?.detail, message, 'no more than one blank line in a row');
});

test('#1937 an MCP tool’s name, the card’s headline, is cleaned: it comes from the server', async () => {
  /** @type {any[]} */
  const asked = [];
  const ctx = {
    askPermission: async (/** @type {any} */ a) => {
      asked.push(a);
      return { allow: false };
    },
  };
  const meta = { codex_approval_kind: 'mcp_tool_call', tool_name: 'ship\u202Edorp', tool_params: {} };
  await codexApproval(ctx, { id: 10, method: 'mcpServer/elicitation/request', params: { serverName: 'deploy', message: '', _meta: meta } });
  assert.equal(asked[0]?.summary, 'use deploy tool shipdorp');
});

test('#1937 only Postbox’s own server, by its exact name, skips the card: a look-alike cleaned to it still asks', async () => {
  /** @type {any[]} */
  const asked = [];
  const ctx = {
    askPermission: async (/** @type {any} */ a) => {
      asked.push(a);
      return { allow: false };
    },
  };
  const meta = { codex_approval_kind: 'mcp_tool_call', tool_name: 'show_block', tool_params: {} };
  const answer = await codexApproval(ctx, {
    id: 11,
    method: 'mcpServer/elicitation/request',
    params: { serverName: 'postbox\u200B', message: '', _meta: meta },
  });
  assert.equal(asked.length, 1, 'a card is shown');
  assert.deepEqual(answer, { action: 'decline' });
});
