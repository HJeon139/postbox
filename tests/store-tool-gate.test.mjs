// The tools’ gate while the store is closed (#508’s storage design, “When a write fails (ST-3)”; the 1b invariants, I1):
// a tool that would write is refused with the cause at the MCP entry, the one gate for tools; a tool that reads answers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcp, READ_TOOLS } from '../server/mcp.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';
import { settle, setup, sleep } from './side-threads-fixture.mjs';

const eio = () => Object.assign(new Error('disk sync refused'), { code: 'EIO' });

test('while the store is closed, a writing tool is refused with the cause and a reading tool answers; after Retry both answer', async () => {
  const { store, rt, adapter, t, alpha } = setup();
  let release = () => {};
  const held = new Promise((r) => {
    release = () => r(undefined);
  });
  adapter.next.push(async () => held);
  rt.sendMessage(t.id, { text: '@alpha wait' });
  await sleep(5);
  const token = rt.turns.get(alpha.id).token;
  const call = (name, args) => handleMcp(rt, alpha.id, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, token);
  // The gate itself: writes closed without the runtime’s stop (which fail() triggers and the outage spec covers), so the
  // turn is still running and its call reaches the tool entry.
  store.writable = false;
  store.cause = Object.assign(new Error(`Postbox can’t write its event log (EIO): ${eio().message}.`), { code: 'EIO' });
  const write = await call('define_term', { term: 'W', definition: 'D' });
  assert.equal(write.result.isError, true);
  assert.match(write.result.content[0].text, /can’t write its event log.*EIO/);
  assert.deepEqual(store.state.glossary[t.id] ?? {}, {}, 'the refused call defined nothing');
  const read = await call('read_conversation', {});
  assert.notEqual(read.result?.isError, true, JSON.stringify(read).slice(0, 300));
  // Reopened by hand: an in-memory store has no folder for Retry to reload.
  store.writable = true;
  store.cause = null;
  const again = await call('define_term', { term: 'W', definition: 'D' });
  assert.equal(again.result.isError, false);
  release();
  await settle(rt);
});

test('every tool is classified for the gate: the read set, or the writers; a new tool must be placed', () => {
  const WRITERS = new Set([
    'add_dataset',
    'ask_for_tool',
    'bring_to_conversation',
    'cancel_wake',
    'define_term',
    'permission_prompt',
    'propose_agent',
    'react',
    'retire_app',
    'review_block',
    'schedule_wake',
    'show_app',
    'show_block',
    'update_app',
    'update_block',
    'wake_agent',
  ]);
  for (const name of READ_TOOLS)
    assert.ok(
      TOOL_DEFS.some((t) => t.name === name),
      `${name} is a tool`,
    );
  const unplaced = TOOL_DEFS.map((t) => t.name).filter((n) => !READ_TOOLS.has(n) && !WRITERS.has(n));
  assert.deepEqual(unplaced, [], 'place each new tool in READ_TOOLS (server/mcp.mjs) if it never writes, else in WRITERS here');
  for (const name of WRITERS) assert.ok(!READ_TOOLS.has(name), `${name} is not both`);
});
