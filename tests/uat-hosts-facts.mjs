// What the host-mode tests share (tests/uat-hosts*.test.mjs): three agents on three machines, each with a turn that
// ran where it’s placed, as the runner gathers them; and a host’s processes under a turn, before and after Stop.

export const T = { r1: 'tu_r1', c1: 'tu_c1', d1: 'tu_d1' };
export const HT = { r1: '11111111-1111-4111-8111-111111111111', c1: '22222222-2222-4222-8222-222222222222' };
export const remote = (hostId, rtTurn, turn) => ({ hostId, rtTurn, turn, state: 'done' });

/** Three agents: @researcher on host1, @critic on host2, @developer here, each with a turn that ran where it’s placed. */
export function facts(over = {}) {
  const items = [
    { id: 'i1', kind: 'agent', handle: 'researcher', sessionId: 's1', turnId: T.r1, status: 'done', at: 1000 },
    { id: 'i2', kind: 'agent', handle: 'critic', sessionId: 's2', turnId: T.c1, status: 'done', at: 2000 },
    { id: 'i3', kind: 'agent', handle: 'developer', sessionId: 's3', turnId: T.d1, status: 'done', at: 3000 },
  ];
  return {
    state: {
      threads: { t1: { id: 't1', title: 'Across machines', kind: 'thread', members: ['s1', 's2', 's3'] } },
      items: { t1: items },
      sessions: {
        s1: { id: 's1', handle: 'researcher', state: 'idle', remoteTurn: remote('ho_1', T.r1, HT.r1) },
        s2: { id: 's2', handle: 'critic', state: 'idle' },
        s3: { id: 's3', handle: 'developer', state: 'idle' },
      },
      personas: {},
      work: {},
      apps: {},
    },
    threads: ['t1'],
    events: [{ seq: 5, type: 'session', data: { id: 's2', state: 'tool', remoteTurn: remote('ho_2', T.c1, HT.c1) } }],
    streams: [],
    transcripts: [],
    console: [],
    apps: {},
    probes: {},
    samples: [],
    ui: {},
    userMcpServers: [],
    hosts: {
      hosts: [
        { label: 'host1', id: 'ho_1', destination: 'a.example.com' },
        { label: 'host2', id: 'ho_2', destination: 'b.example.com' },
      ],
      placement: { researcher: 'host1', critic: 'host2', developer: 'local' },
      laptopData: '/Users/user/uat-runs/x/data',
      setup: [],
      listeners: { baseline: {}, samples: [] },
      stops: [],
      faults: [],
      before: {},
    },
    ...over,
  };
}

export const TURN = '0f8e2c1a-4b5d-4e6f-8a9b-0c1d2e3f4a5b';
// Shaped as procps’s `ps -o pid=,ppid=,pgid=,sid=,lstart=,args=` prints on a Linux host, after what
// server/adapters/process-group.mjs recorded of Claude Code 2.1.296: each Bash call runs in a session of its own, and
// SIGKILL to the CLI leaves those shells running with ppid 1. PIDs, times and paths made up, user names removed.
const RUNNER = '/home/user/.local/share/mise/installs/node/22.12.0/bin/node /home/user/.postbox-remote/0.24.0/server/remote/host/runner.mjs';
const DAEMON = '/home/user/.local/share/mise/installs/node/22.12.0/bin/node /home/user/.postbox-remote/0.24.0/host.mjs serve';
export const TREE_BEFORE = `turn ${TURN} 4100
--ps--
 4000     1  4000  4000 Sat Oct 24 05:10:01 2026 ${DAEMON}
 4100  4000  4100  4100 Sat Oct 24 05:12:30 2026 ${RUNNER} ${TURN}
 4200  4100  4200  4100 Sat Oct 24 05:12:31 2026 /home/user/tools/bin/claude -p --output-format stream-json
 4300  4200  4300  4300 Sat Oct 24 05:12:40 2026 /bin/bash -c -l source /home/user/.claude/shell-snapshots/snapshot-bash.sh && eval 'while :; do date >> heartbeat.log; sleep 5; done'
 4301  4300  4300  4300 Sat Oct 24 05:12:45 2026 sleep 5
 5000  4999  5000  5000 Sat Oct 24 04:00:00 2026 -bash`;
// After Stop killed the runner and the CLI: the tool shell lives on as PID 1’s child, its sleep is a new one, a
// command it left behind with nohup is in its session, and PID 4200 is now someone else’s.
export const TREE_AFTER = `--ps--
 4000     1  4000  4000 Sat Oct 24 05:10:01 2026 ${DAEMON}
 4200  5000  4200  5000 Sat Oct 24 05:13:20 2026 vim notes.txt
 4300     1  4300  4300 Sat Oct 24 05:12:40 2026 /bin/bash -c -l source /home/user/.claude/shell-snapshots/snapshot-bash.sh && eval 'while :; do date >> heartbeat.log; sleep 5; done'
 4302  4300  4300  4300 Sat Oct 24 05:13:25 2026 sleep 5
 4310     1  4310  4300 Sat Oct 24 05:12:42 2026 sh -c tail -f build.log
 5000  4999  5000  5000 Sat Oct 24 04:00:00 2026 -bash`;
