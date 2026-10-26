// The runtime’s remote turns (#120; tests/remote-turns.test.mjs says how): renaming a host while turns run there, and
// backends that run only on a host.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { createFakeDaemon, FIXTURE_PROMPT } from './fake-daemon.mjs';
import { corpus, fakeHosts, forbidden, HOST, MIN, rig, running, settled, starts, until, VERSION } from './remote-turns-helpers.mjs';

/** The rig with a second agent on the host, in a conversation of its own. @param {any} [o] */
function twoOnHost(o) {
  const r = rig(o);
  const p = r.rt.createPersona({ handle: 'helper', backend: 'claude-code', remote: { hostId: r.host.id } });
  const t2 = r.rt.createThread({ projectId: 'p1', title: 'T2', personaIds: [p.id] });
  return { r, t2 };
}

test('#120: a host isn’t renamed while turns run there, here two; once both are over it is, and the manager drops its old link', async () => {
  const { r, t2 } = twoOnHost();
  const first = await running(r);
  r.rt.sendMessage(t2.id, { text: 'hi' });
  await until(() => starts(r.d).length === 2 && r.d.turns.has(starts(r.d)[1].turn), 'the second turn');
  const second = starts(r.d)[1].turn;
  const rename = () => r.rt.updateHost(r.host.id, { name: 'renamed.example.com' });
  assert.throws(rename, (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /^host\.example\.com can’t be renamed while agents’ turns run there or wait to go on there/);
    return true;
  });
  r.d.end(first);
  await until(() => r.rt.turns.size === 1, 'the first turn’s end');
  assert.throws(rename, (e) => e.status === 409, 'one still runs there');
  // Its settings can change meanwhile: only the destination is held.
  assert.equal(r.rt.updateHost(r.host.id, { settings: { stallTimeout: 20 * MIN } }).name, HOST);
  r.d.end(second);
  await settled(r);
  assert.equal(rename().name, 'renamed.example.com');
  assert.deepEqual(r.hosts.calls.refresh, [r.host.id]);
});

test('#120: a turn that would start on a renamed host’s old link is refused, and the turn still running over it is still heard', async () => {
  const { r, t2 } = twoOnHost();
  const first = await running(r);
  // Renamed by hand with a turn running (the manager keeps the old link for it, and link() refuses anything new).
  const busy = () => {
    throw Object.assign(new Error('This host was renamed renamed.example.com, but Postbox is still using host.example.com for it.'), {
      code: 'host-renamed-busy',
    });
  };
  r.hosts.link = busy;
  r.hosts.ensureWelcome = async () => busy();
  r.store.emit('host', { ...r.store.state.hosts[r.host.id], name: 'renamed.example.com' });
  r.rt.sendMessage(t2.id, { text: 'hi' });
  await until(() => r.store.items(t2.id).some((i) => i.kind === 'agent' && i.status === 'failed'), 'the refusal');
  const failed = r.store.items(t2.id).find((i) => i.kind === 'agent' && i.status === 'failed');
  assert.match(
    failed.error,
    /^renamed\.example\.com was renamed while Postbox still had turns running on host\.example\.com, so @helper’s turn didn’t start: it would have run on the old machine\./,
  );
  assert.equal(starts(r.d).length, 1, 'nothing new started on the old machine');
  // The first turn is still heard on the old link: its tool call is answered there.
  r.d.tool(first, 'corpus_search', { query: 'whales' });
  await until(() => r.d.replies.length === 1, 'the reply');
  assert.match(r.d.replies[0].text, /about whales/);
  r.d.end(first);
  await settled(r);
});

/**
 * A runtime with Claude Code here, and Codex registered but not here (here: false), over a fake daemon with
 * these harnesses (all three by default).
 * @param {string[]} [harnesses]
 */
function codexOnHostOnly(harnesses) {
  const d = createFakeDaemon({ autoEnd: false, ...(harnesses ? { harnesses } : {}) });
  const hosts = fakeHosts(d);
  const f = forbidden();
  const own = { workRoot: '/tmp/pb-remote-never', spawnImpl: f.spawnImpl, kill: f.kill, listProcesses: f.listProcesses };
  const store = new Store(null);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry()
      .register(new ClaudeCodeAdapter({ bin: 'claude', ...own }))
      .register(new CodexAdapter({ bin: 'codex', ...own }), { here: false }),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, build: { version: VERSION } },
    hosts,
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  return { d, hosts, rt, store, f, host: rt.addHost({ name: HOST }) };
}

/**
 * Codex’s app-server on the host, answering each line on the held stdin, in the shapes of
 * tests/fixtures/codex-app-server/turn.jsonl (recorded from a local Codex turn). Each request goes in reqs; the
 * interval it returns is cleared once the turn ends.
 * @param {any} d @param {any} ft  the fake daemon’s turn @param {any[]} reqs
 */
function answerAsCodex(d, ft, reqs) {
  return setInterval(() => {
    while (reqs.length < ft.writes.length) {
      const req = JSON.parse(ft.writes[reqs.length]);
      reqs.push(req);
      if (req.method === 'initialize') d.append(ft.turn, JSON.stringify({ id: req.id, result: { userAgent: 'codex/0' } }));
      else if (req.method === 'mcpServerStatus/list') d.append(ft.turn, JSON.stringify({ id: req.id, result: { data: [], nextCursor: null } }));
      else if (req.method === 'thread/start') d.append(ft.turn, JSON.stringify({ id: req.id, result: { thread: { id: 'thr_1' } } }));
      else if (req.method === 'turn/start') {
        d.append(ft.turn, JSON.stringify({ id: req.id, result: { turn: { id: 'turn_1', status: 'inProgress', items: [] } } }));
        d.append(ft.turn, JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thr_1', itemId: 'msg_1', delta: 'Hello from Codex.' } }));
        d.append(ft.turn, JSON.stringify({ method: 'turn/completed', params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'completed' } } }));
      }
    }
  }, 2);
}

