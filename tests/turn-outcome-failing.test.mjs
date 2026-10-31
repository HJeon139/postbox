// Conformance fixtures for turn outcomes (#508, DL-3, DL-8; designs/508/design.md, “Turn outcome”).
// One recorded turn that failed before output and the turn immediately after it, for each confirmed backend
// (Claude Code, Antigravity CLI, Codex). Kiro is not a paid backend, so it is reported unverified (DL-8).

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

test('Claude Code recorded failing turn produces no output; resume carries prompt and answers', () => {
  const failEvents = readJsonl('fixtures/claude-code/fail-before-output.jsonl');
  const failCtx = fakeContext();
  const failMapper = createStreamMapper(failCtx);
  for (const e of failEvents) failMapper.push(e);

  // Cut after init: no assistant output produced
  assert.equal(failCtx.calls.text, '');
  assert.equal(failMapper.result, null);

  const resumeEvents = readJsonl('fixtures/claude-code/resume-after-failure.jsonl');
  const resumeCtx = fakeContext();
  const resumeMapper = createStreamMapper(resumeCtx);
  for (const e of resumeEvents) resumeMapper.push(e);

  assert.match(resumeCtx.calls.text, /Eagle/i);
  assert.equal(resumeMapper.result?.subtype, 'success');
});

test('Antigravity CLI recorded failing turn produces no output; resume preserves conversation id and answers', () => {
  const failEvents = readJsonl('fixtures/antigravity-cli/fail-before-output.jsonl');
  const failCtx = fakeContext();
  const failMapper = createAgyMapper(failCtx);
  for (const e of failEvents) failMapper.push(e);

  assert.equal(failCtx.calls.text, '');
  assert.equal(failEvents[0].event, 'init');
  const convId = failEvents[0].conversation_id;

  const resumeEvents = readJsonl('fixtures/antigravity-cli/resume-after-failure.jsonl');
  const resumeCtx = fakeContext();
  const resumeMapper = createAgyMapper(resumeCtx);
  for (const e of resumeEvents) resumeMapper.push(e);

  assert.equal(resumeEvents[0].conversation_id, convId);
  assert.match(resumeCtx.calls.text, /chemical formula for water/i);
});

test('Codex app-server recorded failing turn has no output; uncommitted thread reports no rollout found', () => {
  const failEvents = readJsonl('fixtures/codex-app-server/fail-before-output.jsonl');
  const failCtx = fakeContext();
  const failMapper = createCodexMapper(failCtx);
  for (const e of failEvents) failMapper.push(e);

  assert.equal(failCtx.calls.text, '');

  const resumeEvents = readJsonl('fixtures/codex-app-server/resume-after-failure.jsonl');
  const errEvent = resumeEvents.find((e) => e.error?.message?.includes('no rollout found'));
  assert.ok(errEvent, 'Resume attempts on an uncommitted thread receive no rollout found');
  assert.equal(errEvent.error.code, -32600);
});

test('DL-3 and DL-8 outcome matrix: all confirmed backends produce zero output on fail-before-output', () => {
  const matrix = [
    { backend: 'claude-code', fixture: 'fixtures/claude-code/fail-before-output.jsonl', verified: true },
    { backend: 'antigravity-cli', fixture: 'fixtures/antigravity-cli/fail-before-output.jsonl', verified: true },
    { backend: 'codex', fixture: 'fixtures/codex-app-server/fail-before-output.jsonl', verified: true },
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
    } else if (row.backend === 'codex') {
      const m = createCodexMapper(ctx);
      for (const e of events) m.push(e);
    }
    assert.equal(ctx.calls.text, '', `${row.backend} must produce no output before failure`);
  }
});
