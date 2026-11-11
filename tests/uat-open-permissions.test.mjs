import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitingOnYou } from '../tools/uat/checks.mjs';

// The state at the end of sf-evalgen-wf1's 08:13 run (11/11), from its events-1.jsonl: @builder's Bash permission
// it_IjvCH1jp added at seq 1377 and never answered, a later one allowed at 1396, and the session at "tool" with no
// `needs` from seq 1397 to the end.
const wf1 = () => ({
  threads: { t1: { id: 't1', title: 'T', kind: 'thread', members: ['s1'] } },
  sessions: { s1: { id: 's1', handle: 'builder', state: 'tool' } },
  items: {
    t1: [
      {
        id: 'pa',
        kind: 'permission',
        sessionId: 's1',
        handle: 'builder',
        tool: 'Bash',
        status: 'allowed',
        summary: 'run a command: Count candidates in each file',
      },
      {
        id: 'po',
        kind: 'permission',
        sessionId: 's1',
        handle: 'builder',
        tool: 'Bash',
        status: 'open',
        summary: 'run a command: Write admin grant policy and setup notes',
      },
    ],
  },
});

test('an open permission waits on the person even while its session works and has no needs', () => {
  assert.deepEqual(
    waitingOnYou(wf1(), ['t1']).map((w) => [w.itemId, w.threadId, w.what]),
    [['po', 't1', '@builder asks to run a command: Write admin grant policy and setup notes']],
  );
});

test('a session’s needs text still names a permission it points at, once', () => {
  const state = wf1();
  state.sessions.s1 = { ...state.sessions.s1, state: 'needs', needs: { itemId: 'po', kind: 'permission', text: '@builder asks to run bash' } };
  assert.deepEqual(
    waitingOnYou(state, ['t1']).map((w) => [w.itemId, w.what]),
    [['po', '@builder asks to run bash']],
  );
});

test('an answered permission, or one in another thread, does not wait', () => {
  const state = wf1();
  state.items.t1[1].status = 'denied';
  state.items.t2 = [{ id: 'px', kind: 'permission', handle: 'critic', status: 'open', summary: 'run a command: x' }];
  assert.deepEqual(waitingOnYou(state, ['t1']), []);
});