test('#120: Codex with no CLI on this computer runs on a host that has it, and is refused here', async () => {
  const { d, rt, store, f, host } = codexOnHostOnly();
  assert.throws(
    () => rt.createPersona({ handle: 'near', backend: 'codex' }),
    (e) => e.status === 422 && /^“codex” isn’t available on this computer\. Available: claude-code\. It can run on one of your hosts/.test(e.message),
  );
  const p = rt.createPersona({ handle: 'far', backend: 'codex', remote: { hostId: host.id } });
  assert.deepEqual(p.remote, { hostId: host.id });
  assert.throws(
    () => rt.updatePersona(p.id, { remote: null }),
    (e) => e.status === 422 && /“codex” isn’t available on this computer/.test(e.message),
  );
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  rt.sendMessage(t.id, { text: 'hi' });
  await until(() => starts(d).length === 1, 'the turn on the host');
  assert.equal(starts(d)[0].harness, 'codex');
  const se = rt.sessionsIn(t.id)[0];
  /** @type {any[]} */
  const reqs = [];
  const answer = answerAsCodex(d, d.turns.get(starts(d)[0].turn), reqs);
  try {
    await until(() => !rt.turns.size && !rt.exiting.size && reqs.some((r) => r.method === 'turn/start'), 'the turn’s end');
  } finally {
    clearInterval(answer);
  }
  // With no Codex here there’s no model list from its CLI. Claude’s default isn’t a model Codex runs: sent in
  // thread/start or turn/start it fails the turn, so neither names a model and Codex uses its own default.
  const params = (method) => reqs.find((r) => r.method === method)?.params;
  assert.ok(params('thread/start') && !('model' in params('thread/start')), 'thread/start names no model');
  assert.ok(params('turn/start') && !('model' in params('turn/start')), 'turn/start names no model');
  assert.ok(!reqs.some((r) => /claude-/.test(JSON.stringify(r))), 'no Claude model goes to Codex');
  const reply = store.items(t.id).find((i) => i.kind === 'agent');
  assert.equal(reply.status, 'done');
  assert.equal(reply.text, 'Hello from Codex.');
  assert.equal(rt.s.sessions[se.id].remoteTurn.state, 'done', 'its end confirmed');
  assert.equal(p.model, 'auto', 'the persona leaves the model to Codex');
  // One placed here anyway (stored before, say) is refused at its turn, and never spawned here.
  store.emit('persona', { ...rt.persona(p.id), remote: null });
  rt.sendMessage(t.id, { text: 'again' });
  await until(() => store.items(t.id).some((i) => i.kind === 'agent' && i.status === 'failed'), 'the refusal');
  assert.match(
    store.items(t.id).find((i) => i.kind === 'agent' && i.status === 'failed').error,
    /^@far’s turn didn’t start: “codex” isn’t available on this computer/,
  );
  assert.equal(starts(d).length, 1);
  assert.deepEqual(f.calls, []);
});

test('#120: a host whose welcome lacks a backend’s harness is refused for it, saying where its daemon looked; one not heard from yet isn’t', async () => {
  const { hosts, rt, host } = codexOnHostOnly(['claude-code']);
  const status = hosts.status;
  hosts.status = () => ({ state: 'reconnecting', failure: null, welcome: null, lastHeard: null });
  assert.deepEqual(rt.createPersona({ handle: 'early', backend: 'codex', remote: { hostId: host.id } }).remote, { hostId: host.id });
  hosts.status = status;
  await until(() => hosts.theLink.connected, 'the welcome');
  assert.throws(
    () => rt.createPersona({ handle: 'late', backend: 'codex', remote: { hostId: host.id } }),
    (e) =>
      e.status === 422 &&
      /^Codex isn’t installed on host\.example\.com, so this agent can’t run there\. Postbox’s daemon looked in \/home\/user\/\.local\/bin, \/usr\/local\/bin\. Install it there, or set codexPath in the host’s settings\.$/.test(
        e.message,
      ),
  );
  assert.deepEqual(
    rt.createPersona({ handle: 'claude', backend: 'claude-code', remote: { hostId: host.id } }).remote,
    { hostId: host.id },
    'it has Claude Code',
  );
});

/** A block a tool call shows, to see whether it was. */
const BLOCK = { id: 'from-elsewhere', type: 'card', version: 1, title: 'From elsewhere', fallback: 'From elsewhere', body: 'x' };

test('#120: a message about a turn from a host it doesn’t run on is ignored: no card, no tool call', async () => {
  const r = rig();
  const turn = await running(r);
  r.rt.remote.onHostMessage('ho_elsewhere', { type: 'prompt', turn, id: 'p-other', request: FIXTURE_PROMPT });
  r.rt.remote.onHostMessage('ho_elsewhere', { type: 'tool', turn, id: 't-other', name: 'show_block', args: { block: BLOCK } });
  await new Promise((ok) => setTimeout(ok, 50));
  const all = () => Object.values(r.store.state.items).flat();
  assert.ok(!all().some((i) => i.kind === 'permission'), 'no card');
  assert.ok(!all().some((i) => i.block?.id === BLOCK.id), 'no block');
  assert.equal(r.rt.permissionWaits.size, 0);
  // The host it runs on is heard as before.
  r.d.prompt(turn);
  await until(() => all().some((i) => i.kind === 'permission'), 'its own host’s card');
  const card = all().find((i) => i.kind === 'permission');
  r.rt.resolvePermission(r.t.id, card.id, 'allow');
  await until(() => r.d.answers.length === 1, 'the answer');
  r.d.end(turn);
  await settled(r);
});
