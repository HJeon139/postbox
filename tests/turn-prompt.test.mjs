// What a turn sent its agent (server/turn-prompt.mjs, shared/turn-prompts.mjs): the guide Postbox appends, once per
// distinct text, and each prompt as it leaves for the backend, whole. The Claude Code run plays a stream recorded on
// claude 2.1.296 (tests/fixtures/claude-code/block.jsonl) through a fake spawn that settles on setImmediate, no timer.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { Store } from '../server/store.mjs';
import { recordTurnPrompt } from '../server/turn-prompt.mjs';
import { tempDir } from './temp-dirs.mjs';

const T0 = 1_800_000_000_000;
const BLOCK = readFileSync(new URL('fixtures/claude-code/block.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n');

test('a guide is recorded once per text, and each prompt names it, with its turn and its exact text', () => {
  const store = new Store(null);
  const rt = { store };
  const turn = { id: 'turn_1', sessionId: 'se_1', threadId: 'th_1' };
  recordTurnPrompt(rt, turn, { guide: 'You are @coder.', text: 'First.' }, () => T0);
  recordTurnPrompt(rt, { ...turn, id: 'turn_2' }, { guide: 'You are @coder.', text: 'Second.' }, () => T0 + 1);
  const events = store.since(0).filter((e) => e.type.startsWith('turn.'));
  const sha = createHash('sha256').update('You are @coder.').digest('hex');
  assert.deepEqual(
    events.map((e) => [e.type, e.data.sha ?? e.data.guideSha, e.data.text]),
    [
      ['turn.guide', sha, 'You are @coder.'],
      ['turn.prompt', sha, 'First.'],
      ['turn.prompt', sha, 'Second.'],
    ],
  );
  assert.deepEqual(events[1].data, { sessionId: 'se_1', turnId: 'turn_1', threadId: 'th_1', guideSha: sha, text: 'First.', at: T0 });
});

test('a guide given alone is kept for the turn’s later prompts, as an adapter that writes it once passes it', () => {
  const store = new Store(null);
  const turn = { id: 'turn_1', sessionId: 'se_1', threadId: 'th_1' };
  recordTurnPrompt({ store }, turn, { guide: 'Rules file.' });
  recordTurnPrompt({ store }, turn, { text: 'Run one.' });
  recordTurnPrompt({ store }, turn, { text: 'Its follow-up.' });
  const prompts = store.since(0).filter((e) => e.type === 'turn.prompt');
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((e) => e.data.guideSha === createHash('sha256').update('Rules file.').digest('hex')));
});

/** A spawn that answers with the recorded stream once its prompt is in, and keeps what it was given. */
function recordedSpawn() {
  const runs = [];
  const spawnImpl = (/** @type {string} */ _bin, /** @type {string[]} */ args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 1 });
    child.kill = () => {};
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

test('Claude Code’s run records exactly the guide it appends and the prompt it writes to the CLI', async () => {
  const { spawnImpl, runs } = recordedSpawn();
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: tempDir('pb-prompt-work-'), spawnImpl });
  const recorded = [];
  const abort = new AbortController();
  const ctx = {
    signal: abort.signal,
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
    prompt: (p) => recorded.push(p),
  };
  await adapter.deliver({}, { kind: 'user', text: 'Tea or coffee?' }, ctx);
  assert.equal(runs.length, 1);
  assert.equal(recorded.length, 1);
  const args = runs[0].args;
  assert.equal(recorded[0].guide, args[args.indexOf('--append-system-prompt') + 1]);
  assert.equal(recorded[0].text, runs[0].stdin);
  assert.match(recorded[0].text, /^Tea or coffee\?/);
});
