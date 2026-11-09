// #338: Always allow on an Antigravity read card outside its folders saves the file’s folder as readable for that
// conversation (se.readDirs), Antigravity’s workspace as the person decided on 27 October 2026. Only the hook’s read
// branch reads that list: a readable folder is never one Antigravity may edit with no card, and it isn’t --add-dir.
// No Always allow for /, the home folder, a folder that holds it, or a dot-folder in it (where credentials live),
// each judged on the real path, nor on a host turn’s card. The design is sprint4/338-packet-r1.md v2.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { decideAgyTool, runAgyHook } from '../server/adapters/agy-hook.mjs';
import { agyHookVars } from '../server/adapters/antigravity-cli.mjs';
import { handleMcp } from '../server/mcp.mjs';
import { inReadFolder, readFolderOffer } from '../server/read-folders.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { tempDir } from './temp-dirs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A home with a project, a folder of notes outside it, a dot-folder, and a link to that dot-folder. */
function aHome() {
  const home = realpathSync(tempDir('pb-read-folders-'));
  const ws = join(home, 'ws');
  const notes = join(home, 'notes');
  for (const d of [ws, notes, join(home, '.ssh'), join(home, '.config', 'gh')]) mkdirSync(d, { recursive: true });
  for (const f of [join(notes, 'a.md'), join(home, '.ssh', 'id_ed25519'), join(home, 'top.md')]) writeFileSync(f, 'x');
  symlinkSync(join(home, '.ssh'), join(home, 'keys'));
  return { home, ws, notes };
}

const agy = { backend: 'antigravity-cli', tool: 'Read' };

test('#338 an Antigravity read outside its folders offers its folder, named on the card', () => {
  const { home, notes } = aHome();
  const offer = readFolderOffer({ ...agy, input: { file_path: join(notes, 'a.md') }, home });
  assert.deepEqual(offer, {
    lines: [{ text: `Always allow ${notes} for this agent to read, in this conversation`, rule: notes }],
    readDir: notes,
  });
});

// The card shows each line as “Always allow <code>rule</code>” and then the text past `Always allow ${rule}`
// (app/js/permission-cards.mjs), so a text that doesn’t start that way is garbled on the card, as #324’s was.
test('#338 the offer’s text starts with “Always allow <its folder>”, as the card shows it', () => {
  const { home, notes } = aHome();
  const [line] = readFolderOffer({ ...agy, input: { file_path: join(notes, 'a.md') }, home })?.lines ?? assert.fail('an offer');
  assert.ok(line.text.startsWith(`Always allow ${line.rule} `), line.text);
});

test('#338 no Always allow for /, home, a dot-folder in home or inside one, a link to one, a host card, or another backend', () => {
  const { home, notes } = aHome();
  const none = (file, extra = {}) => assert.equal(readFolderOffer({ ...agy, input: { file_path: file }, home, ...extra }), null, file);
  none('/postbox-no-such-file.md'); // a file just under /, whose folder is /
  none(join(home, 'top.md'));
  none(join(home, '.ssh', 'id_ed25519'));
  none(join(home, '.config', 'gh', 'hosts.yml'));
  none(join(home, 'keys', 'id_ed25519'), 'a link to a dot-folder is judged by where it leads');
  none(join(notes, 'a.md'), { hostId: 'ho_1' });
  none(join(notes, 'a.md'), { backend: 'claude-code' });
  none(join(notes, 'a.md'), { tool: 'Write' });
  none('');
  mkdirSync(join(notes, 'inner'));
  assert.equal(readFolderOffer({ ...agy, input: { file_path: join(notes, 'a.md') }, home: join(notes, 'inner') }), null, 'a folder that holds home');
});

// The hook’s list is the turn’s start, so a folder removed mid-turn would still be read there with no card (#1074): a
// read there asks Postbox, which answers it from the session as it is now (inReadFolder).
test('#1074 a read in a readable folder asks Postbox, and an edit there asks too', () => {
  const { home, ws, notes } = aHome();
  const event = (name, args) => ({ toolCall: { name, args } });
  for (const mode of ['auto', 'acceptEdits', 'ask']) {
    const opts = { mode, folders: [ws], readFolders: [notes], cwd: ws, home };
    const file_path = join(notes, 'a.md');
    assert.deepEqual(decideAgyTool(event('view_file', { AbsolutePath: file_path }), opts), { decision: 'ask', toolName: 'Read', input: { file_path } }, mode);
    assert.equal(decideAgyTool(event('write_to_file', { TargetFile: join(notes, 'b.md'), CodeContent: 'x' }), opts).decision, 'ask', mode);
    assert.equal(decideAgyTool(event('view_file', { AbsolutePath: join(home, '.ssh', 'id_ed25519') }), opts).decision, 'ask', mode);
  }
});

