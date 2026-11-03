// Where the asset tools reach agents (#516 S3b): over MCP beside the runtime’s tools, listed, recorded and gated as
// they are; and on a host, where each one crosses to Postbox and waits for its answer (TOOL_ROUTES), with text only.
// These import only what was there before the tools, so each fails without them.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { endedWithoutReply, noteAnswer } from '../server/empty-reply.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { fireScheduledWake } from '../server/scheduled-wakes.mjs';
import { Store } from '../server/store.mjs';
import { TOOL_ROUTES, validateMessage } from '../shared/remote-protocol.mjs';
import { rig, running, settled, until } from './remote-turns-helpers.mjs';
import { settle, setup, sleep } from './side-threads-fixture.mjs';

const NAMES = ['list_assets', 'read_asset', 'write_asset', 'rename_asset', 'delete_asset', 'restore_asset'];

/** A turn held open, and its MCP calls. */
async function inTurn() {
  const r = setup();
  let release = () => {};
  r.adapter.next.push(async () => new Promise((done) => (release = () => done(undefined))));
  r.rt.sendMessage(r.t.id, { text: '@alpha go' });
  await sleep(5);
  const token = r.rt.turns.get(r.alpha.id).token;
  const rpc = (method, params) => handleMcp(r.rt, r.alpha.id, { jsonrpc: '2.0', id: 1, method, params }, token);
  const call = async (name, args) => (await rpc('tools/call', { name, arguments: args })).result;
  return {
    ...r,
    rpc,
    call,
    end: async () => {
      release();
      await settle(r.rt);
    },
  };
}

test('#516 S3b: tools/list offers the six asset tools, and a call reaches them: in memory, a write says there’s no data folder', async () => {
  const r = await inTurn();
  const listed = (await r.rpc('tools/list', {})).result.tools.map((t) => t.name);
  for (const name of NAMES) assert.ok(listed.includes(name), `${name} is offered`);
  const write = await r.call('write_asset', { name: 'a.md', text: 'x' });
  assert.equal(write.isError, true);
  assert.match(write.content[0].text, /keeps no data folder/);
  assert.match((await r.call('list_assets', {})).content[0].text, /no assets yet/);
  await r.end();
});

test('#516 S3b: while the store is closed, the asset writes are refused with the cause and the reads answer', async () => {
  const r = await inTurn();
  r.store.writable = false;
  r.store.cause = new Error('Postbox can’t write its event log (EIO): disk sync refused.');
  for (const name of ['write_asset', 'rename_asset', 'delete_asset', 'restore_asset'])
    assert.match((await r.call(name, { id: 'as_x', base: 1, text: 'x', version: 1 })).content[0].text, /can’t write its event log/, name);
  for (const name of ['list_assets', 'read_asset']) assert.doesNotMatch((await r.call(name, { id: 'as_x' })).content[0].text, /event log/, name);
  r.store.writable = true;
  r.store.cause = null;
  await r.end();
});

test('#516 S3b: on a host, each asset tool crosses to Postbox and waits for its answer, and the host accepts a call to one', () => {
  for (const name of NAMES) {
    assert.equal(TOOL_ROUTES[name], 'ask', name);
    const v = validateMessage('shim-to-daemon', { type: 'call', id: 'c1', name, args: {} });
    assert.equal(v.ok, true, `${name}: ${v.ok ? '' : v.error}`);
  }
});

test('#516 S3b: an agent on a host writes and reads an asset through Postbox, with text only', async (ctx) => {
  const dir = mkdtempSync(join(tmpdir(), 'pb-asset-host-'));
  const store = await new Store(dir).load();
  ctx.after(async () => {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const r = rig({ store });
  const turn = await running(r);
  const answer = async (name, args) => {
    const id = r.d.tool(turn, name, args);
    await until(() => r.d.replies.some((x) => x.id === id), `${name}’s reply`);
    return r.d.replies.find((x) => x.id === id);
  };
  const made = await answer('write_asset', { name: 'notes.md', text: 'from the host' });
  assert.equal(made.ok, true, made.text);
  const id = /asset (as_\w+)/.exec(made.text)?.[1];
  assert.match((await answer('read_asset', { id })).text, /by @coder[\s\S]*from the host/);
  const path = await answer('write_asset', { name: 'other.md', path: 'notes.md' });
  assert.equal(path.ok, false);
  assert.match(path.text, /On a remote host, write_asset takes text/);
  r.d.end(turn);
  await settled(r);
});

test('#516 S3b: a scheduled turn’s recovery names the asset writes it started, not its reads (#466)', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Publish the plan.' });
  f.adapter.next.push(async () => {
    const token = f.rt.turns.get(f.alpha.id)?.token ?? null;
    for (const [name, args] of [
      ['list_assets', {}],
      ['read_asset', { id: 'as_x' }],
      ['write_asset', { name: 'plan.md', text: 'x' }],
    ])
      await handleMcp(f.rt, f.alpha.id, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, token);
    throw Object.assign(new Error('network failed: ECONNRESET'), { code: 'ECONNRESET' });
  });
  clearTimeout(f.rt.timers.get(sc.id));
  fireScheduledWake(f.rt, sc);
  await settle(f.rt);
  assert.deepEqual(f.store.state.schedules[sc.id]?.recoveryTools, ['write_asset']);
  f.rt.cancelSchedule(sc.id);
});

test('#516 S3b: a turn that only lists or reads assets still owes its reply; one that writes one has answered (#485)', () => {
  const turn = { id: 'tu_1', kind: 'user', said: '' };
  for (const name of ['list_assets', 'read_asset']) noteAnswer(turn, name, { ok: true });
  assert.equal(endedWithoutReply(turn, []), true);
  noteAnswer(turn, 'write_asset', { ok: true });
  assert.equal(endedWithoutReply(turn, []), false);
});
