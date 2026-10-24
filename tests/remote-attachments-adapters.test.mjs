// A message’s attachments on a remote turn (#120), for each adapter that runs on a host: the agent there can’t read a
// path on this computer, so its message names the copy in the host turn’s folder, and the turn’s start carries the
// bytes (ctx.remote.attachments, as the runtime fills it in: server/remote/attachments.mjs). A second host turn in the
// same deliver carries them again and names its own folder. Each runs against tests/fake-daemon.mjs, through the
// fixtures of the adapter’s own remote tests.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ClaudeCodeAdapter } from '../server/adapters/claude-code.mjs';
import { CodexAdapter } from '../server/adapters/codex.mjs';
import { hostPaths, MESSAGE_FILE } from '../shared/remote-protocol.mjs';
import { forbidden, HOME, remoteCtx, starts, until } from './claude-code-remote-fixture.mjs';
import { forbidden as codexForbidden, codexOnHost, context, linkTo, ready, sent } from './codex-remote-fixture.mjs';
import { createFakeDaemon, fixtureLines } from './fake-daemon.mjs';
import { setup as kiroSetup, play, startOf } from './kiro-cli-remote-fixture.mjs';

/** A few bytes no text decoding keeps: NUL, 0xFF, a newline, 0xFE. */
const BYTES = Buffer.from([0x00, 0xff, 0x41, 0x0a, 0x00, 0xfe]);
/** Where the attachment is on this computer: a path that must never reach the host. */
const LAPTOP = '/Users/someone/postbox-data/blobs/ab/cdef';

/** An attachment, and what the runtime carries of it to the host. */
function attached() {
  const a = { kind: 'file', fileId: 'fi_1', name: 'chart (1).png', type: 'image/png' };
  return { a, attachments: [{ of: a, name: '1-chart_1_.png', base64: BYTES.toString('base64') }] };
}

/** The attachment’s copy in host turn `turn`’s folder, as the version the fixtures install (0.10.0) names it. */
const hostCopy = (turn) => hostPaths(HOME, '0.10.0').turn(turn, 'attachments/1-chart_1_.png');

/** The start carries the bytes, byte for byte, and nothing names the laptop’s path. */
function carries(start) {
  assert.deepEqual(start.attachments, [{ name: '1-chart_1_.png', base64: BYTES.toString('base64') }]);
  assert.deepEqual(Buffer.from(start.attachments[0].base64, 'base64'), BYTES);
  assert.ok(!JSON.stringify(start).includes(LAPTOP), 'the laptop’s path never goes to the host');
}

test('#120: a remote Claude Code turn’s message names the attachment’s copy in the host turn’s folder, and its start carries the bytes', async () => {
  const d = createFakeDaemon({ lines: fixtureLines('block') });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', ...forbidden() });
  const { a, attachments } = attached();
  const ctx = remoteCtx(d, { remote: { attachments } });
  ctx.pathOf = () => LAPTOP;
  await adapter.deliver({}, { kind: 'user', text: 'Look at this.', attachments: [a] }, ctx);
  const [start] = starts(d);
  carries(start);
  const text = start.files.find((f) => f.name === MESSAGE_FILE).text;
  assert.ok(text.includes(`chart (1).png (image/png): ${hostCopy(start.turn)}`), text);
});

test('#120: a second Claude Code host turn in the same deliver carries the attachment again, and names its own folder', async () => {
  const d = createFakeDaemon({ lines: [], autoEnd: false });
  const adapter = new ClaudeCodeAdapter({ bin: 'claude', workRoot: '/tmp/pb-test-work', ...forbidden() });
  const { a, attachments } = attached();
  const ctx = remoteCtx(d, { state: { claudeSessionId: '00000000-0000-4000-8000-0000000000aa' }, remote: { attachments } });
  ctx.pathOf = () => LAPTOP;
  const done = adapter.deliver({}, { kind: 'user', text: 'Again', attachments: [a] }, ctx);
  await until(() => starts(d).length === 1 && d.turns.has(starts(d)[0].turn), 'the first start');
  const first = starts(d)[0];
  for (const l of fixtureLines('resume-missing')) d.append(first.turn, l);
  d.end(first.turn, { code: 1, signal: null });
  await until(() => starts(d).length === 2 && d.turns.has(starts(d)[1].turn), 'the fresh start');
  const second = starts(d)[1];
  for (const l of fixtureLines('block')) d.append(second.turn, l);
  d.end(second.turn);
  await done;
  assert.notEqual(first.turn, second.turn);
  for (const s of [first, second]) {
    carries(s);
    const text = s.files.find((f) => f.name === MESSAGE_FILE).text;
    assert.ok(text.includes(hostCopy(s.turn)), `${s.turn}: ${text}`);
  }
});

test('#120: a remote Kiro CLI turn’s message names the host copy, and each host turn, the fresh start too, carries the bytes', async () => {
  const { a, attachments } = attached();
  const { d, adapter, ctx } = await kiroSetup({ state: { kiroSessionId: 'sess_gone' }, remote: { attachments } });
  ctx.pathOf = () => LAPTOP;
  const done = adapter.deliver({}, { kind: 'user', text: 'Look at this.', attachments: [a] }, ctx);
  const first = await startOf(d, 0);
  play(d, first, 'missing-session', 1);
  const second = await startOf(d, 1);
  play(d, second, 'first');
  await done;
  assert.notEqual(first.turn, second.turn);
  for (const s of [first, second]) {
    carries(s);
    assert.ok(s.argv.at(-1).includes(`chart (1).png (image/png): ${hostCopy(s.turn)}`), s.argv.at(-1));
  }
});

test('#120: a remote Codex turn’s input names the attachment’s copy on the host, and its start carries the bytes', async () => {
  const d = createFakeDaemon({ autoEnd: false, lines: [] });
  const link = linkTo(d);
  await ready(link);
  const host = codexOnHost(d);
  const f = codexForbidden();
  const adapter = new CodexAdapter({ kill: f.kill, list: f.list, spawnImpl: () => assert.fail('a remote turn never spawns locally') });
  const { a, attachments } = attached();
  const { ctx } = context(link, { remote: { attachments } });
  ctx.pathOf = () => LAPTOP;
  await adapter.deliver({}, { kind: 'user', text: 'Look at this.', attachments: [a] }, ctx);
  host.stop();
  const [start] = sent(d, 'start');
  carries(start);
  const turnStart = d.turns
    .get(start.turn)
    .writes.map((l) => JSON.parse(l))
    .find((m) => m.method === 'turn/start');
  const text = turnStart.params.input[0].text;
  assert.ok(text.includes(`chart (1).png (image/png): ${hostCopy(start.turn)}`), text);
  assert.ok(!text.includes(LAPTOP));
});
