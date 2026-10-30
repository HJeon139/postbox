// The turn’s envelope (designs/508, “Delivering a turn”, the envelope; the “Now” step of the rollout).
// #515: Claude Code records the system prompt on a conversation’s first request and keeps it on --resume (CLI reference,
// “System prompt flags in resumed conversations”, quoted in #515), so the system prompt holds only what is fixed for a
// persona version, and what changes during a room (the room list, the brief, the session facts, the tools turned off)
// goes in each turn’s message, after the request (CX-3). DL-4: the turn opens with the request; the rest is background.
// The Claude Code stream the fake CLI plays is block.jsonl, recorded from a real turn (claude 2.1.296; see
// tests/claude-code.test.mjs).

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { agentGuide, formatMessage, turnFacts } from '../server/adapters/guide.mjs';

const block = readFileSync(new URL('fixtures/claude-code/block.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));

const ALL_ON = ['shell', 'web.fetch', 'agents.outside'];
const base = {
  persona: { handle: 'coder', backend: 'claude-code', model: 'claude-opus-5-5', tools: ALL_ON, description: 'Writes code', instructions: 'Be brief.' },
  handles: ['coder', 'critic'],
  room: [{ handle: 'critic', role: 'Reviews' }],
  project: { name: 'Paint' },
  brief: 'You were asked in by the person.',
  session: { personaSnapshot: { model: 'claude-opus-5-5', effort: 'high' } },
};

test('#515: the system prompt is the same when only the room list, the brief, the session facts or the tools turned off change', () => {
  const first = agentGuide(base);
  const changes = {
    'the room list': { room: [...base.room, { handle: 'tester', role: 'Tests' }], handles: [...base.handles, 'tester', 'indexer'] },
    'the brief': { brief: 'You were brought in by @critic.' },
    'the session facts': { session: { lastModel: 'claude-sonnet-5', lastEffort: 'low', personaSnapshot: { model: 'claude-sonnet-5', effort: 'low' } } },
    'the tools turned off': { persona: { ...base.persona, tools: ['web.fetch'] } },
    'the project’s name': { project: { name: 'Paint, renamed' } },
  };
  for (const [what, change] of Object.entries(changes)) assert.equal(agentGuide({ ...base, ...change }), first, `${what} changed the system prompt`);
  // It still says who the agent is, with its role and instructions.
  assert.match(first, /You are @coder/);
  assert.match(first, /Your role: Writes code/);
  assert.match(first, /Be brief\./);
});

test('#515: the turn’s message carries the room list, the brief, the session facts and the tools turned off', () => {
  const facts = turnFacts({ ...base, persona: { ...base.persona, tools: ['web.fetch'] } });
  const prompt = formatMessage({ kind: 'user', text: 'Fix the ring.', facts });
  assert.match(prompt, /- @critic: Reviews/, 'the room list');
  assert.match(prompt, /How you joined: You were asked in by the person\./, 'the brief');
  assert.match(prompt, /## Your session/, 'the session facts');
  assert.match(prompt, /## Turned off for you[\s\S]*running commands \(shell\)/, 'the tools turned off');
  assert.match(prompt, /the project “Paint”/, 'the project');
});

test('DL-4: a turn opens with the request; what waited and the catch-up follow it, labeled background', () => {
  const catchUp = '[Postbox] What happened in this room since your last turn:\n\nYou: Which edition?';
  const prompt = formatMessage({ kind: 'user', text: '@coder fix the ring', facts: turnFacts(base), context: [catchUp] });
  assert.ok(prompt.startsWith('@coder fix the ring'), `the prompt starts with: ${prompt.slice(0, 80)}`);
  const facts = prompt.indexOf('## In this conversation');
  const label = prompt.search(/\[Postbox\] Background/);
  assert.ok(facts > 0 && label > facts, 'the room’s facts come after the request, and the background after them');
  assert.ok(prompt.indexOf(catchUp) > label, 'the catch-up is under the background label');
  // A turn with nothing waiting is the request and the facts, with no background label.
  assert.doesNotMatch(formatMessage({ kind: 'user', text: 'Hi', facts: turnFacts(base) }), /Background/);
});

test('#504 #515: a topic thread’s turn is its thread, its task, the request, then the room’s facts, then the room as background', () => {
  const thread = '[Postbox] You’re answering in the thread “Note” (thread th_1).';
  const meanwhile = '[Postbox] Meanwhile in the room and other background context (answer room work in the room):\n\nYou: Ship it.';
  const prompt = formatMessage({ kind: 'user', text: '@coder check the grammar', taskContext: thread, facts: turnFacts(base), context: [meanwhile] });
  const parts = [
    thread,
    'Your task in this topic or side thread is the request below.',
    '@coder check the grammar',
    '[Postbox] What’s current in this room:',
    meanwhile,
  ];
  const at = parts.map((s) => prompt.indexOf(s));
  assert.ok(at[0] === 0 && at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1])), `the order was: ${at.join(', ')}`);
});

test('a command’s turn is the command alone: Claude Code runs it only when the prompt is just /name', () => {
  assert.equal(formatMessage({ kind: 'user', text: '/review the ring', slash: true, facts: turnFacts(base) }), '/review the ring');
});

/** A fake Claude Code CLI that plays the recorded turn and keeps what each run was given: its arguments and stdin. */
function fakeClaude() {
  /** @type {{ args: string[], stdin: string }[]} */
  const runs = [];
  const spawnImpl = (_bin, args) => {
    const child = new EventEmitter();
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => {} });
    const run = { args, stdin: '' };
    child.stdin.on('data', (d) => {
      run.stdin += d;
    });
    runs.push(run);
    setImmediate(() => {
      for (const l of block) child.stdout.write(`${JSON.stringify(l)}\n`);
      child.stdout.end();
      setTimeout(() => child.emit('close', 0), 10);
    });
    return child;
  };
  return { spawnImpl, runs };
}

