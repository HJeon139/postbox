// The UAT runner’s follower of Postbox’s event stream (tools/uat/history.mjs, followEvents) on the Redis store, where
// the stream and /api/state are all it has to read (#553’s review, blocker 4): it keeps the messages each agent
// received as the sessions’ events carry them, applying session.patch with the reducer’s rule, and after a resync reads
// the sessions whole from the state and resumes from its seq.

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { followEvents } from '../tools/uat/history.mjs';

const frame = (seq, type, data) => `${seq === null ? '' : `id: ${seq}\n`}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const msg = (other, text, at) => ({ dir: 'from', other, text, at });

/**
 * A Postbox that streams the given frames (resync among them, as the server sends it when its stream no longer holds
 * the events asked for, and then goes on live) and answers /api/state with `state`.
 */
async function fakePostbox(frames, state) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ seq: state.seq, state }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`retry: 1500\n\nevent: store\ndata: {"state":"running"}\n\n${frames.join('')}`);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(null)));
  const { port } = /** @type {any} */ (server.address());
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((ok) => server.close(ok)) };
}

const until = async (pred, what) => {
  for (let i = 0; i < 200 && !pred(); i++) await new Promise((ok) => setTimeout(ok, 25));
  assert.ok(pred(), `timed out waiting for ${what}`);
};

test('followEvents keeps what each agent received from session and session.patch events, and from the state after a resync', async (t) => {
  const state = {
    seq: 90,
    sessions: {
      se_c: { id: 'se_c', handle: 'critic', state: 'idle', agentMessages: [msg('developer', 'from the state', 40)] },
      se_g: { id: 'se_g', handle: 'ghost', state: 'idle', agentMessages: [msg('critic', 'a session the stream never showed', 50)] },
    },
  };
  const pb = await fakePostbox(
    [
      frame(10, 'session', { id: 'se_c', handle: 'critic', state: 'idle' }),
      frame(11, 'session.patch', { id: 'se_c', patch: { agentMessages: [msg('researcher', '@critic Ready for your task.', 1)] } }),
      // The six-cap dropped the first message from the session; the follower keeps it.
      frame(12, 'session.patch', { id: 'se_c', patch: { agentMessages: [msg('developer', 'the seventh', 2)] } }),
      frame(13, 'session.patch', { id: 'se_x', patch: { agentMessages: [msg('critic', 'to a session never shown whole', 3)] } }),
      frame(null, 'resync', {}),
      // Live after the resync: one at or below the state’s seq was in the state already; a later one is new.
      frame(85, 'session', { id: 'se_c', handle: 'critic', state: 'think', agentMessages: [msg('developer', 'from the state', 40)] }),
      frame(91, 'session.patch', { id: 'se_g', patch: { agentMessages: [msg('critic', 'after the resync', 60)] } }),
    ],
    state,
  );
  const h = followEvents(pb.origin);
  t.after(async () => {
    h.close();
    await pb.close();
  });
  await until(() => h.received().length === 5, 'the messages from the stream and the state');
  assert.deepEqual(
    h.received().map((r) => [r.handle, r.from, r.text]),
    [
      ['critic', 'researcher', '@critic Ready for your task.'],
      ['critic', 'developer', 'the seventh'],
      ['critic', 'developer', 'from the state'],
      ['ghost', 'critic', 'a session the stream never showed'],
      ['ghost', 'critic', 'after the resync'],
    ],
    'a patch for a session the stream never showed whole is dropped, as the reducer drops it; the state shows it whole',
  );
  assert.deepEqual(
    h.events().map((e) => `${e.seq} ${e.type} ${e.data.id}`),
    ['10 session se_c', '11 session se_c', '12 session se_c', '91 session se_g'],
    'after the resync the history resumes from the state’s seq: 85 was in the state already',
  );
});
