// wake_agent is gone: an @-mention is the only way one agent wakes another (designs/rooms-at-scale.md, “After
// `wake_agent` goes”; the person’s decision of 13 November 2026, #481). It leaves the tool list, open_topic loses
// `mentions`, and a call by name, from a session that resumed with a guide that still names it (#515), is refused with
// what to do instead, and does nothing.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcp } from '../server/mcp.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';
import * as arrange from './arrange.mjs';
import { held, settle, setup, sleep } from './side-threads-fixture.mjs';

const GONE = 'wake_agent is gone. Post a message that @-mentions the agent; that wakes it.';
const mcp = (rt, se, method, params) => handleMcp(rt, se.id, { jsonrpc: '2.0', id: 1, method, params }, rt.turns.get(se.id)?.token ?? null);

test('wake_agent isn’t a tool any more, and open_topic has no mentions', () => {
  assert.equal(
    TOOL_DEFS.some((d) => d.name === 'wake_agent'),
    false,
  );
  assert.equal(Object.hasOwn(TOOL_DEFS.find((d) => d.name === 'open_topic').inputSchema.properties, 'mentions'), false);
});

test('a call to wake_agent by name is refused with what to do instead, and wakes no one', async () => {
  const { store, rt, adapter, t, alpha, beta } = setup();
  const busy = held();
  adapter.next.push(busy.step);
  rt.sendMessage(t.id, { text: '@alpha go' });
  await sleep(5);
  const items = store.items(t.id).length;
  const listed = await mcp(rt, alpha, 'tools/list', {});
  assert.equal(
    listed.result.tools.some((x) => x.name === 'wake_agent'),
    false,
  );
  const r = await mcp(rt, alpha, 'tools/call', { name: 'wake_agent', arguments: { handle: 'beta', message: 'Check it.' } });
  assert.equal(r.result.isError, true);
  assert.equal(r.result.content[0].text, GONE);
  assert.equal(store.items(t.id).length, items, 'nothing posted');
  assert.deepEqual(arrange.waitingEntries(rt, beta.id), []);
  busy.release();
  await settle(rt);
  assert.equal(adapter.calls.filter((c) => c.sessionId === beta.id).length, 0);
});
