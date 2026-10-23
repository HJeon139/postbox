import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CODEX_CAPABILITIES, CodexAdapter, codexApproval, codexConfigArgs, codexPermissions, createCodexMapper } from '../server/adapters/codex.mjs';

test('Codex reports the capabilities its app-server implements', () => {
  assert.deepEqual(CODEX_CAPABILITIES, {
    resume: true,
    fork: true,
    permissions: 'none',
    tools: 'none',
    isolation: false,
    remote: { stdin: 'held', env: [], server: 'codex-config', work: 'model-checks', signInError: null },
  });
  assert.deepEqual(codexPermissions({ permissionMode: 'ask' }, '/work'), {
    sandboxPolicy: { type: 'readOnly' },
    approvalPolicy: 'on-request',
  });
  assert.deepEqual(codexPermissions({ permissionMode: 'acceptEdits' }, '/work'), {
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/work'], networkAccess: false },
    approvalPolicy: 'on-request',
  });
  assert.deepEqual(codexPermissions({ permissionMode: 'bypass' }, '/work'), {
    sandboxPolicy: { type: 'dangerFullAccess' },
    approvalPolicy: 'never',
  });
});

test('Codex config attaches Postbox MCP through the local HTTP endpoint', () => {
  assert.deepEqual(codexConfigArgs('http://127.0.0.1:4173/mcp?session=s1'), [
    '-c',
    'mcp_servers.postbox.url="http://127.0.0.1:4173/mcp?session=s1"',
    '-c',
    'mcp_servers.postbox.enabled=true',
    '-c',
    'mcp_servers.postbox.required=true',
  ]);
});

test('Codex command approvals become Postbox permission cards without unsupported Always allow rules', async () => {
  let requested;
  const allowed = await codexApproval(
    {
      askPermission: async (req) => {
        requested = req;
        return { allow: true };
      },
    },
    { method: 'item/commandExecution/requestApproval', params: { itemId: 'cmd_1', command: 'touch ../outside.txt', cwd: '/work' } },
  );
  assert.deepEqual(allowed, { decision: 'accept' });
  assert.deepEqual(requested, {
    tool: 'Bash',
    summary: 'run a command',
    detail: 'touch ../outside.txt\n\nWorking directory: /work',
    toolUseId: 'cmd_1',
    suppressAlways: true,
  });
  const denied = await codexApproval(
    { askPermission: async () => ({ allow: false }) },
    { method: 'item/fileChange/requestApproval', params: { itemId: 'file_1', grantRoot: '/workspace' } },
  );
  assert.deepEqual(denied, { decision: 'decline' });
});

test('Codex Postbox MCP tool requests are approved in the MCP elicitation protocol without permission cards', async () => {
  let asked = false;
  const answer = await codexApproval(
    {
      askPermission: async () => {
        asked = true;
        return { allow: false };
      },
    },
    {
      id: 44,
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'postbox',
        mode: 'form',
        message: 'Allow the postbox MCP server to run tool "show_block"?',
        _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'show_block', tool_params: { block: { type: 'card' } } },
        requestedSchema: { type: 'object', properties: {} },
      },
    },
  );
  assert.deepEqual(answer, { action: 'accept', content: {} });
  assert.equal(asked, false);
});

test('Codex external MCP tool approvals show tool details and return elicitation decisions', async () => {
  const request = {
    id: 45,
    method: 'mcpServer/elicitation/request',
    params: {
      serverName: 'github',
      mode: 'form',
      message: 'Allow the github MCP server to run tool "create_issue"?',
      _meta: {
        codex_approval_kind: 'mcp_tool_call',
        tool_description: 'Create a GitHub issue.',
        tool_params: { title: 'Fix it' },
      },
      requestedSchema: { type: 'object', properties: {} },
    },
  };
  let permission;
  const accepted = await codexApproval(
    {
      askPermission: async (req) => {
        permission = req;
        return { allow: true };
      },
    },
    request,
  );
  assert.deepEqual(accepted, { action: 'accept', content: {} });
  assert.deepEqual(permission, {
    tool: 'mcp__github__create_issue',
    summary: 'use github tool create_issue',
    detail: '{\n  "description": "Create a GitHub issue.",\n  "arguments": {\n    "title": "Fix it"\n  }\n}',
    toolUseId: 45,
    suppressAlways: true,
  });
  assert.deepEqual(await codexApproval({ askPermission: async () => ({ allow: false }) }, request), { action: 'decline' });
});

