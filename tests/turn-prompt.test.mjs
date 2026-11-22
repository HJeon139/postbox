// What a turn sent its agent, recorded only in UAT recording mode (server/turn-prompt.mjs, #1528): the guide Postbox
// gives, once per session and text, and each prompt once its backend has it, whole, in prompts.jsonl in the data
// folder. The Claude Code runs play a stream recorded on claude 2.1.296 (tests/fixtures/claude-code/block.jsonl)
// through fakes that settle on setImmediate, so no test waits on a timer.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { PROMPTS_FILE, promptHook, promptsFileFor } from '../server/turn-prompt.mjs';
import { MESSAGE_FILE } from '../shared/remote-protocol.mjs';
import { remoteCtx, starts } from './claude-code-remote-fixture.mjs';
import { createFakeDaemon, fixtureLines } from './fake-daemon.mjs';
import { brokenStdin } from './prompt-fakes.mjs';
import { tempDir } from './temp-dirs.mjs';

const T0 = 1_800_000_000_000;
const BLOCK = fixtureLines('block');
const sha = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex');
/** A runtime in recording mode, writing to a temp data folder’s prompts.jsonl, and its rows as read back. */
function recording() {
  const file = join(tempDir('pb-prompts-'), PROMPTS_FILE);
  const rt = { config: { promptsFile: file } };
  const rows = () =>
    existsSync(file)
      ? readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : [];
  return { rt, file, rows };
}

test('recording mode is on only with POSTBOX_UAT_RECORD=1, in the data folder’s prompts.jsonl', () => {
  assert.equal(promptsFileFor('/data', { POSTBOX_UAT_RECORD: '1' }), join('/data', 'prompts.jsonl'));
  for (const v of [undefined, '', '0', 'true', 'yes']) assert.equal(promptsFileFor('/data', { POSTBOX_UAT_RECORD: v }), null, String(v));
});

test('with recording mode off a turn has no ctx.prompt, so no adapter records anything', () => {
  assert.deepEqual(promptHook({ config: { promptsFile: null } }, { id: 'turn_1', sessionId: 'se_1' }), {});
  assert.deepEqual(promptHook({ config: {} }, { id: 'turn_1', sessionId: 'se_1' }), {});
});

test('a guide is recorded once per session and text, and each prompt names it, with its turn and its exact text', () => {
  const { rt, rows } = recording();
  const turn = { id: 'turn_1', sessionId: 'se_1', threadId: 'th_1' };
  promptHook(rt, turn, () => T0).prompt({ guide: 'You are @coder.', text: 'First.' });
  promptHook(rt, { ...turn, id: 'turn_2' }, () => T0 + 1).prompt({ guide: 'You are @coder.', text: 'Second.' });
  const g = sha('You are @coder.');
  assert.deepEqual(rows(), [
    { type: 'guide', sessionId: 'se_1', sha: g, text: 'You are @coder.', at: T0 },
    { type: 'prompt', sessionId: 'se_1', turnId: 'turn_1', threadId: 'th_1', guideSha: g, text: 'First.', at: T0 },
    { type: 'prompt', sessionId: 'se_1', turnId: 'turn_2', threadId: 'th_1', guideSha: g, text: 'Second.', at: T0 + 1 },
  ]);
});

test('each session records its guide, though another session’s turn recorded the same text before', () => {
  const { rt, rows } = recording();
  promptHook(rt, { id: 'turn_1', sessionId: 'se_a1', threadId: 'th_a1' }).prompt({ guide: 'You are @coder.', text: 'Run A1.' });
  promptHook(rt, { id: 'turn_2', sessionId: 'se_a2', threadId: 'th_a2' }).prompt({ guide: 'You are @coder.', text: 'Run A2.' });
  promptHook(rt, { id: 'turn_3', sessionId: 'se_a2', threadId: 'th_a2' }).prompt({ guide: 'You are @coder.', text: 'A2 again.' });
  assert.deepEqual(
    rows().map((r) => `${r.type} ${r.sessionId}`),
    ['guide se_a1', 'prompt se_a1', 'guide se_a2', 'prompt se_a2', 'prompt se_a2'],
  );
});

test('a guide given alone is kept for the turn’s later prompts, as an adapter that writes it once passes it', () => {
  const { rt, rows } = recording();
  const { prompt } = promptHook(rt, { id: 'turn_1', sessionId: 'se_1', threadId: 'th_1' });
  prompt({ guide: 'Rules file.' });
  prompt({ text: 'Run one.' });
  prompt({ text: 'Its follow-up.' });
  const prompts = rows().filter((r) => r.type === 'prompt');
  assert.deepEqual(
    prompts.map((r) => r.text),
    ['Run one.', 'Its follow-up.'],
  );
  assert.ok(prompts.every((r) => r.guideSha === sha('Rules file.')));
});

