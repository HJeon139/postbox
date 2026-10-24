// What tools/check-remote-turns.mjs and tools/check-remote-stop.mjs check agents whose turns run on a host (#120)
// against: their own Postbox on a fresh data folder in the temp directory, with a fake host manager (no ssh, no host,
// no daemon: each host’s status is set here, as the real manager reports it) and a scripted Claude Code agent whose
// turns run “on” a host through the runtime’s remote path. The other states are seeded on the sessions as
// server/remote/turns.mjs keeps them. PB_PORT and PB_CHROME_PORT move it (4600 and 9800 by default). The page and
// its helpers are tools/remote-turns-page.mjs.

import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../server/index.mjs';
import { ports } from './harness.mjs';

export const { PORT, CHROME_PORT } = await ports(4600, 9800);

/** The host manager, as the runtime uses it: each host’s status is what this check sets, and its link takes anything. */
class FakeHosts extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, any>} */
    this.statuses = new Map();
    /** @type {Map<string, any>} */
    this.links = new Map();
  }
  status(id) {
    return this.statuses.get(id) ?? null;
  }
  set(id, status) {
    this.statuses.set(id, status);
    this.emit('status', id, status);
  }
  link(id) {
    if (!this.links.has(id)) {
      const link = Object.assign(new EventEmitter(), { connected: true, sent: /** @type {any[]} */ ([]) });
      link.send = (m) => {
        link.sent.push(m);
        return true;
      };
      this.links.set(id, link);
    }
    return this.links.get(id);
  }
  async ensureWelcome(id) {
    return this.statuses.get(id)?.welcome ?? { home: '/home/user', turns: [] };
  }
  async signInCheck() {
    return null;
  }
  need() {}
  release() {}
  wake() {}
  async forget() {}
  async refresh() {
    return false;
  }
  destinationOf(id) {
    return this.statuses.get(id)?.name ?? null;
  }
  async close() {}
}

const none = async () => null;
const nothing = async () => [];
export const hosts = new FakeHosts();
export const root = await mkdtemp(join(tmpdir(), 'pb-check-remote-'));
// Claude Code is on this computer (the stand-in below runs its turns); Kiro CLI and Codex only on a host.
export const app = await start({
  port: PORT,
  dataDir: join(root, 'data'),
  fresh: true,
  quiet: true,
  claudeHome: root,
  hosts: /** @type {any} */ (hosts),
  probes: { claude: async () => '2.1.300', sdk: none, kiro: none, kiroModels: nothing, agy: none, agyModels: nothing, codex: none, codexModels: nothing },
});
export const { rt, store } = app;

// The scripted Claude Code agent: its capabilities are the real adapter’s, so it can run on a host. Asked for a job,
// it starts one in the background and works until it’s stopped; otherwise it replies at once. It records each
// message it’s given, with the lines the runtime put before it.
export const delivered = [];
const caps = rt.adapters.get('claude-code').capabilities;
rt.adapters.register({
  name: 'claude-code',
  capabilities: caps,
  async folderFor() {
    return root;
  },
  async deliver(_session, message, ctx) {
    delivered.push({ text: message.text ?? '', context: message.context ?? [], remote: !!ctx.remote });
    if (!/job/.test(message.text ?? '')) return ctx.text('Carrying on where I left off.');
    ctx.text('Starting the test run in the background.');
    ctx.activity({ id: 'tu_job', label: 'Run the whole test suite', state: 'running', job: 'bgjob1' });
    ctx.job({ id: 'bgjob1', toolUseId: 'tu_job', label: 'Run the whole test suite', command: 'npm test', outputFile: '/tmp/out.txt', state: 'running' });
    await new Promise((r) => ctx.signal.addEventListener('abort', r));
    ctx.job({ id: 'bgjob1', state: 'stopped' });
  },
});

// ── Seeded state ───────────────────────────────────────────────────────────────────────

const now = Date.now();
const MIN = 60_000;
store.emit('project', { id: 'pr_remote', name: 'Remote', folder: root });
export const A = rt.addHost({ name: 'host.example.com' });
export const B = rt.addHost({ name: 'build.example.com' });
export const C = rt.addHost({ name: 'gpu.example.com' });
// The welcome as the daemon sends it (shared/remote-protocol.mjs), trimmed: Claude Code and Kiro CLI found, Codex not.
const welcome = {
  version: '0.10.0',
  home: '/home/user',
  node: { version: '22.12.0', path: '/usr/bin/node' },
  harnesses: [
    { name: 'claude-code', path: '/usr/bin/claude', version: '2.1.300' },
    { name: 'kiro-cli', path: '/home/user/.local/bin/kiro-cli' },
    { name: 'codex', path: null, looked: ['/home/user/.local/bin', '/usr/local/bin'] },
  ],
  problems: [],
  turns: [],
};
hosts.set(A.id, { state: 'connected', failure: null, welcome, lastHeard: now - 2 * MIN, name: A.name });
hosts.set(B.id, { state: 'disconnected', failure: null, welcome: null, lastHeard: now - 40 * MIN, name: B.name });
hosts.set(C.id, { state: 'reconnecting', failure: null, welcome: null, lastHeard: now - 5 * MIN, name: C.name });

