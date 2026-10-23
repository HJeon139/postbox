import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CODEX_CAPABILITIES, CodexAdapter, codexApproval, codexConfigArgs, codexPermissions, createCodexMapper } from '../server/adapters/codex.mjs';

test('Codex reports the capabilities its app-server implements', () => {
  assert.deepEqual(CODEX_CAPABILITIES, { resume: true, fork: true, permissions: 'none', tools: 'none' });
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

test('Codex approval requests become explicit Postbox permission cards without unsupported Always allow rules', async () => {
  let requested;
  const allowed = await codexApproval(
    {
      askPermission: async (req) => {
        requested = req;
        return { allow: true };
      },
    },
    { method: 'item/commandExecution/requestApproval', params: { itemId: 'cmd_1', command: 'touch ../outside.txt' } },
  );
  assert.deepEqual(allowed, { decision: 'accept' });
  assert.deepEqual(requested, {
    tool: 'Bash',
    summary: 'Codex wants to run a command',
    detail: 'touch ../outside.txt',
    toolUseId: 'cmd_1',
    suppressAlways: true,
  });
  const denied = await codexApproval(
    { askPermission: async () => ({ allow: false }) },
    { method: 'item/fileChange/requestApproval', params: { itemId: 'file_1', grantRoot: '/workspace' } },
  );
  assert.deepEqual(denied, { decision: 'decline' });
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

function fakeAppServer(seen) {
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
