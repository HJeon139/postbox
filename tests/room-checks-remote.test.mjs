import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChecks } from '../server/room-checks.mjs';

// The live checks (server/room-checks.mjs) over a turn that ran on a host (#120): Postbox never reads a file there,
// so the ledger records a host's edit as an edit step (server/ledger-remote.mjs, kind 'edit'), not as a file.

const facts = (work) => ({
  state: {
    threads: { t1: { id: 't1', title: 'T', kind: 'thread', members: ['s1'] } },
    items: { t1: [] },
    sessions: { s1: { id: 's1', handle: 'coder', state: 'idle' } },
    apps: {},
    glossary: {},
    work: { t1: work },
  },
  threads: ['t1'],
  streams: [
    {
      handle: 'coder',
      started: 1,
      events: [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'e1', name: 'Write', input: { file_path: '/home/user/w/a.py' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'e1', is_error: false, content: 'ok' }] } },
      ],
    },
  ],
});
const flagged = (f) => runChecks(f, { only: ['work-files-match-stream'] }).map((x) => x.id ?? x.check);

test('#120 work-files-match-stream: a file an agent changed on a host, in Work as an edit step there, isn’t reported missing', () => {
  assert.deepEqual(flagged(facts([{ kind: 'edit', path: '/home/user/w/a.py', tools: 1 }])), []);
  assert.equal(flagged(facts([])).length, 1, 'a change in no Work entry at all is still reported');
});
