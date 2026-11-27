// #1864: each local Kiro turn writes a custom agent, agents/postbox-<handle>-<8 hex>.json, with Postbox’s MCP URL and
// guide, into its Kiro home, and removed it only in a finally. A Postbox killed mid-turn left it: with your own Kiro
// setup, a dead agent in your kiro-cli agent list, a new one each turn. Each turn now notes its file beside Postbox’s
// work root, and as Postbox starts every file still noted is removed, but only Postbox’s own agent files.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { removeKiroAgent, sweepKiroAgents, writeKiroAgent } from '../server/adapters/kiro-agent-files.mjs';
import { KiroCliAdapter } from '../server/adapters/kiro-cli.mjs';
import { fakeCtx, fakeSpawn, fixture } from './kiro-cli-fakes.mjs';
import { tempDir } from './temp-dirs.mjs';

/** A data folder’s work root, and a Kiro home beside it with an agent of the person’s own. */
function place() {
  const data = tempDir('pb-kiro-data-');
  const home = join(data, 'home');
  mkdirSync(join(home, 'agents'), { recursive: true });
  writeFileSync(join(home, 'agents', 'mine.json'), '{"name":"mine"}\n');
  return { data, workRoot: join(data, 'work'), home, file: join(home, 'agents', 'postbox-kiro-1a2b3c4d.json') };
}
/** The files the record notes. @param {string} data */
const record = (data) => JSON.parse(readFileSync(join(data, 'kiro-agents.json'), 'utf8')).map((/** @type {any} */ n) => n.file);
const sha = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex');

test('#1864 an agent file a killed turn left is removed as Postbox starts, and the person’s own agent stays', async () => {
  const p = place();
  await writeKiroAgent(p.file, '{"name":"postbox-kiro-1a2b3c4d"}', p.workRoot);
  assert.ok(existsSync(p.file));
  // The turn’s finally never ran. The next Postbox starts.
  await sweepKiroAgents(p.workRoot);
  assert.deepEqual(readdirSync(join(p.home, 'agents')), ['mine.json']);
  assert.deepEqual(record(p.data), []);
});

test('#1864 a record naming any other file removes nothing', async () => {
  const p = place();
  const elsewhere = join(p.data, 'postbox-kiro-1a2b3c4d.json');
  writeFileSync(elsewhere, 'not in an agents folder\n');
  writeFileSync(
    join(p.data, 'kiro-agents.json'),
    // Each with the hash of the text it holds, so only the path’s own check stands in the way.
    `${JSON.stringify([
      { file: join(p.home, 'agents', 'mine.json'), sha256: sha('{"name":"mine"}\n') },
      { file: elsewhere, sha256: sha('not in an agents folder\n') },
    ])}\n`,
  );
  await sweepKiroAgents(p.workRoot);
  assert.ok(existsSync(join(p.home, 'agents', 'mine.json')), 'the person’s agent');
  assert.ok(existsSync(elsewhere), 'a file of that name outside an agents folder');
});

test('#1864 Postbox’s start sweeps the agent files its data folder notes', async () => {
  const { AdapterRegistry } = await import('../server/adapters/adapter.mjs');
  const { registerBackends } = await import('../server/backends.mjs');
  const p = place();
  const workRoot = join(p.data, 'workspaces');
  await writeKiroAgent(p.file, '{}', workRoot);
  const none = async () => null;
  await registerBackends(new AdapterRegistry(), { dataDir: p.data, demo: false, probes: { claude: none, kiro: none, agy: none, codex: none } });
  assert.equal(existsSync(p.file), false);
});

test('#1864 a turn notes its agent file while kiro-cli runs, and drops the note once it’s removed', async () => {
  const p = place();
  const seen = [];
  const plain = fakeSpawn([{ lines: fixture('first'), code: 0 }], seen);
  /** @type {unknown} */
  let during = null;
  const spawnImpl = (/** @type {any[]} */ ...a) => {
    during = record(p.data);
    return plain(...a);
  };
  const adapter = new KiroCliAdapter({ workRoot: p.workRoot, isolatedHome: p.home, spawnImpl: /** @type {any} */ (spawnImpl), env: {} });
  await adapter.deliver({}, { kind: 'user', text: 'Remember heron.' }, fakeCtx());
  assert.equal(Array.isArray(during) && during.length, 1, 'noted while kiro-cli runs');
  assert.match(String(/** @type {string[]} */ (during)[0]), /agents[\\/]postbox-kiro-[0-9a-f]{8}\.json$/);
  assert.deepEqual(readdirSync(join(p.home, 'agents')), ['mine.json'], 'removed as the turn ends');
  assert.deepEqual(record(p.data), [], 'and its note dropped');
});

const ROOT = process.getuid?.() === 0;
test('#1864 an agent file the turn couldn’t remove stays noted for the next start', {
  skip: (process.platform === 'win32' || ROOT) && 'POSIX modes, not root',
}, async () => {
  const p = place();
  await writeKiroAgent(p.file, '{}', p.workRoot);
  chmodSync(join(p.home, 'agents'), 0o555);
  await removeKiroAgent(p.file, p.workRoot);
  chmodSync(join(p.home, 'agents'), 0o755);
  assert.ok(existsSync(p.file), 'still there');
  await sweepKiroAgents(p.workRoot);
  assert.equal(existsSync(p.file), false, 'removed at the next start');
});

