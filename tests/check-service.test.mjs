// Checks’ interface (designs/architecture/services.md, “Checks”): the server’s checks on a finished turn, the lint entry
// each agent turn gets and the lint turn its problems go back in, the stalled-step checks, and the page’s diagram
// reports. Built on an in-memory store, the real Threads and Running, a fake of Sessions, and a `send` port that
// records what it was given; it never builds Runtime.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bus } from '../server/bus.mjs';
import { Checks } from '../server/check-service.mjs';
import { Running } from '../server/running.mjs';
import { Store } from '../server/store.mjs';
import { Threads } from '../server/threads.mjs';

/** A problem the browser reported. */
const PROBLEM = { code: 'x', message: 'A problem.', scope: { kind: 'reply' } };

/**
 * Checks over a store with one agent in a conversation. `config` is the server’s settings: no settle wait unless a
 * test gives one, and its own clock and timers when it does.
 */
function rig(config = { lintSettleMs: 0 }) {
  const store = new Store(null);
  store.emit('project', { id: 'p1', name: 'P', folder: '/work' });
  store.emit('thread', { id: 'th_c', projectId: 'p1', title: 'C', kind: 'thread', parentId: null, members: ['se_1'], queue: [], createdAt: 1 });
  store.emit('session', { id: 'se_1', personaId: 'pe_a', threadId: 'th_c', handle: 'alpha', backend: 'mock' });
  const threads = new Threads({ store, bus: new Bus() });
  const running = new Running();
  /** @type {[string, string][]} */
  const told = [];
  const sessions = {
    update: (/** @type {string} */ id, /** @type {any} */ patch) => store.emit('session', { ...store.state.sessions[id], ...patch }),
    tell: (/** @type {string} */ id, /** @type {string} */ text) => told.push([id, text]),
  };
  /** @type {any[]} */
  const sent = [];
  const send = (/** @type {string} */ sessionId, /** @type {any} */ message, /** @type {any} */ opts) => sent.push({ sessionId, message, opts });
  const checks = new Checks({ store, threads, sessions, running, send, config });
  return { store, threads, running, checks, sent, told, config };
}

/** An agent turn as deliver makes it, with what it said. */
const turnOf = (/** @type {Record<string, any>} */ over = {}) => ({
  id: 'tu_1',
  sessionId: 'se_1',
  threadId: 'th_c',
  kind: 'turn',
  said: '',
  first: null,
  steps: [],
  ...over,
});

/** A progress block of the agent’s, with one step still running. */
function progress(threads, turnId = 'tu_1') {
  return threads.addItem('th_c', {
    kind: 'block',
    valid: true,
    sessionId: 'se_1',
    turnId,
    block: { type: 'progress', id: 'b1', title: 'Plan', steps: [{ id: 's1', label: 'Fetch', state: 'running' }] },
  });
}

// ── A finished turn ──────────────────────────────────────────────────────────────────

test('endTurn marks the steps left running stalled and sends its problems back to the agent as one lint turn, where it replied', () => {
  const { store, threads, checks, sent } = rig();
  const it = progress(threads);
  checks.endTurn(turnOf(), store.state.sessions.se_1);
  assert.equal(store.item('th_c', it.id).block.steps[0].state, 'stalled');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, 'se_1');
  assert.equal(sent[0].message.kind, 'lint');
  assert.deepEqual(
    sent[0].message.problems.map((p) => p.code),
    ['steps-left-running'],
  );
  assert.deepEqual(sent[0].opts, { threadId: 'th_c' });
});

test('endTurn sends nothing for a turn with no problems, and a lint turn that wrote nothing leaves one line instead', () => {
  const { store, checks, sent } = rig();
  checks.endTurn(turnOf(), store.state.sessions.se_1);
  assert.deepEqual(sent, []);
  checks.endTurn(turnOf({ id: 'tu_2', kind: 'lint', defined: ['Step 2'] }), store.state.sessions.se_1);
  assert.deepEqual(sent, [], 'a lint turn is never linted');
  assert.equal(store.items('th_c').at(-1).text, '@alpha defined “Step 2”');
  assert.equal(checks.lint('se_1', 'tu_2', [PROBLEM]), false, 'nor what the browser finds in it');
});

// ── Problems after the turn ──────────────────────────────────────────────────────────