test('a Codex MCP approval without its kind is still a tool call, named from its message, never a generic prompt (#150)', async () => {
  let permission;
  const answer = await codexApproval(
    {
      askPermission: async (req) => {
        permission = req;
        return { allow: true };
      },
    },
    {
      id: 46,
      method: 'mcpServer/elicitation/request',
      params: { serverName: 'github', message: 'Allow the github MCP server to run tool "create_issue"?', _meta: { tool_params: { title: 'Fix it' } } },
    },
  );
  assert.deepEqual(answer, { action: 'accept', content: {} });
  assert.equal(permission.tool, 'mcp__github__create_issue');
  assert.equal(permission.summary, 'use github tool create_issue');
  assert.match(permission.detail, /"title": "Fix it"/);
  // Postbox’s own tools still run without a card when only the message names them.
  let asked = false;
  const own = await codexApproval(
    {
      askPermission: async () => {
        asked = true;
        return { allow: false };
      },
    },
    { id: 47, method: 'mcpServer/elicitation/request', params: { serverName: 'postbox', message: 'Allow the postbox MCP server to run tool "define_term"?' } },
  );
  assert.deepEqual(own, { action: 'accept', content: {} });
  assert.equal(asked, false);
});

test('the recorded app-server stream maps text and command activity to Postbox', () => {
  const calls = { text: '', activity: [], status: [] };
  const ctx = {
    text: (text) => {
      calls.text += text;
    },
    activity: (activity) => calls.activity.push(activity),
    status: (status) => calls.status.push(status),
    checkpoint: (checkpoint) => {
      calls.checkpoint = checkpoint;
    },
    state: { codexThreadId: 'thr_postbox_1' },
  };
  const mapper = createCodexMapper(ctx);
  for (const line of readFileSync(new URL('fixtures/codex-app-server/turn.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)) {
    const event = JSON.parse(line);
    if (event.method) mapper.push(event);
  }
  assert.equal(calls.text, 'Hello from Codex.');
  assert.equal(calls.activity.length, 2);
  assert.equal(calls.activity[0].state, 'running');
  assert.equal(calls.activity[1].state, 'done');
  assert.deepEqual(calls.checkpoint, { turnId: 'turn_postbox_1', threadId: 'thr_postbox_1' });
});

function fakeAppServer(seen, { hold = false, error = null, then = 'complete' } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => {
    child.emit('close', 0);
    return true;
  };
  let buffer = '';
  child.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    let n;
    while ((n = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, n);
      buffer = buffer.slice(n + 1);
      if (!line) continue;
      const req = JSON.parse(line);
      seen.push(req);
      if (req.method === 'initialize') child.stdout.write(`${JSON.stringify({ id: req.id, result: {} })}\n`);
      if (['thread/start', 'thread/resume', 'thread/fork'].includes(req.method)) {
        const id = req.method === 'thread/fork' ? 'thr_branch' : req.method === 'thread/resume' ? req.params.threadId : 'thr_fake';
        child.stdout.write(`${JSON.stringify({ id: req.id, result: { thread: { id } } })}\n`);
      }
      if (req.method === 'turn/start') {
        child.stdout.write(`${JSON.stringify({ id: req.id, result: { turn: { id: 'turn_fake', status: 'inProgress' } } })}\n`);
        if (hold) continue;
        // A turn that fails: Codex reports why in an error notification, then ends the turn as failed, or exits.
        if (error)
          setImmediate(() => {
            child.stdout.write(`${JSON.stringify({ method: 'error', params: { error: { message: error } } })}\n`);
            if (then === 'complete')
              child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn_fake', status: 'failed' } } })}\n`);
            else child.emit('close', 1);
          });
        else
          setImmediate(() => {
            child.stdout.write(`${JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: 'reply' } })}\n`);
            child.stdout.write(`${JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn_fake', status: 'completed' } } })}\n`);
          });
      }
    }
  });
  return child;
}