// The hook’s list is the turn’s start, so a folder allowed later in the turn is judged by inReadFolder alone (#1074).
test('#1074 a read card naming a second path outside a readable folder still asks, with no Always allow', () => {
  const { home, ws, notes } = aHome();
  const args = { Path: join(notes, 'a.md'), SearchPath: join(home, '.ssh') };
  const card = decideAgyTool({ toolCall: { name: 'grep_search', args } }, { mode: 'ask', folders: [ws], cwd: ws, home });
  const rt = { s: { sessions: { s1: { personaId: 'p1', readDirs: [notes] } } }, persona: () => ({ backend: 'antigravity-cli' }) };
  assert.equal(inReadFolder(rt, 's1', { tool: card.toolName, input: card.input }), false, 'answered with no card');
  assert.equal(readFolderOffer({ ...agy, input: card.input, home }), null, 'an offer for one folder would allow both');
  assert.equal(inReadFolder(rt, 's1', { tool: 'Read', input: { file_path: join(notes, 'a.md') } }), true, 'one path there needs no card');
});

test('#338 the hook’s variables carry the readable folders apart from the folders it may work in', () => {
  const vars = agyHookVars({ mcpUrl: 'http://127.0.0.1:1/mcp', persona: { permissionMode: 'auto' }, cwd: '/w', addDirs: ['/a'], readDirs: ['/r'] });
  assert.deepEqual(JSON.parse(vars.POSTBOX_AGY_FOLDERS), ['/w', '/a']);
  assert.deepEqual(JSON.parse(vars.POSTBOX_AGY_READ), ['/r']);
});

test('#338 Always allow on the card saves the folder for the conversation, and the next read there has no card', async () => {
  const { home, ws, notes } = aHome();
  const store = new Store(null);
  const adapter = {
    name: 'antigravity-cli',
    capabilities: { promptTool: true, promptHook: true, permissions: 'none' },
    next: /** @type {any[]} */ ([]),
    async deliver(_s, _m, ctx) {
      await this.next.shift()?.(ctx);
    },
  };
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: ws });
  const p = rt.createPersona({ handle: 'gem', backend: 'antigravity-cli', permissionMode: 'ask' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  const fetchMcp = async (_url, init) => ({
    ok: true,
    status: 200,
    json: async () => handleMcp(rt, se.id, JSON.parse(init.body), rt.turns.get(se.id)?.token ?? null),
  });
  const read = JSON.stringify({ toolCall: { name: 'view_file', args: { AbsolutePath: join(notes, 'a.md') } } });
  const env = { POSTBOX_MCP_URL: 'http://127.0.0.1:1/mcp', POSTBOX_AGY_MODE: 'ask', POSTBOX_AGY_FOLDERS: JSON.stringify([ws]) };
  /** @type {any[]} */
  const results = [];
  adapter.next.push(async () => {
    const asked = runAgyHook(read, { cwd: ws, env, home, fetchImpl: /** @type {any} */ (fetchMcp) });
    await sleep(10);
    const card = store.items(t.id).find((i) => i.kind === 'permission' && i.status === 'open');
    assert.equal(card.always?.lines[0].text, `Always allow ${notes} for this agent to read, in this conversation`);
    await rt.act(t.id, card.id, 'always', {});
    results.push(await asked);
  });
  rt.sendMessage(t.id, { text: 'read the notes' });
  for (let i = 0; i < 200 && !results.length; i++) await sleep(5);
  assert.equal(results[0].decision, 'allow');
  assert.deepEqual(rt.s.sessions[se.id].readDirs, [notes]);
  assert.deepEqual(rt.s.sessions[se.id].addDirs ?? [], [], 'not a folder it may work in');
  const next = { ...env, POSTBOX_AGY_READ: JSON.stringify(rt.s.sessions[se.id].readDirs) };
  let asks = 0;
  const counted = async (url, init) => {
    asks++;
    return fetchMcp(url, init);
  };
  // The next turn’s read, while that turn runs, as its hook asks.
  adapter.next.push(async () => {
    results.push(await runAgyHook(read, { cwd: ws, env: next, home, fetchImpl: /** @type {any} */ (counted) }));
  });
  rt.sendMessage(t.id, { text: 'read them again' });
  for (let i = 0; i < 200 && results.length < 2; i++) await sleep(5);
  assert.equal(results[1]?.decision, 'allow');
  assert.equal(asks, 1, 'asked Postbox, which reads the session as it is now (#1074)');
  assert.equal(store.items(t.id).filter((i) => i.kind === 'permission').length, 1, 'no card the second time');
});

