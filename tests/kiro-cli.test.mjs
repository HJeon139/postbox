import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import {
  createKiroMapper,
  exitError,
  KIRO_CAPABILITIES,
  KIRO_PUBLISHING,
  KiroCliAdapter,
  kiroAgent,
  kiroArgs,
  kiroHomeFor,
  kiroModel,
  kiroRules,
  modelIds,
  postboxModel,
} from '../server/adapters/kiro-cli.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';

// Streams recorded from real Kiro CLI turns (kiro-cli 2.33.1, engine v3, claude-opus-5.5), with local paths,
// steering file names and the slash command list removed.
const fixture = (name) =>
  readFileSync(new URL(`fixtures/kiro-cli/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

function fakeCtx(over = {}) {
  const calls = { text: '', activity: [], status: [], reported: [], saved: {} };
  const abort = new AbortController();
  return {
    calls,
    abort,
    signal: abort.signal,
    mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
    persona: { handle: 'kiro', model: 'claude-opus-5-5', permissionMode: 'ask', usesHostSetup: false, tools: [], description: '', instructions: '' },
    project: null,
    handles: ['kiro', 'critic'],
    state: {},
    saveState: (p) => Object.assign(calls.saved, p),
    pathOf: () => null,
    text: (d) => {
      calls.text += d;
    },
    activity: (a) => calls.activity.push(a),
    status: (s) => calls.status.push(s),
    reported: (r) => calls.reported.push(r),
    ...over,
  };
}

const replay = (name, opts) => {
  const ctx = fakeCtx();
  const m = createKiroMapper(ctx, { now: () => 1000, effort: 'medium', ...opts });
  for (const e of fixture(name)) m.push(e);
  return { ctx, m };
};

test('a recorded turn that shows a block: the reply, no step for Postbox’s tools, the session and the model', () => {
  const { ctx, m } = replay('block');
  assert.equal(ctx.calls.text, 'I showed the “Tea or coffee?” choice, but I couldn’t run `echo hi` because this session doesn’t give me a shell tool.');
  // Tool Load and show_block are quiet; the thinking before them is one thought.
  assert.deepEqual(
    ctx.calls.activity.map((a) => a.kind ?? a.state),
    ['thought'],
  );
  assert.match(ctx.calls.activity[0].label, /^I don't actually have a shell/);
  assert.ok(ctx.calls.status.some((s) => s.currentStep === 'Showing a block'));
  assert.ok(ctx.calls.status.some((s) => typeof s.ctx === 'number'));
  assert.equal(m.sessionId, 'sess_efc1b88d-0782-4eaf-8342-d3630a55d4ff');
  assert.equal(m.error, null);
  assert.ok(m.finished);
  // Kiro spells the model claude-opus-5.5; Postbox reports it in its own spelling, with the effort it passed.
  assert.deepEqual(ctx.calls.reported, [{ model: 'claude-opus-5-5', effort: 'medium' }]);
});

test('a recorded resumed turn: a glossary term stays quiet, and a command Kiro refused is a denied step', () => {
  const { ctx, m } = replay('resume-refused');
  const steps = ctx.calls.activity.filter((a) => !a.kind);
  assert.deepEqual(
    steps.map((a) => [a.label, a.state]),
    [
      ['Print a test greeting', 'running'],
      ['Print a test greeting', 'denied'],
    ],
  );
  // Kiro words it as your answer; nobody was asked, and the step says so.
  assert.equal(steps[1].detail, 'Kiro asks before this (“echo hi”), and can’t ask you from Postbox, so it was refused.');
  assert.match(ctx.calls.text, /heron/);
  // Text after a tool call starts a new paragraph.
  assert.match(ctx.calls.text, /\n\n/);
  assert.equal(m.error, null);
});

test('a recorded turn: a Postbox tool that failed stays quiet, and Kiro’s refusal of a read is a denied step', () => {
  const { ctx } = replay('mcp-failed');
  const conv = ctx.calls.activity.filter((a) => a.id === 'toolu_bdrk_01BoDgjtvwRuGX3QR5yCpZcS');
  // read_conversation is quiet even when it fails: it only reads Postbox.
  assert.deepEqual(conv, []);
  const list = ctx.calls.activity.filter((a) => a.label === 'List Directory');
  assert.equal(list.at(-1).state, 'denied');
});

test('a recorded write Kiro would have asked about: a denied step, though the turn itself succeeds', () => {
  const { ctx, m } = replay('host-write-refused');
  const write = ctx.calls.activity.filter((a) => a.label === 'Write File');
  assert.deepEqual(
    write.map((a) => a.state),
    ['running', 'denied'],
  );
  assert.match(write[1].detail, /“Write File”/);
  assert.equal(m.error, null, 'runFinished says success; only the stream shows the refusal');
});

test('a refusal is read from the approval events, not only from Kiro’s wording', () => {
  const ctx = fakeCtx();
  const m = createKiroMapper(ctx, { now: () => 1000 });
  for (const e of fixture('host-write-refused')) {
    const u = e.data?.update;
    if (u?.sessionUpdate === 'tool_call_update' && u.status === 'failed') u.rawOutput = { message: 'Something else.' };
    m.push(e);
  }
  assert.equal(ctx.calls.activity.find((a) => a.label === 'Write File' && a.state !== 'running')?.state, 'denied');
});

test('a recorded Isolated turn: another server’s call is refused by the deny rule, not worded as an ask; Postbox’s goes through', () => {
  const { ctx, m } = replay('isolated-deny');
  const other = ctx.calls.activity.filter((a) => a.label === 'read conversation (other)');
  assert.deepEqual(
    other.map((a) => a.state),
    ['running', 'denied'],
  );
  assert.equal(other[1].detail, 'Its permissions in Postbox don’t allow this.');
  // Postbox’s own call reached Postbox (which didn’t know the test’s session), and stays quiet.
  assert.ok(!ctx.calls.activity.some((a) => /postbox/i.test(a.label)));
  assert.match(ctx.calls.text, /Unknown Postbox session/);
  assert.deepEqual(m.steering, []);
  assert.equal(m.error, null);
});

test('steering: a turn with your setup loads your steering files; the Isolated turns recorded load none', () => {
  // Recorded with the person’s own ~/.kiro (names replaced): Kiro lists what it loaded.
  assert.ok(replay('host-write-refused').m.steering.length > 0);
  // Recorded through Postbox with an Isolated persona, whose Kiro home is Postbox’s own.
  for (const name of ['block', 'first', 'resume-refused']) assert.deepEqual(replay(name).m.steering, [], name);
});

test('a session Kiro no longer has: the mapper says so, and the turn can start over', () => {
  const { m } = replay('missing-session');
  assert.equal(m.missingSession, true);
  assert.match(m.error, /not found/);
});

test('an agent Kiro can’t find is an error, not a silent fallback to its default agent', () => {
  const { m } = replay('agent-missing');
  assert.match(m.error, /agent "nosuch" not found/);
});

test('model ids: Postbox’s dashes become Kiro’s dot, and back; anything else passes', () => {
  assert.equal(kiroModel('claude-opus-5-5'), 'claude-opus-5.5');
  assert.equal(kiroModel('claude-fable-5-1'), 'claude-fable-5.1');
  assert.equal(kiroModel('claude-opus-5'), 'claude-opus-5');
  assert.equal(kiroModel('gpt-5.6-terra'), 'gpt-5.6-terra');
  assert.equal(postboxModel('claude-sonnet-5.5'), 'claude-sonnet-5-5');
  assert.equal(postboxModel('auto'), null);
  assert.equal(postboxModel('gpt-5.6-terra'), 'gpt-5.6-terra');
});

test('the models Kiro lists, in Postbox’s spelling, bounded; nothing from an answer that isn’t a list', () => {
  const json = JSON.stringify({
    models: [
      { model_id: 'auto' },
      { model_id: 'claude-opus-5.5' },
      { model_id: 'gpt-5.6-terra' },
      { model_id: 'claude-opus-5.5' },
      { model_id: 'bad id;' },
      { model: 'x' },
    ],
  });
  assert.deepEqual(modelIds(json), ['auto', 'claude-opus-5-5', 'gpt-5.6-terra']);
  assert.deepEqual(modelIds('not json'), []);
  assert.deepEqual(modelIds('{"models":{}}'), []);
  const a = new KiroCliAdapter({ workRoot: '/nowhere', isolatedHome: '/nowhere/kiro', models: ['gpt-5.6-terra'] });
  assert.deepEqual(a.capabilities.models, ['gpt-5.6-terra']);
  assert.equal(a.capabilities.fork, false);
  assert.equal(
    new KiroCliAdapter({ workRoot: '/nowhere', isolatedHome: '/nowhere/kiro' }).capabilities.models,
    undefined,
    'Claude’s list, when Kiro listed none',
  );
});

test('Kiro says how it runs on a remote host: no stdin, only KIRO_HOME, its agent file, an open tool call as work', () => {
  assert.deepEqual(KIRO_CAPABILITIES.remote, {
    stdin: 'none',
    env: ['KIRO_HOME'],
    server: 'agent-file',
    work: 'open-tool-call',
    signInError: null,
  });
  const a = new KiroCliAdapter({ workRoot: '/nowhere', isolatedHome: '/nowhere/kiro', models: ['gpt-5.6-terra'] });
  assert.equal(a.capabilities.remote, KIRO_CAPABILITIES.remote, 'the models don’t replace it');
  assert.deepEqual(JSON.parse(JSON.stringify(a.capabilities)).remote, KIRO_CAPABILITIES.remote);
});

test('the arguments: v3, stream-json, the turn’s agent, model and effort always, the message after --', () => {
  const persona = { handle: 'kiro', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'ask' };
  const args = kiroArgs({ persona, agent: 'postbox-kiro-1', prompt: '-not a flag' });
  assert.deepEqual(args, [
    'chat',
    '--agent-engine',
    'v3',
    '--output-format',
    'stream-json',
    '--agent',
    'postbox-kiro-1',
    '--model',
    'claude-opus-5.5',
    '--effort',
    'high',
    '--',
    '-not a flag',
  ]);
  const resumed = kiroArgs({ persona: { ...persona, permissionMode: 'bypass', usesHostSetup: false }, agent: 'a', sessionId: 'sess_1', prompt: 'hi' });
  assert.deepEqual(resumed.slice(11, -2), ['--resume-id', 'sess_1', '--trust-all-tools', '--require-mcp-startup']);
});

test('the rules: Postbox’s tools allowed, reads in its folders, edits only with acceptEdits, unticked tools denied', () => {
  const folders = ['/nowhere/agent', '/nowhere/project'];
  const ask = kiroRules({ persona: { permissionMode: 'ask', tools: [] }, folders });
  assert.deepEqual(ask[0], { capability: 'mcp', match: ['postbox/*'], effect: 'allow' });
  assert.deepEqual(ask[1], { capability: 'fs_read', match: folders, effect: 'allow' });
  assert.ok(!ask.some((r) => r.capability === 'fs_write'));
  for (const c of ['shell', 'web_fetch', 'web_search'])
    assert.ok(
      ask.some((r) => r.capability === c && r.effect === 'deny'),
      c,
    );
  assert.ok(ask.some((r) => r.capability === 'mcp' && r.effect === 'deny' && r.match === KIRO_PUBLISHING));

  const edits = kiroRules({ persona: { permissionMode: 'acceptEdits', tools: ['shell', 'web.fetch'], canPublish: true }, folders });
  assert.deepEqual(
    edits.find((r) => r.capability === 'fs_write'),
    { capability: 'fs_write', match: folders, effect: 'allow' },
  );
  assert.ok(!edits.some((r) => r.effect === 'deny'), 'ticked tools and publishing aren’t denied');

  // Servers turned off are denied with your setup. Isolated denies every server but Postbox’s, which covers them,
  // and a server a managed install adds to the agent file by itself.
  const host = kiroRules({ persona: { tools: ['shell', 'web.fetch'], canPublish: true, mcpOff: ['slack', 'postbox'] }, folders });
  assert.deepEqual(host.at(-1), { capability: 'mcp', match: ['slack/*'], effect: 'deny' });
  const isolated = kiroRules({ persona: { tools: ['shell', 'web.fetch'], canPublish: true, usesHostSetup: false, mcpOff: ['slack'] }, folders });
  assert.deepEqual(
    isolated.filter((r) => r.effect === 'deny'),
    [{ capability: 'mcp', match: ['*/*'], exclude: ['postbox/*'], effect: 'deny' }],
  );
});

test('no publishing rule matches Postbox’s own tools, and they do catch an outward verb', () => {
  const re = KIRO_PUBLISHING.map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
  for (const t of TOOL_DEFS) assert.ok(!re.some((r) => r.test(`postbox/${t.name}`)), t.name);
  for (const t of ['slack/send_message', 'gmail/send', 'github/comment_on_issue', 'x/slack_send_dm'])
    assert.ok(
      re.some((r) => r.test(t)),
      t,
    );
  for (const t of ['memory/create_entities', 'slack/read_channel', 'drive/search_files']) assert.ok(!re.some((r) => r.test(t)), t);
});

test('the agent: the guide and a note on refusals as its prompt, Postbox’s server, your mcp.json only with your setup', () => {
  const persona = { handle: 'kiro', permissionMode: 'ask', tools: [] };
  const a = kiroAgent({ name: 'postbox-kiro-1', persona, mcpUrl: 'http://127.0.0.1:1/mcp?session=se_1', guide: 'GUIDE', folders: ['/nowhere'] });
  assert.equal(a.name, 'postbox-kiro-1');
  assert.match(a.prompt, /^GUIDE\n\n## Refused tool calls/);
  assert.deepEqual(a.mcpServers, { postbox: { type: 'http', url: 'http://127.0.0.1:1/mcp?session=se_1' } });
  assert.equal(a.includeMcpJson, true);
  assert.doesNotMatch(a.prompt, /## Tools you can use/);
  const isolated = kiroAgent({ name: 'x', persona: { ...persona, usesHostSetup: false }, mcpUrl: '', guide: '', folders: [] });
  assert.equal(isolated.includeMcpJson, false);
  // Kiro lists a denied server’s tools anyway, so an Isolated agent is told not to offer them.
  assert.match(isolated.prompt, /## Tools you can use\n\nOnly Postbox’s MCP server is allowed/);
});

test('the Kiro home: yours (KIRO_HOME, else ~/.kiro), or Postbox’s own when Isolated', () => {
  assert.equal(kiroHomeFor({}, { isolatedHome: '/pb', env: {}, home: '/home/you' }), '/home/you/.kiro');
  assert.equal(kiroHomeFor({}, { isolatedHome: '/pb', env: { KIRO_HOME: '/k' }, home: '/home/you' }), '/k');
  assert.equal(kiroHomeFor({ usesHostSetup: false }, { isolatedHome: '/pb', env: { KIRO_HOME: '/k' } }), '/pb');
});

test('exit codes the stream didn’t explain', () => {
  assert.match(exitError(3), /MCP server didn’t start/);
  assert.match(exitError(1, '[INFO] noise\nerror: ACP load_session failed\n'), /code 1: error: ACP load_session failed/);
});

/** A fake kiro-cli: it records its arguments and environment, and plays a recorded stream, once per spawn. */
function fakeSpawn(streams, seen) {
  return (_bin, args, opts) => {
    const agent = args[args.indexOf('--agent') + 1];
    const home = opts.env.KIRO_HOME;
    seen.push({ args, cwd: opts.cwd, env: opts.env, agentFile: home && JSON.parse(readFileSync(join(home, 'agents', `${agent}.json`), 'utf8')) });
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => {} });
    const { lines, code } = streams.shift();
    setImmediate(() => {
      for (const e of lines) child.stdout.write(`${JSON.stringify(e)}\n`);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
}

test('an Isolated turn: its own Kiro home, the agent file written for the turn and removed after, the session saved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-kiro-'));
  const seen = [];
  const adapter = new KiroCliAdapter({
    workRoot: join(root, 'work'),
    isolatedHome: join(root, 'home'),
    spawnImpl: /** @type {any} */ (fakeSpawn([{ lines: fixture('first'), code: 0 }], seen)),
    env: {},
  });
  const ctx = fakeCtx();
  await adapter.deliver({}, { kind: 'user', text: 'Remember heron.' }, ctx);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].env.KIRO_HOME, join(root, 'home'));
  assert.equal(seen[0].cwd, join(root, 'work', 'kiro'));
  assert.equal(seen[0].agentFile.mcpServers.postbox.url, ctx.mcpUrl);
  assert.equal(seen[0].args.at(-1), 'Remember heron.');
  assert.deepEqual(readdirSync(join(root, 'home', 'agents')), [], 'the turn’s agent file is gone');
  assert.match(ctx.calls.saved.kiroSessionId, /^sess_/);
  assert.equal(ctx.calls.text, 'OK');
});

test('a session Kiro no longer has starts over once, without --resume-id, and says so', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-kiro-'));
  const seen = [];
  const adapter = new KiroCliAdapter({
    workRoot: join(root, 'work'),
    isolatedHome: join(root, 'home'),
    spawnImpl: /** @type {any} */ (
      fakeSpawn(
        [
          { lines: fixture('missing-session'), code: 1 },
          { lines: fixture('first'), code: 0 },
        ],
        seen,
      )
    ),
    env: {},
  });
  const ctx = fakeCtx({ state: { kiroSessionId: 'sess_gone' } });
  await adapter.deliver({}, { kind: 'user', text: 'hi' }, ctx);
  assert.equal(seen.length, 2);
  assert.ok(seen[0].args.includes('--resume-id'));
  assert.ok(!seen[1].args.includes('--resume-id'));
  assert.match(seen[1].args.at(-1), /fresh start/);
  assert.match(ctx.calls.saved.kiroSessionId, /^sess_/);
  assert.notEqual(ctx.calls.saved.kiroSessionId, 'sess_gone');
});

test('a failed turn rejects with what Kiro said', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pb-kiro-'));
  const adapter = new KiroCliAdapter({
    workRoot: join(root, 'work'),
    isolatedHome: join(root, 'home'),
    spawnImpl: /** @type {any} */ (fakeSpawn([{ lines: fixture('agent-missing'), code: 4 }], [])),
    env: {},
  });
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'hi' }, fakeCtx()), /agent "nosuch" not found/);
  assert.ok(existsSync(join(root, 'home', 'agents')));
  assert.deepEqual(readdirSync(join(root, 'home', 'agents')), []);
});