/** A turn context like the runtime’s, for the persona as it is at this turn. */
const turnCtx = (persona, state) => ({
  persona,
  project: null,
  handles: ['coder', 'critic'],
  room: [{ handle: 'critic', role: 'Reviews' }],
  state,
  mcpUrl: 'http://127.0.0.1:4280/mcp?session=se_1',
  signal: new AbortController().signal,
  saveState: (p) => Object.assign(state, p),
  pathOf: () => null,
  text: () => {},
  activity: () => {},
  status: () => {},
  compaction: () => {},
  denied: () => {},
});

test('CX-3: a tool turned off mid-session shows as off in a resumed Claude Code session’s next turn', async () => {
  const { spawnImpl, runs } = fakeClaude();
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', spawnImpl });
  const persona = { handle: 'coder', model: 'claude-opus-5-5', permissionMode: 'ask', folder: '/tmp/pb-test-coder', tools: ALL_ON };
  const state = {};
  await adapter.deliver({}, { kind: 'user', text: 'Run the tests.' }, turnCtx(persona, state));
  // The person turns shell off; the next turn resumes the same Claude Code session.
  await adapter.deliver({}, { kind: 'user', text: 'Run them again.' }, turnCtx({ ...persona, tools: ['web.fetch', 'agents.outside'] }, state));
  const [first, next] = runs;
  assert.ok(next.args.includes('--resume'), 'the second turn resumes the session');
  const system = (r) => r.args[r.args.indexOf('--append-system-prompt') + 1];
  // Claude Code would keep the first turn’s system prompt anyway; Postbox passes the same one, so nothing is lost.
  assert.equal(system(next), system(first));
  assert.doesNotMatch(system(next), /Turned off for you/);
  assert.doesNotMatch(first.stdin, /Turned off for you/);
  assert.ok(next.stdin.startsWith('Run them again.'), 'the request leads the turn');
  assert.match(next.stdin, /## Turned off for you[\s\S]*running commands \(shell\)/);
});
