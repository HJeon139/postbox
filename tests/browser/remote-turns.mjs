// The seeded room the remote-turns and remote-stop specs drive (#120): a Postbox with the fake host manager of
// tests/browser/remote-hosts.mjs, three hosts (connected, disconnected, reconnecting), and a scripted Claude Code
// agent whose turns run “on” a host through the runtime’s remote path. The other turn states are seeded on the
// sessions as server/remote/turns.mjs keeps them, with the replies and cards they leave. Moved from
// tools/remote-turns-kit.mjs (#303).

import { startRemote } from './remote-hosts.mjs';

const MIN = 60_000;
export const HUNG = 'Stopped: no output for 15 min (the last at 14:02)';

// The welcome as the daemon sends it (shared/remote-protocol.mjs), trimmed: Claude Code and Kiro CLI found, Codex not.
const WELCOME = {
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

/**
 * The scripted Claude Code agent: its capabilities are the real adapter’s, so it can run on a host. Asked for a job,
 * it starts one in the background and works until it’s stopped; otherwise it replies at once. It records each
 * message it’s given in delivered, with the lines the runtime put before it.
 */
function scripted(app, delivered) {
  const { rt } = app;
  rt.adapters.register({
    name: 'claude-code',
    capabilities: rt.adapters.get('claude-code').capabilities,
    async folderFor() {
      return app.root;
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
}

/** The hosts, each with its status, the personas on them, and the three conversations. */
function places(app, hosts, now) {
  const { rt, store } = app;
  store.emit('project', { id: 'pr_remote', name: 'Remote', folder: app.root });
  const A = rt.addHost({ name: 'host.example.com' });
  const B = rt.addHost({ name: 'build.example.com' });
  const C = rt.addHost({ name: 'gpu.example.com' });
  hosts.set(A.id, { state: 'connected', failure: null, welcome: WELCOME, lastHeard: now - 2 * MIN, name: A.name });
  hosts.set(B.id, { state: 'disconnected', failure: null, welcome: null, lastHeard: now - 40 * MIN, name: B.name });
  hosts.set(C.id, { state: 'reconnecting', failure: null, welcome: null, lastHeard: now - 5 * MIN, name: C.name });
  const persona = (handle, hostId, backend = 'claude-code') => rt.createPersona({ handle, backend, ...(hostId ? { remote: { hostId } } : {}) });
  // coder: Sign-in needed; fixer: Interrupted; watcher: hung; stopper: stopping, unconfirmed; builder: lost,
  // Disconnected (working); idler: Disconnected (idle); tester: Reconnecting; scout: a Kiro turn’s notice and a
  // replayed reply; cx: Codex’s default, which runs only on a host.
  const room = [
    ['coder', A],
    ['fixer', A],
    ['watcher', A],
    ['stopper', A],
    ['builder', B],
    ['idler', B],
    ['tester', C],
    ['scout', A, 'kiro-cli'],
    ['cx', B, 'codex'],
  ].map(([handle, host, backend]) => persona(handle, host.id, backend));
  const cx = room.at(-1);
  // A Codex persona from before `auto`: its Claude model is ignored by Codex, and reads as Codex’s default.
  store.emit('persona', { ...rt.persona(cx.id), model: 'claude-opus-5-5' });
  return {
    A,
    B,
    C,
    coder: room[0],
    cx,
    room: rt.createThread({ projectId: 'pr_remote', title: 'Remote turns', personaIds: room.map((p) => p.id) }),
    dm: rt.createThread({ projectId: 'pr_remote', title: 'Runner', personaIds: [persona('runner', A.id).id] }),
    solo: rt.createThread({ projectId: 'pr_remote', title: 'Local', personaIds: [persona('local', null).id] }),
  };
}

/** Each turn’s state on its session, and the reply it left. Returns the replies, by what they show. */
function turnStates(app, { A, B, room }, ses, now) {
  const { rt } = app;
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
  const signin = reply(ses.coder, 'tu_signin', {
    status: 'failed',
    error: 'Sign-in needed on host.example.com. Sign in there, then resume @coder.',
    remote: { state: 'signin', hostId: A.id },
  });
  // Interrupted three times in a row: Postbox stopped resuming it on its own, so it waits for the person.
  remoteTurn(ses.fixer, A.id, 'tu_int', { state: 'interrupted', resume: { why: 'interrupted', at: now }, autoResumes: 3 });
  const interrupted = reply(ses.fixer, 'tu_int', {
    status: 'failed',
    error: 'Interrupted on host.example.com: the agent’s process there ended without finishing its turn.',
    remote: { state: 'interrupted', hostId: A.id },
  });
  remoteTurn(ses.watcher, A.id, 'tu_hung', { state: 'hung', message: HUNG });
  const hung = reply(ses.watcher, 'tu_hung', { text: 'Waiting on the build…', status: 'stopped', stoppedAt: now, note: HUNG });
  remoteTurn(ses.stopper, A.id, 'tu_stop', { state: 'stopping', stopping: [{ turn: 'ht_tu_stop', hostId: A.id, at: now }] });
  remoteTurn(ses.builder, B.id, 'tu_lost', { state: 'lost' });
  const lost = reply(ses.builder, 'tu_lost', { status: 'failed', error: 'The connection to build.example.com gave up.' });
  // Replayed from the start after a restart: the first part is replaced, the replay is the whole reply.
  remoteTurn(ses.scout, A.id, 'tu_kiro', { state: 'done' });
  const replaced = reply(ses.scout, 'tu_kiro', { text: '', status: 'replaced' });
  const replay = reply(ses.scout, 'tu_kiro', {
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
  return { signin, interrupted, hung, lost, replaced, replay };
}

/**
 * Permission cards a host ended, each a way it can end, and a `!` command run here while the agent works there.
 * Returns the command.
 */
function cards(app, { A, room }, ses, now) {
  const { rt } = app;
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
  const command = rt.addItem(room.id, {
    kind: 'command',
    command: 'git status',
    cwd: app.root,
    notOn: 'host.example.com',
    status: 'done',
    text: '! commands run on this computer, not on host.example.com.\nOn branch main\n',
    exitCode: 0,
    ms: 120,
    cut: false,
  });
  return { command };
}

/**
 * Starts a Postbox with the seeded room, for one spec file. Returns it, the fake hosts, what the scripted agent was
 * delivered, the hosts and conversations, the room’s sessions by handle, @runner’s session in its DM, and the items.
 * @param {string} name  a short name for its temp folder
 */
export async function startRemoteTurns(name) {
  const { app, hosts } = await startRemote(name);
  /** @type {{ text: string, context: string[], remote: boolean }[]} */
  const delivered = [];
  scripted(app, delivered);
  const now = Date.now();
  const at = places(app, hosts, now);
  const ses = Object.fromEntries(app.rt.sessionsIn(at.room.id).map((se) => [se.handle, se]));
  const [runner] = app.rt.sessionsIn(at.dm.id);
  const items = { ...turnStates(app, at, ses, now), ...cards(app, at, ses, now) };
  return { app, hosts, delivered, ...at, ses, runner, items };
}