test('a turn starts and saves a Codex thread and supplies Postbox instructions', async () => {
  const seen = [];
  const calls = { text: '', saved: {}, checkpoints: [] };
  const adapter = new CodexAdapter({
    workRoot: '/tmp/postbox-codex-test',
    spawnImpl: (_bin, args) => {
      assert.deepEqual(args.slice(0, 3), ['app-server', '--listen', 'stdio://']);
      return fakeAppServer(seen);
    },
  });
  const ctx = {
    persona: { handle: 'critic', model: 'gpt-5.6-terra', effort: 'medium', permissionMode: 'acceptEdits' },
    project: { folder: '/tmp/postbox-codex-test/project' },
    handles: ['critic'],
    state: {},
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=s1',
    text: (text) => {
      calls.text += text;
    },
    activity: () => {},
    status: () => {},
    saveState: (s) => Object.assign(calls.saved, s),
    checkpoint: (x) => calls.checkpoints.push(x),
    pathOf: () => null,
  };
  await adapter.deliver({}, { kind: 'user', text: 'Say hello.' }, ctx);
  assert.equal(calls.text, 'reply');
  assert.equal(calls.saved.codexThreadId, 'thr_fake');
  assert.deepEqual(calls.checkpoints, [{ turnId: 'turn_fake', threadId: 'thr_fake' }]);
  const turn = seen.find((x) => x.method === 'turn/start');
  assert.equal(turn.params.input[0].text, 'Say hello.');
  assert.match(turn.params.settings.developer_instructions, /Postbox/);
  assert.equal(turn.params.sandboxPolicy.type, 'workspaceWrite');
});

test('a topic thread forks Codex history at the saved completed-turn checkpoint', async () => {
  const seen = [];
  const adapter = new CodexAdapter({
    workRoot: '/tmp/postbox-codex-test',
    spawnImpl: () => fakeAppServer(seen),
  });
  const ctx = {
    persona: { handle: 'critic', model: 'gpt-5.6-terra', effort: 'medium' },
    project: { folder: '/tmp/postbox-codex-test/project' },
    handles: ['critic'],
    state: { codexThreadId: 'thr_source', fork: { threadId: 'thr_source', turnId: 'turn_source' } },
    signal: new AbortController().signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=s2',
    text: () => {},
    activity: () => {},
    status: () => {},
    saveState: () => {},
    checkpoint: () => {},
    pathOf: () => null,
  };
  await adapter.deliver({}, { kind: 'user', text: 'Continue the branch.' }, ctx);
  const fork = seen.find((request) => request.method === 'thread/fork');
  assert.deepEqual(fork.params, { threadId: 'thr_source', lastTurnId: 'turn_source', excludeTurns: true });
});

test('a stopped Codex turn ends only once its app-server has exited, so the next turn can’t run beside it (#126)', async () => {
  const seen = [];
  const child = fakeAppServer(seen, { hold: true });
  const signals = [];
  // A process that takes a moment to exit after SIGINT, as a real app-server does.
  child.kill = (sig) => {
    signals.push(sig);
    setTimeout(() => child.emit('close', 0), 30);
    return true;
  };
  const adapter = new CodexAdapter({ workRoot: '/tmp/postbox-codex-test', spawnImpl: () => child });
  const abort = new AbortController();
  const ctx = {
    persona: { handle: 'critic', model: 'gpt-5.6-terra' },
    project: { folder: '/tmp/postbox-codex-test/project' },
    handles: ['critic'],
    state: {},
    signal: abort.signal,
    mcpUrl: 'http://127.0.0.1:1/mcp?session=s3&turn=t1',
    text: () => {},
    activity: () => {},
    status: () => {},
    saveState: () => {},
    checkpoint: () => {},
    pathOf: () => null,
  };
  let ended = false;
  const turn = adapter.deliver({}, { kind: 'user', text: 'Work for a while.' }, ctx).then(() => {
    ended = true;
  });
  while (!seen.some((x) => x.method === 'turn/start')) await new Promise((r) => setImmediate(r));
  abort.abort();
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(
    seen.some((x) => x.method === 'turn/interrupt'),
    'Stop interrupts the Codex turn',
  );
  assert.equal(ended, false, 'the turn hasn’t ended while the app-server is still running');
  await turn;
  assert.equal(ended, true);
  assert.deepEqual(signals, ['SIGINT'], 'the app-server gets SIGINT, and SIGKILL only if it outlives the grace period');
});

test('a failed Codex turn says why, from the error Codex reported, whether the turn ends as failed or the app-server exits (#61)', async () => {
  for (const then of ['complete', 'exit']) {
    const adapter = new CodexAdapter({
      workRoot: '/tmp/postbox-codex-test',
      spawnImpl: () => fakeAppServer([], { error: 'The model gpt-nope does not exist.', then }),
    });
    const ctx = {
      persona: { handle: 'critic', model: 'gpt-nope' },
      project: { folder: '/tmp/postbox-codex-test/project' },
      handles: ['critic'],
      state: {},
      signal: new AbortController().signal,
      mcpUrl: 'http://127.0.0.1:1/mcp?session=s4&turn=t1',
      text: () => {},
      activity: () => {},
      status: () => {},
      saveState: () => {},
      checkpoint: () => {},
      pathOf: () => null,
    };
    await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Hi' }, ctx), /The model gpt-nope does not exist\./, then);
  }
});
