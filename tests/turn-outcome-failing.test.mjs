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

/**
 * Verifies that the raw event stream for a failed turn contains zero qualifying tool calls
 * or assistant output blocks, independently of mapper/UI suppression (e.g. quiet tools or Postbox MCP tools).
 */
function assertNoQualifyingToolCallsOrOutput(backend, events) {
  if (backend === 'claude-code') {
    for (const e of events) {
      assert.notEqual(e.type, 'assistant', 'Raw Claude event stream must contain no assistant messages');
      if (e.type === 'stream_event') {
        assert.notEqual(e.event?.type, 'content_block_start', 'No content blocks started');
        assert.notEqual(e.event?.type, 'content_block_delta', 'No content block deltas');
      }
      assert.ok(!e.tool_use, 'No tool_use fields');
    }
  } else if (backend === 'antigravity-cli') {
    for (const e of events) {
      const stepType = e.step_update?.step_type;
      assert.notEqual(stepType, 'tool', 'Raw Antigravity event stream must contain no tool steps');
      assert.ok(!e.step_update?.text_delta, 'No text deltas');
      if (e.event === 'result') {
        assert.ok(!e.result?.response, 'No result response');
      }
    }
  } else if (backend.startsWith('codex')) {
    for (const e of events) {
      // Reject any item/* method: item/started, item/completed, item/agentMessage/delta, etc.
      assert.ok(!e.method?.startsWith('item/'), `Raw Codex event stream must contain no item methods, found ${e.method}`);
      // Reject any item payload in turn or result objects
      const itemType = e.params?.item?.type ?? e.result?.item?.type;
      assert.ok(!itemType, `No item payload permitted, found item type ${itemType}`);
      const turnItems = e.params?.turn?.items ?? e.result?.turn?.items;
      if (Array.isArray(turnItems)) {
        assert.equal(turnItems.length, 0, 'Turn items array must be empty');
      }
    }
  }
}

test('Claude Code recorded failing turn produces no output or tool calls; resume fetches history and answers', () => {
  const failEvents = readJsonl('fixtures/claude-code/fail-before-output.jsonl');
  const failCtx = fakeContext();
  const failMapper = createStreamMapper(failCtx);
  for (const e of failEvents) failMapper.push(e);

  assert.equal(failCtx.calls.text, '');
  assert.equal(failCtx.calls.activity.length, 0, 'No qualifying tool calls emitted before failure');
  assert.equal(failMapper.result, null);
  assertNoQualifyingToolCallsOrOutput('claude-code', failEvents);

  const resumeEvents = readJsonl('fixtures/claude-code/resume-after-failure.jsonl');
  const resumeCtx = fakeContext();
  const resumeMapper = createStreamMapper(resumeCtx);
  for (const e of resumeEvents) resumeMapper.push(e);

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
  assertNoQualifyingToolCallsOrOutput('antigravity-cli', failEvents);

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
  assertNoQualifyingToolCallsOrOutput('codex-init', failEvents);

  const resumeEvents = readJsonl('fixtures/codex-app-server/resume-after-failure.jsonl');
  const errEvent = resumeEvents.find((e) => e.error?.message?.includes('no rollout found'));
  assert.ok(errEvent, 'Resume attempts on an uncommitted thread receive no rollout found');
  assert.equal(errEvent.error.code, -32600);
});

test('Codex app-server turn-start fixture: zero output, zero tool calls; resume hydrates turn with empty items', () => {
  const failEvents = readJsonl('fixtures/codex-app-server/turn-fail-before-output.jsonl');
  const failCtx = fakeContext();
  const failMapper = createCodexMapper(failCtx);
  for (const e of failEvents) failMapper.push(e);

  assert.equal(failCtx.calls.text, '');
  assert.equal(failCtx.calls.activity.length, 0, 'No qualifying tool calls emitted before failure');

  // Verify turn acceptance event exists, but zero item methods or qualifying tool calls occurred
  assert.ok(failEvents.some((e) => e.method === 'turn/started'));
  assertNoQualifyingToolCallsOrOutput('codex-turn', failEvents);

  const resumeEvents = readJsonl('fixtures/codex-app-server/resume-turn-after-failure.jsonl');
  const resumeCtx = fakeContext();
  const resumeMapper = createCodexMapper(resumeCtx);
  for (const e of resumeEvents) resumeMapper.push(e);

  // Resume succeeds: thread response contains the interrupted turn with empty items
  const threadRes = resumeEvents.find((e) => e.id === 2 && e.result?.thread);
  assert.ok(threadRes, 'thread/resume response exists');
  const turns = threadRes.result.thread.turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, 'interrupted');
  assert.deepEqual(turns[0].items, []);

  // Assistant completed the follow-up turn stating it does not have the earlier question
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
    assertNoQualifyingToolCallsOrOutput(row.backend, events);
  }
});