test('#1864 a record the sweep can’t rewrite doesn’t stop Postbox from starting', {
  skip: (process.platform === 'win32' || ROOT) && 'POSIX modes, not root',
}, async () => {
  const p = place();
  await writeKiroAgent(p.file, '{}', p.workRoot);
  // The data folder closed to writing: the agent file goes, but its record can’t be renamed over.
  chmodSync(p.data, 0o555);
  const said = mock.method(console, 'error', () => {});
  try {
    await sweepKiroAgents(p.workRoot);
  } finally {
    said.mock.restore();
    chmodSync(p.data, 0o755);
  }
  assert.equal(existsSync(p.file), false, 'the agent file is still removed');
  assert.deepEqual(record(p.data), [p.file], 'the record is as it was, for the next start');
  assert.match(String(said.mock.calls.at(-1)?.arguments[0]), /couldn’t update .*kiro-agents\.json .*Check that Postbox can write to its data folder/);
});

test('#1864 a linked agents folder, as a dotfile manager makes, has the turn’s file removed and the person’s kept', async () => {
  const p = place();
  const elsewhere = tempDir('pb-kiro-elsewhere-');
  writeFileSync(join(elsewhere, 'mine.json'), '{"name":"mine"}\n');
  const linked = join(p.data, 'linked-home');
  mkdirSync(linked);
  symlinkSync(elsewhere, join(linked, 'agents'));
  const file = join(linked, 'agents', 'postbox-kiro-0a0b0c0d.json');
  await writeKiroAgent(file, '{}', p.workRoot);
  await sweepKiroAgents(p.workRoot);
  assert.deepEqual(readdirSync(elsewhere), ['mine.json'], 'only the turn’s own file went');
});

test('#1864 a file at the noted path that isn’t the one the turn wrote is left as it is', async () => {
  const p = place();
  await writeKiroAgent(p.file, '{"mcpServers":{"postbox":{"url":"http://127.0.0.1:1/mcp?turn=mine"}}}', p.workRoot);
  writeFileSync(p.file, '{"mcpServers":{"postbox":{"url":"http://127.0.0.1:2/mcp?turn=other"}}}');
  await sweepKiroAgents(p.workRoot);
  assert.ok(existsSync(p.file), 'not the file noted: it stays');
  assert.deepEqual(record(p.data), []);
});

test('#1864 turns writing agent files at once each get noted', async () => {
  const p = place();
  const files = Array.from({ length: 8 }, (_, i) => join(p.home, 'agents', `postbox-kiro-0000000${i}.json`));
  await Promise.all(files.map((f) => writeKiroAgent(f, '{}', p.workRoot)));
  assert.equal(record(p.data).length, 8);
});

test('#1864 an agent file the sweep can’t remove stays noted, and one it removed doesn’t', {
  skip: (process.platform === 'win32' || ROOT) && 'POSIX modes, not root',
}, async () => {
  const p = place();
  await writeKiroAgent(p.file, '{}', p.workRoot);
  chmodSync(join(p.home, 'agents'), 0o555);
  const said = mock.method(console, 'error', () => {});
  try {
    await sweepKiroAgents(p.workRoot);
  } finally {
    said.mock.restore();
    chmodSync(join(p.home, 'agents'), 0o755);
  }
  assert.ok(existsSync(p.file), 'still there');
  assert.deepEqual(record(p.data), [p.file], 'and still noted');
  await sweepKiroAgents(p.workRoot);
  assert.deepEqual(record(p.data), [], 'gone, and no longer noted');
});

test('#1864 a link or an oversized file at the noted path is left, though its text matches the note', async () => {
  const p = place();
  // Each holds the noted text, so only the regular-file and size check stands in the way. (A FIFO, which would hang the
  // read: tests/process/kiro-agent-fifo.test.mjs.)
  const target = join(p.data, 'target.json');
  writeFileSync(target, '{}');
  const link = join(p.home, 'agents', 'postbox-kiro-1e1e1e1e.json');
  symlinkSync(target, link);
  const text = 'x'.repeat(1024 * 1024 + 1);
  const big = join(p.home, 'agents', 'postbox-kiro-2d2d2d2d.json');
  writeFileSync(big, text);
  const notes = [
    { file: link, sha256: sha('{}') },
    { file: big, sha256: sha(text) },
  ];
  writeFileSync(join(p.data, 'kiro-agents.json'), `${JSON.stringify(notes)}\n`);
  await sweepKiroAgents(p.workRoot);
  assert.ok(existsSync(link) && existsSync(big), 'both left');
  assert.deepEqual(record(p.data), [], 'and dropped from the record');
});

test('#1864 an agent file in a folder that can’t be looked into stays noted when the turn ends', {
  skip: (process.platform === 'win32' || ROOT) && 'POSIX modes, not root',
}, async () => {
  const p = place();
  await writeKiroAgent(p.file, '{}', p.workRoot);
  chmodSync(join(p.home, 'agents'), 0o444);
  await removeKiroAgent(p.file, p.workRoot);
  chmodSync(join(p.home, 'agents'), 0o755);
  assert.ok(existsSync(p.file), 'still there');
  assert.deepEqual(record(p.data), [p.file], 'and still noted');
});

test('#1864 an agent file of a long persona’s turn is still removed at start', async () => {
  const p = place();
  await writeKiroAgent(p.file, JSON.stringify({ prompt: 'r'.repeat(100_000) }), p.workRoot);
  await sweepKiroAgents(p.workRoot);
  assert.equal(existsSync(p.file), false);
});

test('#1864 a turn never writes its agent file through a link or over a file already at its path', async () => {
  const p = place();
  const target = join(p.data, 'yours.txt');
  writeFileSync(target, 'yours\n');
  symlinkSync(target, p.file);
  await assert.rejects(writeKiroAgent(p.file, '{}', p.workRoot), { code: 'EEXIST' });
  assert.equal(readFileSync(target, 'utf8'), 'yours\n');
});
