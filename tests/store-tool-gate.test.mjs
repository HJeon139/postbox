// The tools’ gate while the store is closed (#508’s storage design, “When a write fails (ST-3)”; the 1b invariants, I1):
// a tool that would write is refused with the cause at the MCP entry, the one gate for tools; a tool that reads answers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcp } from '../server/mcp.mjs';
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
  store.fail(eio());
  const write = await call('define_term', { term: 'W', definition: 'D' });
  assert.equal(write.result.isError, true);
  assert.match(write.result.content[0].text, /can’t write its event log.*EIO/);
  assert.deepEqual(store.state.glossary[t.id] ?? {}, {}, 'the refused call defined nothing');
  const read = await call('read_conversation', {});
  assert.notEqual(read.result?.isError, true, JSON.stringify(read).slice(0, 300));
  // An in-memory store has no folder to reload; reopening by hand stands in for Retry here.
  store.writable = true;
  store.cause = null;
  const again = await call('define_term', { term: 'W', definition: 'D' });
  assert.equal(again.result.isError, false);
  release();
  await settle(rt);
});
