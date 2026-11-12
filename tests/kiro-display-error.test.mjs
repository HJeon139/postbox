// #489: when an MCP server fails to start, Kiro says so in a display_error and the turn still ends as a success, with
// the model offered none of that server’s tools (recorded 6 Nov with kiro-cli 3.1.0, engine v3). When the server is
// Postbox’s, the person sees a failed step that says so, and the agent hears of it at its next turn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createKiroMapper } from '../server/adapters/kiro-cli.mjs';
import { fakeCtx, fixture } from './kiro-cli-fakes.mjs';

/** A display_error as kiro-cli 3.1.0 sends it, for the named server. @param {string} server */
const displayError = (server) => ({
  type: 'sessionUpdate',
  data: {
    sessionId: 'sess_2daecf15-7dd7-4df8-9238-71c5caaf1df2',
    update: {
      sessionUpdate: 'session_info_update',
      _meta: {
        kiro: {
          kind: 'display_error',
          message: `MCP server "${server}" failed to connect: Connection closed`,
          errorType: 'mcp_connection_error',
          displayError: { message: `MCP server "${server}" failed to connect: Connection closed`, errorType: 'mcp_connection_error' },
        },
      },
    },
  },
});

/** The recorded first turn, with a display_error for the server just after it starts. @param {string} server */
const withError = (server) => {
  const lines = fixture('first');
  return [lines[0], displayError(server), ...lines.slice(1)];
};

const replay = (lines) => {
  const ctx = fakeCtx();
  const m = createKiroMapper(ctx, { now: () => 1000 });
  for (const e of lines) m.push(e);
  return { ctx, m };
};

test('#489 Postbox’s tool server failing to start is a failed step the person sees, with what Kiro said', () => {
  const { ctx, m } = replay(withError('postbox'));
  const step = ctx.calls.activity.find((a) => a.label === 'Postbox’s tools didn’t load');
  assert.ok(step, 'a step says so');
  assert.equal(step.state, 'failed');
  assert.match(step.detail, /MCP server "postbox" failed to connect: Connection closed/);
  assert.equal(m.error, null, 'the turn itself still succeeds, as Kiro ended it');
  assert.equal(ctx.calls.text, 'OK', 'and its reply is kept');
});

test('#489 another server failing to start is a failed step too, named for it', () => {
  const { ctx } = replay(withError('github'));
  const step = ctx.calls.activity.find((a) => a.state === 'failed');
  assert.ok(step, 'a failed step');
  assert.match(step.label, /github/);
  assert.ok(!ctx.calls.activity.some((a) => a.label === 'Postbox’s tools didn’t load'), 'not worded as Postbox’s');
});
