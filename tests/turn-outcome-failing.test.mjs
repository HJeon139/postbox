// Conformance fixtures for turn outcomes (#508, DL-3, DL-8; designs/508/design.md, “Turn outcome”).
// Recorded turns that fail before output and the turn immediately after them, for each confirmed backend
// (Claude Code, Antigravity CLI, Codex app-server init-fail and turn-start-fail). Kiro is reported unverified (DL-8).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createAgyMapper } from '../server/adapters/antigravity-cli.mjs';
import { createStreamMapper } from '../server/adapters/claude-stream.mjs';
import { createCodexMapper } from '../server/adapters/codex.mjs';

const readJsonl = (rel) =>
  readFileSync(new URL(rel, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

function fakeContext() {
  const calls = { text: '', status: [], activity: [] };
  return {
    calls,
    signal: new AbortController().signal,
    persona: { handle: 'researcher', model: 'haiku' },
    state: {},
    text: (d) => {
      calls.text += d;
    },
    status: (s) => calls.status.push(s),
    activity: (a) => calls.activity.push(a),
    saveState: () => {},
  };
}

test('Claude Code recorded failing turn produces no output or tool calls; resume fetches history and answers', () => {
  const failEvents = readJsonl('fixtures/claude-code/fail-before-output.jsonl');
  const failCtx = fakeContext();
  const failMapper = createStreamMapper(failCtx);
  for (const e of failEvents) failMapper.push(e);

  // Cut after init: zero text, zero tool calls, no completed result
  assert.equal(failCtx.calls.text, '');
  assert.equal(failCtx.calls.activity.length, 0, 'No qualifying tool calls emitted before failure');
  assert.equal(failMapper.result, null);

  // Raw events contain no assistant content blocks or tool calls
  assert.ok(!failEvents.some((e) => e.type === 'assistant' || e.type === 'stream_event'));

  const resumeEvents = readJsonl('fixtures/claude-code/resume-after-failure.jsonl');
  const resumeCtx = fakeContext();
  const resumeMapper = createStreamMapper(resumeCtx);
  for (const e of resumeEvents) resumeMapper.push(e);

  // Resume fetched conversation history using read_conversation tool call
  const readConvCall = resumeEvents.find((e) => e.type === 'assistant' && e.message?.content?.some((c) => c.name === 'mcp__postbox__read_conversation'));
  assert.ok(readConvCall, 'Resume turn must call read_conversation to inspect previous prompt');
  assert.match(resumeCtx.calls.text, /Eagle/i);
  assert.equal(resumeMapper.result?.subtype, 'success');
});

test('Antigravity CLI recorded failing turn produces no output or tool calls; resume preserves conversation id and answers', () => {
  const failEvents = readJsonl('fixtures/antigravity-cli/fail-before-output.jsonl');
  const failCtx = fakeContext();
  const failMapper = createAgyMapper(failCtx);
  for (const e of failEvents) failMapper.push(e);

  assert.equal(failCtx.calls.text, '');
  assert.equal(failCtx.calls.activity.length, 0, 'No qualifying tool calls emitted before failure');
  assert.equal(failEvents[0].event, 'init');
  const convId = failEvents[0].conversation_id;

  // Raw events contain zero tool steps or assistant delta steps
  assert.ok(!failEvents.some((e) => e.step_update?.step_type === 'tool' || e.step_update?.text_delta));

  const resumeEvents = readJsonl('fixtures/antigravity-cli/resume-after-failure.jsonl');
  const resumeCtx = fakeContext();
  const resumeMapper = createAgyMapper(resumeCtx);
  for (const e of resumeEvents) resumeMapper.push(e);

  assert.equal(resumeEvents[0].conversation_id, convId);
  const mcpCall = resumeEvents.find((e) => e.step_update?.tool_name === 'call_mcp_tool');
  assert.equal(mcpCall?.step_update?.tool_info?.parameters?.ToolName, 'read_conversation');
  assert.match(resumeCtx.calls.text, /chemical formula for water/i);
});

test('Codex app-server init-fail fixture: zero output, zero tool calls, uncommitted thread reports no rollout found', () => {
  const failEvents = readJsonl('fixtures/codex-app-server/fail-before-output.jsonl');
  const failCtx = fakeContext();
  const failMapper = createCodexMapper(failCtx);
  for (const e of failEvents) failMapper.push(e);

  assert.equal(failCtx.calls.text, '');
  assert.equal(failCtx.calls.activity.length, 0, 'No qualifying tool calls emitted before failure');

  // Verify zero turn deltas or item completions
  assert.ok(!failEvents.some((e) => e.method?.startsWith('item/') || e.method === 'turn/started'));

  const resumeEvents = readJsonl('fixtures/codex-app-server/resume-after-failure.jsonl');
  const errEvent = resumeEvents.find((e) => e.error?.message?.includes('no rollout found'));
  assert.ok(errEvent, 'Resume attempts on an uncommitted thread receive no rollout found');
  assert.equal(errEvent.error.code, -32600);
});

test('Codex app-server turn-start fixture: zero output, zero tool calls, resume hydrates interrupted turn', () => {
  const failEvents = readJsonl('fixtures/codex-app-server/turn-fail-before-output.jsonl');
  const failCtx = fakeContext();
  const failMapper = createCodexMapper(failCtx);
  for (const e of failEvents) failMapper.push(e);

  assert.equal(failCtx.calls.text, '');
  assert.equal(failCtx.calls.activity.length, 0, 'No qualifying tool calls emitted before failure');

  // Verify turn was accepted (turn/started exists) but zero deltas or tool calls occurred
  assert.ok(failEvents.some((e) => e.method === 'turn/started'));
  assert.ok(!failEvents.some((e) => e.method?.startsWith('item/') && e.method !== 'item/started'));

  const resumeEvents = readJsonl('fixtures/codex-app-server/resume-turn-after-failure.jsonl');
  const resumeCtx = fakeContext();
  const resumeMapper = createCodexMapper(resumeCtx);
  for (const e of resumeEvents) resumeMapper.push(e);

  // Resume succeeds: thread response contains the interrupted turn
  const threadRes = resumeEvents.find((e) => e.id === 2 && e.result?.thread);
  assert.ok(threadRes, 'thread/resume response exists');
  const turns = threadRes.result.thread.turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, 'interrupted');
  assert.deepEqual(turns[0].items, []);

  // Assistant completed the follow-up turn
  assert.match(resumeCtx.calls.text, /earlier question/i);
});

test('DL-3 and DL-8 outcome matrix: all confirmed backends produce zero output and zero tool calls on fail-before-output', () => {
  const matrix = [
    { backend: 'claude-code', fixture: 'fixtures/claude-code/fail-before-output.jsonl', verified: true },
    { backend: 'antigravity-cli', fixture: 'fixtures/antigravity-cli/fail-before-output.jsonl', verified: true },
    { backend: 'codex-init', fixture: 'fixtures/codex-app-server/fail-before-output.jsonl', verified: true },
    { backend: 'codex-turn', fixture: 'fixtures/codex-app-server/turn-fail-before-output.jsonl', verified: true },
    { backend: 'kiro-cli', fixture: null, verified: false, reason: 'unverified: not among paid backends' },
  ];

  for (const row of matrix) {
    if (!row.verified) {
      assert.equal(row.fixture, null);
      assert.match(row.reason, /unverified/);
      continue;
    }
    const events = readJsonl(row.fixture);
    const ctx = fakeContext();
    if (row.backend === 'claude-code') {
      const m = createStreamMapper(ctx);
      for (const e of events) m.push(e);
    } else if (row.backend === 'antigravity-cli') {
      const m = createAgyMapper(ctx);
      for (const e of events) m.push(e);
    } else if (row.backend.startsWith('codex')) {
      const m = createCodexMapper(ctx);
      for (const e of events) m.push(e);
    }
    assert.equal(ctx.calls.text, '', `${row.backend} must produce no text output before failure`);
    assert.equal(ctx.calls.activity.length, 0, `${row.backend} must produce no qualifying tool calls before failure`);
  }
});