const on = (hostId) => ({ remote: { hostId } });
const persona = (handle, hostId, backend = 'claude-code') => rt.createPersona({ handle, backend, ...(hostId ? on(hostId) : {}) });
export const coder = persona('coder', A.id); // Sign-in needed
const fixer = persona('fixer', A.id); // Interrupted
const watcher = persona('watcher', A.id); // hung
const stopper = persona('stopper', A.id); // stopping, unconfirmed
const builder = persona('builder', B.id); // lost: Disconnected (working)
const idler = persona('idler', B.id); // Disconnected (idle)
const tester = persona('tester', C.id); // Reconnecting
const scout = persona('scout', A.id, 'kiro-cli'); // a Kiro turn’s notice, and a replayed reply
export const cx = persona('cx', B.id, 'codex'); // Codex’s default; Runs on only a host
// A Codex persona from before `auto`: its Claude model is ignored by Codex, and reads as Codex’s default.
store.emit('persona', { ...rt.persona(cx.id), model: 'claude-opus-5-5' });
const local = persona('local', null);
export const room = rt.createThread({
  projectId: 'pr_remote',
  title: 'Remote turns',
  personaIds: [coder, fixer, watcher, stopper, builder, idler, tester, scout, cx].map((p) => p.id),
});
export const dm = rt.createThread({ projectId: 'pr_remote', title: 'Runner', personaIds: [persona('runner', A.id).id] });
export const solo = rt.createThread({ projectId: 'pr_remote', title: 'Local', personaIds: [local.id] });
export const ses = Object.fromEntries(rt.sessionsIn(room.id).map((se) => [se.handle, se]));
export const [runner] = rt.sessionsIn(dm.id);
const remoteTurn = (se, hostId, rtTurn, patch) =>
  rt.updateSession(se.id, {
    remoteTurn: {
      hostId,
      turn: `ht_${rtTurn}`,
      offset: 0,
      rtTurn,
      threadId: room.id,
      folder: '/home/user/postbox-work',
      at: now,
      replies: [],
      stopping: [],
      ...patch,
    },
  });
const reply = (se, turnId, patch) =>
  rt.addItem(room.id, { kind: 'agent', sessionId: se.id, personaId: se.personaId, handle: se.handle, turnId, text: '', status: 'done', ...patch });

remoteTurn(ses.coder, A.id, 'tu_signin', { state: 'signin', resume: { why: 'signin', at: now }, autoResumes: 0 });
reply(ses.coder, 'tu_signin', {
  status: 'failed',
  error: 'Sign-in needed on host.example.com. Sign in there, then resume @coder.',
  remote: { state: 'signin', hostId: A.id },
});
// Interrupted three times in a row: Postbox stopped resuming it on its own, so it waits for the person.
remoteTurn(ses.fixer, A.id, 'tu_int', { state: 'interrupted', resume: { why: 'interrupted', at: now }, autoResumes: 3 });
reply(ses.fixer, 'tu_int', {
  status: 'failed',
  error: 'Interrupted on host.example.com: the agent’s process there ended without finishing its turn.',
  remote: { state: 'interrupted', hostId: A.id },
});
export const HUNG = 'Stopped: no output for 15 min (the last at 14:02)';
remoteTurn(ses.watcher, A.id, 'tu_hung', { state: 'hung', message: HUNG });
reply(ses.watcher, 'tu_hung', { text: 'Waiting on the build…', status: 'stopped', stoppedAt: now, note: HUNG });
remoteTurn(ses.stopper, A.id, 'tu_stop', { state: 'stopping', stopping: [{ turn: 'ht_tu_stop', hostId: A.id, at: now }] });
remoteTurn(ses.builder, B.id, 'tu_lost', { state: 'lost' });
reply(ses.builder, 'tu_lost', { status: 'failed', error: 'The connection to build.example.com gave up.' });
// Replayed from the start after a restart: the first part is replaced, the replay is the whole reply.
remoteTurn(ses.scout, A.id, 'tu_kiro', { state: 'done' });
reply(ses.scout, 'tu_kiro', { text: '', status: 'replaced' });
reply(ses.scout, 'tu_kiro', {
  text: 'I read the README and the tests.',
  activity: {
    steps: [
      {
        id: 'kiro-remote-argv',
        label: 'Other users on the host can read this message',
        state: 'done',
        detail:
          'Kiro CLI takes its message as a command-line argument, and other users on a Linux host can read a process’s arguments in /proc unless it’s mounted with hidepid. Don’t send a Kiro agent on a shared host anything they shouldn’t see.',
      },
      { id: 'st1', label: 'read README.md', state: 'done', ms: 40 },
    ],
  },
});
const card = (status, extra) =>
  rt.addItem(room.id, {
    kind: 'permission',
    sessionId: ses.coder.id,
    handle: 'coder',
    tool: 'Bash',
    summary: 'run npm test',
    detail: 'npm test',
    status,
    answeredAt: now,
    endedAt: now,
    remote: { hostId: A.id, turn: 'ht_tu_signin', prompt: `p_${status}` },
    ...extra,
  });
card('expired', { noAnswer: true });
card('canceled');
card('ended');
rt.addItem(room.id, {
  kind: 'command',
  command: 'git status',
  cwd: root,
  notOn: 'host.example.com',
  status: 'done',
  text: '! commands run on this computer, not on host.example.com.\nOn branch main\n',
  exitCode: 0,
  ms: 120,
  cut: false,
});
