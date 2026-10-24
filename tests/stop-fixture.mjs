// What the Stop tests share (#126, #129, #164): a fake kill, and a runtime with an adapter scripted per turn whose turn
// runs until it’s stopped. Moved from tests/stop.test.mjs.

import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

/** Groups whose fake CLI has exited (fakeChild’s exit), as kill(-pid, 0) sees them. */
export const exitedGroups = new Set();

/** A fake kill: records each signal, and says a group is gone once its fake CLI has exited (or when `gone` says so). */
export function fakeKill(gone = new Set()) {
  const sent = [];
  const kill = (pid, sig) => {
    if (sig === 0) {
      if (gone.has(pid) || exitedGroups.has(pid)) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      return true;
    }
    sent.push([pid, sig]);
    return true;
  };
  return { kill, sent, gone };
}

/** An adapter scripted per turn, as in tests/runtime.test.mjs. */
class Scripted {
  name = 'mock';
  calls = [];
  next = [];
  async folderFor() {
    return null;
  }
  async deliver(_session, message, ctx) {
    this.calls.push({ message, ctx });
    const step = this.next.shift() ?? (async (c) => c.text('ok'));
    await step(ctx, message);
  }
}

export function setup() {
  const store = new Store(null);
  const adapter = new Scripted();
  const k = fakeKill();
  /** @type {import('../server/adapters/process-group.mjs').Proc[]} what a fake ps lists: the kept jobs’ shells */
  const procs = [];
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
    signalProcess: k.kill,
    listProcesses: async () => procs,
  });
  store.emit('project', { id: 'p1', name: 'P', folder: '/tmp' });
  const p = rt.createPersona({ handle: 'developer' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  return { store, rt, adapter, t, se: rt.sessionsIn(t.id)[0], k, procs };
}
/** A kept job’s shell as ps shows it, leading its own group. */
export const shellRow = (pgid, command) => ({ pid: pgid, ppid: 1, pgid, command: `/bin/zsh -c source snapshot.sh && eval '${command}' < /dev/null` });

/**
 * A turn that runs until it’s aborted, then “exits” only when the test says so, like a CLI that takes a while to stop.
 * kept: what the adapter reports for a job Stop kept running, or null when it found none to keep.
 */
export function slowToExit({ job = null, kept = /** @type {object|null} */ ({ pgid: 4242 }) } = {}) {
  let exit = () => {};
  const exited = new Promise((r) => {
    exit = r;
  });
  const step = async (c) => {
    c.text('working');
    if (job) {
      c.activity({ id: 'tu_1', label: 'Run the UAT', state: 'running', job: job.id });
      c.job({ id: job.id, toolUseId: 'tu_1', label: 'Run the UAT', command: job.command, outputFile: '/tmp/out.txt', state: 'running' });
    }
    await new Promise((r) => c.signal.addEventListener('abort', r));
    step.reason = c.signal.reason;
    if (job && kept && c.signal.reason?.keepJobs?.length) c.job({ id: job.id, kept: true, ...kept });
    await exited;
  };
  step.exit = exit;
  return step;
}
