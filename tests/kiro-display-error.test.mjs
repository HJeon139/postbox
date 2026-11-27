// #489: when an MCP server fails to start, Kiro says so in a display_error and the turn still ends as a success, with
// the model offered none of that server’s tools. When the server is Postbox’s, the person sees a failed step that says
// so, and the agent hears of it at its next turn. #1171: the line is the one kiro-cli 3.6.2 wrote in a recorded turn
// (tests/fixtures/kiro-cli/auto-shell-files.jsonl, where Postbox’s server couldn’t be reached); the other cases change
// one field of it, and say which.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKiroMapper } from '../server/adapters/kiro-cli.mjs';
import { fakeCtx, fixture } from './kiro-cli-fakes.mjs';

/** The display_error line as kiro-cli 3.6.2 wrote it. */
const RECORDED = fixture('auto-shell-files').find((e) => e.data?.update?._meta?.kiro?.kind === 'display_error');

/** The recorded line with its words or type changed, both where Kiro puts them. @param {{ message?: string, errorType?: string }} change */
function changed({ message, errorType }) {
  const e = structuredClone(RECORDED);
  const k = e.data.update._meta.kiro;
  for (const at of [k, k.displayError]) {
    if (message !== undefined) at.message = message;
    if (errorType !== undefined) at.errorType = errorType;
  }
  return e;
}

/** The recorded first turn, with a display_error just after it starts. @param {any} line */
const withError = (line) => {
  const lines = fixture('first');
  return [lines[0], line, ...lines.slice(1)];
};

const replay = (lines) => {
  const ctx = fakeCtx();
  const m = createKiroMapper(ctx, { now: () => 1000 });
  for (const e of lines) m.push(e);
  return { ctx, m };
};
const postboxStep = (ctx) => ctx.calls.activity.find((a) => a.label === 'Postbox’s tools didn’t load');

test('#1171 the recorded line is a display_error for Postbox’s server, as the code expects', () => {
  assert.ok(RECORDED, 'the fixture holds one');
  const k = RECORDED.data.update._meta.kiro;
  assert.equal(k.errorType, 'mcp_connection_error');
  assert.match(k.message, /^MCP server "postbox" failed to connect: /);
});

test('#489 Postbox’s tool server failing to start is a failed step the person sees, with what Kiro said', () => {
  const { ctx, m } = replay(withError(RECORDED));
  const step = postboxStep(ctx);
  assert.ok(step, 'a step says so');
  assert.equal(step.state, 'failed');
  assert.match(step.detail, /MCP server "postbox" failed to connect: fetch failed/);
  assert.equal(ctx.calls.saved.postboxToolsDown, 'ran', 'and the agent is told at its next turn');
  assert.equal(m.error, null, 'the turn itself still succeeds, as Kiro ended it');
  assert.equal(ctx.calls.text, 'OK', 'and its reply is kept');
});

test('#489 another server failing to start is a failed step too, named for it', () => {
  const { ctx } = replay(withError(changed({ message: 'MCP server "github" failed to connect: fetch failed' })));
  const step = ctx.calls.activity.find((a) => a.state === 'failed');
  assert.ok(step, 'a failed step');
  assert.match(step.label, /github/);
  assert.equal(postboxStep(ctx), undefined, 'not worded as Postbox’s');
});

test('#1171 only an mcp_connection_error naming the server first reads as Postbox’s server not starting', () => {
  for (const line of [
    changed({ errorType: 'mcp_tool_error' }),
    changed({ message: 'Could not refresh: MCP server "postbox" failed to connect: fetch failed' }),
  ]) {
    const { ctx } = replay(withError(line));
    assert.equal(postboxStep(ctx), undefined, JSON.stringify(line.data.update._meta.kiro.message));
    assert.equal(ctx.calls.saved.postboxToolsDown, undefined, 'and no note for the next turn');
    assert.ok(
      ctx.calls.activity.some((a) => a.label === 'Kiro reported an error' && a.state === 'failed'),
      'it’s Kiro’s error',
    );
  }
});

test('#1171 Kiro’s words reach the step cleaned: no bidi or zero-width characters, no line breaks, no split character', () => {
  const sneaky = `MCP server "postbox" failed to connect: ‮deliaf‬​\nretry later ${'é'.repeat(10)}${'😀'.repeat(300)}`;
  const { ctx } = replay(withError(changed({ message: sneaky })));
  const step = postboxStep(ctx);
  assert.ok(step, 'still Postbox’s server');
  assert.doesNotMatch(step.detail, /[‮‬​\n]/u, 'no hidden or reordering characters, no line break');
  assert.match(step.detail, /fetch|deliaf retry later/, 'the words kept, on one line');
  assert.doesNotMatch(step.detail, /\p{Cs}/u, 'no lone surrogate from the cut');
});