test('lint joins problems to a running turn’s lint turn, which goes when the turn ends; an unknown turn’s are dropped', () => {
  const { store, running, checks, sent } = rig();
  assert.equal(checks.lint('se_1', 'tu_gone', [PROBLEM]), false, 'a turn not running, with no entry');
  running.begin(turnOf());
  assert.equal(checks.lint('se_1', 'tu_1', [PROBLEM]), true);
  assert.deepEqual(sent, [], 'not while it runs');
  running.end('se_1');
  checks.endTurn(turnOf(), store.state.sessions.se_1);
  assert.deepEqual(
    sent.map((s) => s.message.problems.map((p) => p.code)),
    [['x']],
  );
  assert.equal(checks.lint('se_1', 'tu_1', [PROBLEM]), false, 'its lint turn has gone');
});

test('foldLint gives a lint turn still settling to the next turn instead, so it never goes on its own', async () => {
  const { store, threads, checks, sent } = rig({ lintSettleMs: 5 });
  progress(threads);
  checks.endTurn(turnOf(), store.state.sessions.se_1);
  const message = checks.foldLint('se_1', { text: 'next' });
  assert.equal(message.text, 'next');
  assert.match(message.lint, /Fetch/);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, [], 'past its settle wait');
  assert.deepEqual(checks.foldLint('se_1', { text: 'again' }), { text: 'again' }, 'folded once');
});

test('a lint turn waits while an app of the agent’s is checked, at most the limit, then names the version no page checked (#336)', () => {
  /** @type {any[]} */
  const timers = [];
  let now = 0;
  const { store, threads, checks, sent } = rig({
    lintSettleMs: 5,
    lintWaitMaxMs: 15,
    now: () => now,
    setTimer: (fn, ms) => timers.push({ fn, ms, unref() {} }) && timers.at(-1),
  });
  store.emit('app', { id: 'explorer', title: 'Corpus explorer', current: 5, sessionId: 'se_1', threadId: 'th_c', check: { status: 'pending' } });
  progress(threads);
  checks.endTurn(turnOf(), store.state.sessions.se_1);
  let waits = 0;
  while (timers.length) {
    const timer = timers.shift();
    now += timer.ms;
    waits++;
    timer.fn();
  }
  assert.ok(waits > 1, 'it waited again while the app was pending');
  assert.equal(sent.length, 1);
  assert.deepEqual(
    sent[0].message.problems.map((p) => p.code),
    ['steps-left-running', 'app-unchecked'],
  );
});

test('stopTimers clears a lint turn’s wait, so one due after close never goes', async () => {
  const { store, threads, checks, sent } = rig({ lintSettleMs: 5 });
  progress(threads);
  checks.endTurn(turnOf(), store.state.sessions.se_1);
  checks.stopTimers();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(sent, []);
});

// ── Stalled steps ────────────────────────────────────────────────────────────────────

test('stallLeftRunning tells the agent which steps stalled when its turn was stopped or failed; stallSteps answers the problems', () => {
  const { store, threads, checks, told } = rig();
  progress(threads);
  checks.stallLeftRunning(turnOf(), store.state.sessions.se_1, 'failed');
  assert.equal(told.length, 1);
  assert.match(told[0][1], /^Your last turn failed while progress steps were running:\n- Block “Plan” \(id b1\)/);
  assert.deepEqual(checks.stallSteps(turnOf(), store.state.sessions.se_1), [], 'none run any more');
  checks.stallLeftRunning(turnOf(), store.state.sessions.se_1, 'stopped');
  assert.equal(told.length, 1, 'nothing to tell');
});

// ── The page’s diagram reports ───────────────────────────────────────────────────────

test('diagramCheck takes a diagram too small to read to its agent once, and only at the conversation’s width', () => {
  const { store, threads, running, checks } = rig();
  const src = 'graph LR\nA-->B';
  const it = threads.addItem('th_c', { kind: 'agent', sessionId: 'se_1', turnId: 'tu_1', text: `\`\`\`mermaid\n${src}\n\`\`\`` });
  running.begin(turnOf());
  assert.equal(checks.diagramCheck('th_c', it.id, { src, textPx: 7, width: 400 }).sent, false, 'a narrow panel doesn’t count');
  assert.equal(checks.diagramCheck('th_c', it.id, { src, textPx: 7, width: 728 }).sent, true);
  assert.equal(store.state.sessions.se_1.diagramsLinted.length, 1);
  assert.equal(checks.diagramCheck('th_c', it.id, { src, textPx: 7, width: 728 }).sent, false, 'once per diagram');
});
