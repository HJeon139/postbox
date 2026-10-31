// Baseline replay fixtures for turn outcomes (#508, DL-3, DL-8; designs/508/design.md, “Turn outcome”).
// Recorded turns that fail before output and the turn immediately after them on main, for each confirmed backend
// (Claude Code, Antigravity CLI, Codex app-server init-fail and turn-start-fail).
//
// These recordings establish the baseline on main that A2 is measured against: a turn failing before output did not
// have its prompt preserved in backend history. A2 uses the mappers reporting zero text and zero activity to detect
// “failed before output” and re-inject the unacknowledged prompt.

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
 * Guards that a recorded fixture is what its filename claims (zero qualifying tool calls or assistant output),
 * independently of mapper or UI suppression (such as quiet tools or Postbox MCP tools).
 * The negative control below proves this check discriminates by rejecting streams that contain output or tool steps.
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

test('negative control: assertNoQualifyingToolCallsOrOutput rejects resume streams containing output or tool calls', () => {
  const resumes = [
    ['claude-code', 'fixtures/claude-code/resume-after-failure.jsonl'],
    ['antigravity-cli', 'fixtures/antigravity-cli/resume-after-failure.jsonl'],
    ['codex', 'fixtures/codex-app-server/resume-turn-after-failure.jsonl'],
  ];
  for (const [backend, file] of resumes) {
    const events = readJsonl(file);
    assert.throws(
      () => assertNoQualifyingToolCallsOrOutput(backend, events),
      (err) => err instanceof assert.AssertionError,
      `assertNoQualifyingToolCallsOrOutput must reject resume stream for ${backend}`,
    );
  }
});

test('Claude Code recorded failing turn produces no output or tool calls; baseline follow-up on main', () => {
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

  // Baseline on main before A2: unacknowledged message was missing from prompt; model recovered via read_conversation
  const readConvCall = resumeEvents.find((e) => e.type === 'assistant' && e.message?.content?.some((c) => c.name === 'mcp__postbox__read_conversation'));
  assert.ok(readConvCall, 'Resume turn called read_conversation to inspect previous prompt');
  assert.equal(resumeMapper.result?.subtype, 'success');
});

test('Antigravity CLI recorded failing turn produces no output or tool calls; baseline follow-up on main', () => {
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

  // Baseline on main before A2: resumed existing conversation id; recovered prompt via read_conversation
  assert.equal(resumeEvents[0].conversation_id, convId);
  const mcpCall = resumeEvents.find((e) => e.step_update?.tool_name === 'call_mcp_tool');
  assert.equal(mcpCall?.step_update?.tool_info?.parameters?.ToolName, 'read_conversation');
});

test('Codex app-server init-fail fixture: zero output, zero tool calls; baseline on main receives no rollout found (#587)', () => {
  const failEvents = readJsonl('fixtures/codex-app-server/fail-before-output.jsonl');
  const failCtx = fakeContext();
  const failMapper = createCodexMapper(failCtx);
  for (const e of failEvents) failMapper.push(e);

  assert.equal(failCtx.calls.text, '');
  assert.equal(failCtx.calls.activity.length, 0, 'No qualifying tool calls emitted before failure');
  assertNoQualifyingToolCallsOrOutput('codex-init', failEvents);

  const resumeEvents = readJsonl('fixtures/codex-app-server/resume-after-failure.jsonl');
  const errEvent = resumeEvents.find((e) => e.error?.message?.includes('no rollout found'));
  assert.ok(errEvent, 'Resume attempts on an uncommitted thread receive no rollout found on main (#587)');
  assert.equal(errEvent.error.code, -32600);
});

test('Codex app-server turn-start fixture: zero output, zero tool calls; baseline follow-up on main', () => {
  const failEvents = readJsonl('fixtures/codex-app-server/turn-fail-before-output.jsonl');
  const failCtx = fakeContext();
  const failMapper = createCodexMapper(failCtx);
  for (const e of failEvents) failMapper.push(e);

  assert.equal(failCtx.calls.text, '');
  assert.equal(failCtx.calls.activity.length, 0, 'No qualifying tool calls emitted before failure');

  assert.ok(failEvents.some((e) => e.method === 'turn/started'));
  assertNoQualifyingToolCallsOrOutput('codex-turn', failEvents);

  const resumeEvents = readJsonl('fixtures/codex-app-server/resume-turn-after-failure.jsonl');
  const resumeCtx = fakeContext();
  const resumeMapper = createCodexMapper(resumeCtx);
  for (const e of resumeEvents) resumeMapper.push(e);

  // Baseline on main before A2: resumed thread contains the interrupted turn with an empty items list
  const threadRes = resumeEvents.find((e) => e.id === 2 && e.result?.thread);
  assert.ok(threadRes, 'thread/resume response exists');
  const turns = threadRes.result.thread.turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].status, 'interrupted');
  assert.deepEqual(turns[0].items, []);
});
