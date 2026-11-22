// A turn’s prompt recorded in UAT recording mode (server/turn-prompt.mjs, #1528) goes to prompts.jsonl in the data
// folder and nowhere a page or a host reads: not the store’s events, so not the event log, /api/stream’s live or
// backlog frames, or /api/state. A Postbox started with POSTBOX_UAT_RECORD=1 records a unique secret as a guide and a
// prompt through a turn’s ctx.prompt, and the secret is then looked for, as text, in each. On #1522 these were
// turn.guide and turn.prompt events, public, at 55% of a fixture log’s bytes; this holds that they aren’t any more.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, test } from 'node:test';
import { PROMPTS_FILE, promptHook } from '../server/turn-prompt.mjs';
import * as arrange from './arrange.mjs';
import { fakeRequest } from './fake-http.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');

const PORT = 4453;
const host = `127.0.0.1:${PORT}`;
const SECRET = `prompt-secret-${randomUUID()}`;
/** @type {any} */
let app;
let dir = '';
let seqBefore = 0;
/** Frames a page’s stream, opened before the recording, heard live. @type {string[]} */
const live = [];

/** Opens /api/stream as the page does, writing each frame into `out`. */
function openStream(/** @type {string} */ query, /** @type {string[]} */ out) {
  const req = Object.assign(Readable.from([]), { method: 'GET', url: `/api/stream?${query}`, headers: { host }, socket: { remoteAddress: '127.0.0.1' } });
  const res = { writeHead() {}, write: (/** @type {string} */ s) => out.push(String(s)) > 0, end() {}, once() {}, on() {}, destroy() {} };
  app.handle(req, res);
}

before(async () => {
  dir = tempDir('pb-prompts-kept-');
  const was = process.env.POSTBOX_UAT_RECORD;
  process.env.POSTBOX_UAT_RECORD = '1';
  try {
    app = await start({ port: PORT, dataDir: dir, fresh: true, demo: true, quiet: true, claudeHome: dir, listen: false });
  } finally {
    if (was === undefined) delete process.env.POSTBOX_UAT_RECORD;
    else process.env.POSTBOX_UAT_RECORD = was;
  }
  const thread = Object.values(app.store.state.threads)[0];
  const se = arrange.sessionsIn(app.rt, /** @type {any} */ (thread).id)[0];
  seqBefore = app.store.state.seq;
  openStream(`since=${seqBefore}`, live);
  const turn = { id: 'turn_secret', sessionId: se.id, threadId: se.threadId };
  promptHook(app.rt, turn).prompt({ guide: `Guide ${SECRET}`, text: `Prompt ${SECRET}` });
});
after(async () => {
  await app?.close();
});

test('#1528 a Postbox in recording mode writes each prompt to its data folder’s prompts.jsonl', () => {
  assert.equal(app.rt.config.promptsFile, join(dir, PROMPTS_FILE));
  const rows = readFileSync(join(dir, PROMPTS_FILE), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    rows.map((r) => [r.type, r.text]),
    [
      ['guide', `Guide ${SECRET}`],
      ['prompt', `Prompt ${SECRET}`],
    ],
  );
});

test('#1528 the recording adds no event to the store, so none reaches its log, the stream or a host', () => {
  assert.equal(app.store.state.seq, seqBefore, 'no event was emitted');
  assert.ok(!JSON.stringify(app.store.since(0)).includes(SECRET));
});

test('#1528 /api/state and the event stream’s live and backlog frames carry no recorded prompt', async () => {
  const r = await fakeRequest(app.handle, { host, path: '/api/state' });
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(SECRET), '/api/state');
  const backlog = /** @type {string[]} */ ([]);
  openStream('since=0', backlog);
  for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res));
  assert.ok(backlog.length > 0, 'the backlog was read');
  assert.ok(!backlog.join('').includes(SECRET), 'backlog frames');
  assert.ok(!live.join('').includes(SECRET), 'live frames');
});

test('#1528 a Postbox started without POSTBOX_UAT_RECORD records nothing: its turns have no ctx.prompt', async () => {
  // Unset here, whatever this test's own process was given: a UAT run sets it for its Postbox, and its agents' shells
  // inherit it (tools/uat/run-env.mjs).
  const was = process.env.POSTBOX_UAT_RECORD;
  delete process.env.POSTBOX_UAT_RECORD;
  const other = tempDir('pb-prompts-off-');
  const off = await start({ port: PORT + 1, dataDir: other, fresh: true, demo: true, quiet: true, claudeHome: other, listen: false });
  try {
    assert.equal(off.rt.config.promptsFile, null);
    assert.deepEqual(promptHook(off.rt, { id: 'turn_1', sessionId: 'se_1' }), {});
  } finally {
    await off.close();
    if (was !== undefined) process.env.POSTBOX_UAT_RECORD = was;
  }
});
