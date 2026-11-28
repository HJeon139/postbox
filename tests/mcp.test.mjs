// The MCP endpoint’s own checks (server/mcp.mjs): which turn a tool call comes from.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcp } from '../server/mcp.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';
import * as arrange from './arrange.mjs';
import { settle, setup, sleep } from './side-threads-fixture.mjs';

test('#351: a tool call is refused unless its token is the running turn’s exactly, whatever its length or characters', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  let release = () => {};
  const held = new Promise((r) => {
    release = () => r(undefined);
  });
  adapter.next.push(async () => held);
  rt.sendMessage(t.id, { text: '@alpha wait' });
  await sleep(5);
  const token = arrange.turnToken(rt, alpha.id);
  const define = (turn) =>
    handleMcp(rt, alpha.id, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'define_term', arguments: { term: 'W', definition: 'D' } } }, turn);
  // One character off, one short, one long, and the same length in characters but not in bytes.
  for (const wrong of [`${token.slice(0, -1)}x`, token.slice(0, -1), `${token}x`, 'é'.repeat(token.length)])
    assert.equal((await define(wrong)).error?.code, -32001, wrong);
  assert.deepEqual(store.state.glossary[t.id] ?? {}, {}, 'no refused call defined anything');
  assert.equal((await define(token)).result.isError, false);
  release();
  await settle(rt);
});

test('define_term’s description says what to define and how a term links (#102)', () => {
  const said = TOOL_DEFS.find((t) => t.name === 'define_term')?.description ?? '';
  // What to define, and what a citation’s definition holds.
  for (const what of ['R:31', 'abbreviation', 'coined', 'quotes or summarizes']) assert.ok(said.includes(what), what);
  // How it links: whole words, short terms in their own case, dash and quote variants, topic threads, earlier replies.
  for (const how of ['whole word', 'own case', 'U:45–52 is U:45-52', 'topic thread inherits', 'earlier replies']) assert.ok(said.includes(how), how);
  // Its key: “#A” and “A” key alike, so one would replace the other without a key of its own.
  assert.ok(said.includes('give such a reference a key of its own, such as ref-a'), 'its own key');
});
