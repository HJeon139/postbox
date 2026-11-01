// #587: remote turns use the same missing-rollout recovery over the host transport, not a second local process.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { codexOnHost, context, forbidden, linkTo, ready, sent } from './codex-remote-fixture.mjs';
import { createFakeDaemon } from './fake-daemon.mjs';

test('a remote missing rollout starts one replacement thread on the same host turn with a fresh-start note', async (t) => {
  const recorded = readFileSync(new URL('fixtures/codex-app-server/resume-after-failure.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const error = recorded.find((m) => m.error).error;
  const id = error.message.split(' ').at(-1);
  const d = createFakeDaemon({ autoEnd: false, lines: [] });
  const link = linkTo(d);
  await ready(link);
  const host = codexOnHost(d, { resumeError: error });
  t.after(() => host.stop());
  const f = forbidden();
  const adapter = new CodexAdapter({ kill: f.kill, list: f.list, spawnImpl: () => assert.fail('remote recovery never spawns locally') });
  const { ctx, calls } = context(link, { state: { codexThreadId: id } });
  await adapter.deliver({}, { kind: 'user', text: 'Continue remotely.' }, ctx);
  const [start] = sent(d, 'start');
  assert.equal(sent(d, 'start').length, 1);
  const writes = d.turns.get(start.turn).writes.map(JSON.parse);
  assert.deepEqual(
    writes.filter((r) => r.method?.startsWith('thread/')).map((r) => r.method),
    ['thread/resume', 'thread/start'],
  );
  const turn = writes.find((r) => r.method === 'turn/start');
  assert.equal(turn.params.threadId, 'thr_postbox_1');
  assert.match(turn.params.input[0].text, /fresh start/);
  assert.match(turn.params.input[0].text, /Continue remotely\./);
  assert.equal(calls.saved.codexThreadId, 'thr_postbox_1');
  assert.equal(calls.text, 'Hello from Codex.');
  assert.deepEqual(f.calls, []);
});