test('a recording that can’t be written says so and leaves the turn to go on', (t) => {
  const logged = [];
  t.mock.method(console, 'error', (/** @type {string} */ m) => logged.push(m));
  const rt = { config: { promptsFile: join(tempDir('pb-prompts-'), 'no-such-folder', PROMPTS_FILE) } };
  assert.doesNotThrow(() => promptHook(rt, { id: 'turn_1', sessionId: 'se_1', threadId: 'th_1' }).prompt({ text: 'Hi.' }));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /couldn’t record a turn’s prompt in .*prompts\.jsonl: ENOENT/);
});

/** The context a local Claude Code turn runs with, recording what it’s given in `recorded`. */
const claudeCtx = (/** @type {any[]} */ recorded) => ({
  signal: new AbortController().signal,
  mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
  persona: { handle: 'coder', model: 'claude-opus-5-5', permissionMode: 'ask', folder: tempDir('pb-prompt-coder-'), description: '', instructions: '' },
  project: null,
  handles: ['coder'],
  state: {},
  saveState: () => {},
  pathOf: () => null,
  text: () => {},
  activity: () => {},
  status: () => {},
  compaction: () => {},
  denied: () => {},
  prompt: (/** @type {any} */ p) => recorded.push(p),
});

/** A spawn that answers with the recorded stream once its prompt is in, and keeps what it was given. */
function recordedSpawn() {
  const runs = [];
  const spawnImpl = (/** @type {string} */ _bin, /** @type {string[]} */ args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 1, kill: () => {} });
    const run = { args, stdin: '' };
    runs.push(run);
    child.stdin.on('data', (d) => {
      run.stdin += d;
    });
    child.stdin.on('finish', () =>
      setImmediate(() => {
        for (const l of BLOCK) child.stdout.write(`${l}\n`);
        child.stdout.end();
        setImmediate(() => child.emit('close', 0));
      }),
    );
    return child;
  };
  return { spawnImpl, runs };
}

test('Claude Code records exactly the guide it appends and the prompt it writes to the CLI', async () => {
  const { spawnImpl, runs } = recordedSpawn();
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-prompt-work-'), spawnImpl });
  const recorded = [];
  await adapter.deliver({}, { kind: 'user', text: 'Tea or coffee?' }, claudeCtx(recorded));
  assert.equal(runs.length, 1);
  assert.equal(recorded.length, 1);
  const args = runs[0].args;
  assert.equal(recorded[0].guide, args[args.indexOf('--append-system-prompt') + 1]);
  assert.equal(recorded[0].text, runs[0].stdin);
  assert.match(recorded[0].text, /^Tea or coffee\?/);
});

test('a Claude Code run that couldn’t start records no prompt, since none reached a backend', async () => {
  const spawnImpl = () => {
    throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  };
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-prompt-work-'), spawnImpl });
  const recorded = [];
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Tea or coffee?' }, claudeCtx(recorded)), /Couldn’t start Claude Code/);
  assert.deepEqual(recorded, []);
});

test('Claude Code records no prompt when its CLI exits before reading its stdin', async () => {
  const spawnImpl = () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: brokenStdin(), pid: 1, kill: () => {} });
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end('');
      setImmediate(() => child.emit('close', 1));
    });
    return child;
  };
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-epipe-work-'), spawnImpl });
  const recorded = [];
  await adapter.deliver({}, { kind: 'user', text: 'Tea or coffee?' }, claudeCtx(recorded)).catch(() => {});
  assert.deepEqual(recorded, []);
});

test('a host turn’s prompt is recorded once its daemon says the turn started, with the message file it was sent', async () => {
  const d = createFakeDaemon({ lines: BLOCK });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work' });
  const ctx = remoteCtx(d);
  const recorded = [];
  /** How many `started` the daemon had sent when each prompt was recorded. */
  const startedThen = [];
  ctx.prompt = (/** @type {any} */ p) => {
    recorded.push(p);
    startedThen.push(d.sent.filter((m) => m.type === 'started').length);
  };
  await adapter.deliver({}, { kind: 'user', text: 'Tea or coffee?' }, ctx);
  const [start] = starts(d);
  assert.deepEqual(startedThen, [1], 'recorded after the daemon had the turn, not when stdin.end called back');
  assert.equal(recorded[0].text, start.files.find((/** @type {any} */ f) => f.name === MESSAGE_FILE).text);
});

test('a host turn its daemon refuses to start records no prompt', async () => {
  // The host’s daemon has no claude to run (its `no-harness` error), though the welcome said it had.
  const d = createFakeDaemon({ lines: BLOCK, harnesses: [] });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work' });
  const ctx = remoteCtx(d);
  const recorded = [];
  ctx.prompt = (/** @type {any} */ p) => recorded.push(p);
  await assert.rejects(adapter.deliver({}, { kind: 'user', text: 'Tea or coffee?' }, ctx));
  assert.deepEqual(recorded, []);
});