test('#338 the panel lists a readable folder as read only, and Remove takes out only that one', async () => {
  const { permissionsView, changePermissionFolder } = await import('../server/permissions-panel.mjs');
  const { home, ws, notes } = aHome();
  const rt = new Runtime({
    store: new Store(null),
    adapters: new AdapterRegistry().register({ name: 'antigravity-cli', capabilities: { permissions: 'none' }, async deliver() {} }),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home },
  });
  rt.store.emit('project', { id: 'p1', name: 'P', folder: ws });
  const p = rt.createPersona({ handle: 'gem', backend: 'antigravity-cli' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  const se = rt.sessionsIn(t.id)[0];
  rt.updateSession(se.id, { readDirs: [notes], addDirs: [notes] });
  const view = await permissionsView(rt, { threadId: t.id, sessionId: se.id });
  assert.deepEqual(
    view.folders.filter((f) => f.path === notes).map((f) => f.source),
    ['conversation', 'read'],
  );
  await changePermissionFolder(rt, { sessionId: se.id, path: notes, remove: true, read: true });
  assert.deepEqual(rt.s.sessions[se.id].readDirs, []);
  assert.deepEqual(rt.s.sessions[se.id].addDirs, [notes], 'the folder it may work in stays');
});

test('#338 a conversation keeps up to 20 readable folders; one already listed adds nothing', async () => {
  const { addReadFolder, MAX_READ_DIRS } = await import('../server/read-folders.mjs');
  const { home, ws } = aHome();
  const rt = new Runtime({
    store: new Store(null),
    adapters: new AdapterRegistry().register({ name: 'antigravity-cli', capabilities: { permissions: 'none' }, async deliver() {} }),
    corpus: { search: () => [], read: () => null, stats: () => ({ books: [], passages: 0 }) },
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home },
  });
  rt.store.emit('project', { id: 'p1', name: 'P', folder: ws });
  const p = rt.createPersona({ handle: 'gem', backend: 'antigravity-cli' });
  const se = rt.sessionsIn(rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] }).id)[0];
  for (let i = 0; i < MAX_READ_DIRS; i++) addReadFolder(rt, se.id, `/r/${i}`);
  addReadFolder(rt, se.id, '/r/0');
  assert.equal(rt.s.sessions[se.id].readDirs.length, MAX_READ_DIRS);
  assert.throws(() => addReadFolder(rt, se.id, '/r/more'), { status: 422 });
});

// #338, on macOS: realpathSync keeps the case it’s given, and the disk ignores it, so
// /USERS/<you>/.ssh/x got past the home and dot-folder checks. The real path must come in its true case. Runs only
// where the file system ignores case, as macOS’s does by default; elsewhere such a path doesn’t exist.
const caseBlind = (dir) => existsSync(dir.toUpperCase()) && dir.toUpperCase() !== dir;
test('#338 on a disk that ignores case, a path written in another case is judged by its true case', (t) => {
  const { home, notes } = aHome();
  if (!caseBlind(home)) return t.skip('this file system tells case apart');
  const shout = (p) => p.toUpperCase();
  const none = (file) => assert.equal(readFolderOffer({ ...agy, input: { file_path: file }, home }), null, file);
  none(shout(join(home, '.ssh', 'id_ed25519')));
  none(shout(join(home, 'top.md')));
  none(join(shout(dirname(home)), 'x.md'));
  assert.equal(readFolderOffer({ ...agy, input: { file_path: shout(join(notes, 'a.md')) }, home })?.readDir, notes, 'saved in its true case');
});
