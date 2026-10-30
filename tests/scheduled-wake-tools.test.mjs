// #466, from the integrator’s re-review of #522 at cc950c7: which tool calls a scheduled wake’s recovery names. react
// counts as the other Postbox tools do, through MCP and from a host.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleMcp } from '../server/mcp.mjs';
import { fireScheduledWake } from '../server/scheduled-wakes.mjs';
import { Store } from '../server/store.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';
import { rig, settled, starts, until } from './remote-turns-helpers.mjs';
import { settle, setup } from './side-threads-fixture.mjs';

const networkError = () => Object.assign(new Error('network failed: ECONNRESET'), { code: 'ECONNRESET' });
const fire = (rt, sc) => {
  clearTimeout(rt.timers.get(sc.id));
  fireScheduledWake(rt, sc);
};

test('#466 a react a scheduled turn calls through MCP counts as a tool that started', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Acknowledge the request.' });
  const mine = f.rt.addItem(sc.threadId, { kind: 'user', text: 'Please check.' });
  f.adapter.next.push(async () => {
    const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'react', arguments: { id: mine.id, emoji: '👍' } } };
    const r = await handleMcp(f.rt, f.alpha.id, call, f.rt.turns.get(f.alpha.id)?.token ?? null);
    assert.equal(r.result.isError, false, JSON.stringify(r.result));
    throw networkError();
  });
  fire(f.rt, sc);
  await settle(f.rt);
  assert.deepEqual(f.store.state.schedules[sc.id]?.recoveryTools, ['react']);
  f.rt.cancelSchedule(sc.id);
});

test('#466 a react a scheduled turn on a host calls counts as a tool that started', async () => {
  const r = rig({ store: new Store(null), d: createFakeDaemon({ autoEnd: false }) });
  const mine = r.rt.addItem(r.t.id, { kind: 'user', text: 'Please check.' });
  const sc = r.rt.schedule(r.se().id, { inMs: 60_000, note: 'Acknowledge the request.' });
  fire(r.rt, sc);
  await until(() => starts(r.d).length === 1, 'the wake’s turn to start on the host');
  const turn = starts(r.d)[0].turn;
  r.d.tool(turn, 'react', { id: mine.id, emoji: '👍' });
  await until(() => r.d.replies.length === 1, 'the reply');
  assert.equal(r.d.replies[0].ok, true, r.d.replies[0].text);
  assert.ok(r.store.state.schedules[sc.id]?.startedTools?.includes('react'), JSON.stringify(r.store.state.schedules[sc.id]?.startedTools));
  r.d.end(turn);
  await settled(r);
});

test('#466 a recovery keeps another MCP server’s name on its tools, and drops only Postbox’s', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'File the issue.' });
  f.adapter.next.push(async (ctx) => {
    ctx.toolUse({ id: 't1', name: 'mcp__github__create_issue', input: {} });
    ctx.toolUse({ id: 't2', name: 'mcp__postbox__define_term', input: {} });
    throw networkError();
  });
  fire(f.rt, sc);
  await settle(f.rt);
  assert.deepEqual(f.store.state.schedules[sc.id]?.recoveryTools, ['mcp__github__create_issue', 'define_term']);
  f.rt.cancelSchedule(sc.id);
});

test('#466 one show_app call is one tool in the recovery, not show_app and show_block', async () => {
  const f = setup();
  const sc = f.rt.schedule(f.alpha.id, { inMs: 60_000, note: 'Show the lab.' });
  f.adapter.next.push(async (ctx) => {
    ctx.tools.show_app({ id: 'lab', title: 'Lab', code: '<p>First</p>' });
    throw networkError();
  });
  fire(f.rt, sc);
  await settle(f.rt);
  assert.deepEqual(f.store.state.schedules[sc.id]?.recoveryTools, ['show_app']);
  f.rt.cancelSchedule(sc.id);
});
