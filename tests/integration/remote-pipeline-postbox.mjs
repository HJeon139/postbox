// The Postbox of the remote pipeline’s tests (#120, V1; tests/integration/remote-pipeline.test.mjs says what they run):
// a real Runtime and host manager over the two machines (tests/integration/remote-pipeline-machines.mjs), and the
// waits and reads the tests share.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdapterRegistry } from '../../server/adapters/adapter.mjs';
import { ClaudeCodeAdapter } from '../../server/adapters/claude-code.mjs';
import { createHostManager } from '../../server/remote/hosts.mjs';
import { Runtime } from '../../server/runtime.mjs';
import { Store } from '../../server/store.mjs';
import { TURN_FILES } from '../../shared/remote-protocol.mjs';
import { until } from './host.mjs';
import { appliedRuns, BLOCK_ID, corpus, HOST, machine, standins, VERSION } from './remote-pipeline-machines.mjs';

// ── Postbox ─────────────────────────────────────────────────────────────────────────

/** A local kill, ps and spawn that fail the test if they’re ever called: a remote turn uses none of them. */
export function forbidden() {
  const calls = [];
  const no =
    (what) =>
    (...a) => {
      calls.push([what, ...a]);
      throw new Error(`A remote turn used this computer’s ${what}.`);
    };
  return { calls, kill: no('kill'), listProcesses: async () => no('ps')(), spawnImpl: no('spawn') };
}

/**
 * A Postbox on `store`, whose host manager’s ssh is the machine’s spawn. A new store gets the host (installed there by
 * rt.installHost), a Claude Code persona placed on it that asks before acting, and a thread; a store from before (a
 * restart) has them.
 * @param {ReturnType<typeof machine>} m @param {any[]} postboxes @param {Store} [store]
 */
export async function postbox(m, postboxes, store = new Store(null)) {
  const f = forbidden();
  const claude = new ClaudeCodeAdapter({
    bin: 'claude',
    workRoot: '/tmp/pb-remote-never',
    spawnImpl: f.spawnImpl,
    kill: f.kill,
    listProcesses: f.listProcesses,
  });
  /** @type {Runtime} */
  let rt;
  const hosts = createHostManager({
    getHost: (id) => rt.s.hosts?.[id] ?? null,
    hostIds: () => Object.keys(rt.s.hosts ?? {}),
    dataDir: m.data,
    version: VERSION,
    spawn: /** @type {any} */ (m.spawn),
    delay: () => m.delay,
  });
  rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(claude),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, build: { version: VERSION } },
    hosts,
  });
  let closed = false;
  const p = {
    rt,
    store,
    hosts,
    f,
    host: /** @type {any} */ (Object.values(store.state.hosts ?? {})[0]),
    t: /** @type {any} */ (null),
    se: () => rt.sessionsIn(p.t.id)[0],
    async done() {
      if (closed) return;
      closed = true;
      await rt.stopTurns({ graceMs: 50 });
      hosts.close();
    },
  };
  postboxes.push(p);
  if (!p.host) {
    store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
    p.host = rt.addHost({ name: HOST, settings: { claudePath: m.claude, detach: 'setsid' } });
    const installed = await rt.installHost(p.host.id);
    assert.deepEqual(installed, { ok: true, installed: true, version: VERSION });
    const persona = rt.createPersona({ handle: 'coder', backend: 'claude-code', remote: { hostId: p.host.id } });
    store.emit('persona', { ...rt.persona(persona.id), permissionMode: 'ask' });
    rt.createThread({ projectId: 'p1', title: 'T', personaIds: [persona.id] });
  }
  p.t = Object.values(store.state.threads)[0];
  return p;
}

/** The session’s replies that count: not the ones a replay replaced. */
export const replies = (p) => p.store.items(p.t.id).filter((i) => i.kind === 'agent' && i.sessionId === p.se().id && i.status !== 'replaced');
export const replyText = (p) =>
  replies(p)
    .map((i) => i.text ?? '')
    .join('');
export const blocks = (p) => p.store.items(p.t.id).filter((i) => i.kind === 'block' && i.block?.id === BLOCK_ID);
export const cards = (p) => p.store.items(p.t.id).filter((i) => i.kind === 'permission');
export const settled = (p) => until(() => !p.rt.turns.size && !p.rt.exiting.size, 'the turn to end', 20_000);
/** The postbox-to-daemon messages of a type, across every session. */
export const sentOf = (m, type) => m.sessions.flatMap((s) => s.sent.filter((x) => x.type === type));

/**
 * Sends a message and waits for the stand-in it starts on the host; records its runner’s PID.
 * @returns {Promise<{ run: ReturnType<typeof standins>[number], turn: string, runner: number }>}
 */
export async function started(m, p, text) {
  const before = standins(m).length;
  p.rt.sendMessage(p.t.id, { text });
  const run = await until(() => standins(m)[before], 'the stand-in to start on the host', 30_000);
  return { run, ...(await runnerOf(m, p)) };
}

/** The current host turn and its runner’s PID, from runner.json. */
export async function runnerOf(m, p) {
  const turn = p.se().remoteTurn.turn;
  const runner = await until(() => {
    try {
      return JSON.parse(readFileSync(m.paths.turn(turn, TURN_FILES.runner), 'utf8')).pid;
    } catch {
      return null;
    }
  }, 'runner.json');
  m.pids.set(runner, 'a runner');
  return { turn, runner };
}

/** Waits for the stand-in’s event. */
export const heard = (m, pid, ev, ms = 20_000) =>
  until(
    () =>
      standins(m)
        .find((s) => s.pid === pid)
        ?.has(ev),
    `the stand-in’s ${ev}`,
    ms,
  );

/** Waits for the turn’s permission card, and allows it as the page’s Allow does. */
export async function allow(m, p, pid) {
  const card = await until(() => cards(p).find((i) => i.status === 'open' && i.remote?.turn === p.se().remoteTurn.turn), 'the permission card');
  p.rt.resolvePermission(p.t.id, card.id, 'allow');
  return (await heard(m, pid, 'decision')).decision;
}

/** A turn of scenario `gate`, allowed, and now running its Bash call until the test opens the gate. */
export async function atGate(m, p) {
  const s = await started(m, p, 'Write hello to a file. standin:gate');
  await allow(m, p, s.run.pid);
  await heard(m, s.run.pid, 'gate');
  return s;
}
export const open = (m) => writeFileSync(join(m.trace, 'go'), '');

/** The stand-in’s whole stdout is what the adapter applied in its last run: each line once, in order. */
export function appliedOnce(m, label) {
  const runs = appliedRuns(m);
  const written = standins(m).at(-1)?.out;
  assert.ok(written, 'the stand-in wrote its stream');
  assert.equal(runs.at(-1), written, `${label}: every line the stand-in wrote was applied, once, in order`);
}
