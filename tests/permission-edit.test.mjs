// A permission card’s Edit (server/permission-edit.mjs, #10): an edit that changes nothing is a plain allow (#979),
// and anything else, however small, stays an edit with the input it allows.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';
import { FIXTURE_PROMPT } from './fake-daemon.mjs';
import { rig, running, settled, until } from './remote-turns-helpers.mjs';
import { tempDir } from './temp-dirs.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Claude Code agent whose one turn asks about `req`, and keeps the answer. */
class AskingClaude {
  name = 'claude-code';
  constructor(folder, req) {
    this.folder = folder;
    this.req = req;
    this.answer = undefined;
  }
  async folderFor() {
    return this.folder;
  }
  async deliver(_session, _message, ctx) {
    this.answer = await ctx.askPermission(this.req);
  }
}

/** A card open for `req`, on a laptop persona. */
async function cardFor(req) {
  const folder = tempDir('pb-edit-');
  const store = new Store(null);
  const adapter = new AskingClaude(folder, req);
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register(adapter),
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0, home: folder },
  });
  store.emit('project', { id: 'p1', name: 'P', folder });
  const p = rt.createPersona({ handle: 'coder', backend: 'claude-code', permissionMode: 'ask', tools: ['shell'] });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [p.id] });
  rt.sendMessage(t.id, { text: 'go' });
  // The card opens once the turn has started and asked: poll for it, as answer() polls for the turn's end, rather than
  // a fixed wait a loaded runner can outlast.
  const openCard = () => store.items(t.id).find((i) => i.kind === 'permission' && i.status === 'open');
  for (let i = 0; i < 400 && !openCard(); i++) await sleep(5);
  const card = openCard();
  assert.ok(card, 'the permission card opened');
  /** Answers the card with `action`, and says what the call, the card and the conversation got. */
  const answer = async (action, values) => {
    rt.act(t.id, card.id, action, values);
    for (let i = 0; i < 100 && rt.turns.size; i++) await sleep(5);
    const items = store.items(t.id);
    const settledCard = items.find((i) => i.id === card.id);
    return {
      answer: adapter.answer,
      status: settledCard.status,
      edited: settledCard.edited,
      line: items.filter((i) => i.kind === 'voice').at(-1)?.text,
    };
  };
  return { answer };
}

const BASH = { tool: 'Bash', summary: 'run a command', input: { command: 'git push origin main', description: 'Push' } };
const FETCH = { tool: 'WebFetch', summary: 'fetch a page', input: { url: 'https://a.example/x', prompt: 'p', max: 1 } };
const PLAIN_BASH = { answer: { allow: true }, status: 'allowed', edited: undefined, line: 'Allowed: @coder to run a command' };
const PLAIN_FETCH = { ...PLAIN_BASH, line: 'Allowed: @coder to fetch a page' };
const editOf = (summary, updatedInput, edited) => ({
  answer: { allow: true, updatedInput },
  status: 'allowed-edited',
  edited,
  line: `Allowed with your edit: @coder to ${summary}`,
});

test('#979: a plain Allow settles as allowed, with no updatedInput (what an unchanged edit has to match)', async () => {
  assert.deepEqual(await (await cardFor(BASH)).answer('allow'), PLAIN_BASH);
});

test('#979: Allow with this edit on the command as it was is a plain allow, not “Allowed with your edit”', async () => {
  assert.deepEqual(await (await cardFor(BASH)).answer('edit', { command: 'git push origin main' }), PLAIN_BASH);
});

test('#979: an unchanged command with the editor’s trailing newline is a plain allow, since the edit trims it', async () => {
  assert.deepEqual(await (await cardFor(BASH)).answer('edit', { command: 'git push origin main\n' }), PLAIN_BASH);
});

test('#979: Allow with this edit on the JSON as it was is a plain allow', async () => {
  assert.deepEqual(await (await cardFor(FETCH)).answer('edit', { input: JSON.stringify(FETCH.input, null, 2) }), PLAIN_FETCH);
});

test('#979: the same JSON with its keys in another order is a plain allow, since the tool reads an object, not text', async () => {
  assert.deepEqual(await (await cardFor(FETCH)).answer('edit', { input: '{ "max": 1, "prompt": "p", "url": "https://a.example/x" }' }), PLAIN_FETCH);
});

test('#979: a command whose only change is a space inside it is still an edit, since that can change what runs', async () => {
  const command = 'git push  origin main';
  assert.deepEqual(await (await cardFor(BASH)).answer('edit', { command }), editOf('run a command', { ...BASH.input, command }, command));
});

test('#979: a value of another type (the string "1" for the number 1) is still an edit', async () => {
  const input = { ...FETCH.input, max: '1' };
  assert.deepEqual(
    await (await cardFor(FETCH)).answer('edit', { input: JSON.stringify(input) }),
    editOf('fetch a page', input, JSON.stringify(input, null, 2)),
  );
});

test('#979: an added key is still an edit', async () => {
  const input = { ...FETCH.input, extra: null };
  assert.deepEqual(
    await (await cardFor(FETCH)).answer('edit', { input: JSON.stringify(input) }),
    editOf('fetch a page', input, JSON.stringify(input, null, 2)),
  );
});

test('#979: a removed key is still an edit', async () => {
  const { max: _max, ...input } = FETCH.input;
  assert.deepEqual(
    await (await cardFor(FETCH)).answer('edit', { input: JSON.stringify(input) }),
    editOf('fetch a page', input, JSON.stringify(input, null, 2)),
  );
});

test('#979: a host card’s unchanged edit is a plain allow, and the host is answered with the call’s own input', async () => {
  const r = rig();
  const turn = await running(r);
  const id = r.d.prompt(turn, FIXTURE_PROMPT);
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'permission'), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.kind === 'permission');
  r.rt.resolvePermission(r.t.id, card.id, 'edit', { command: FIXTURE_PROMPT.input.command });
  await until(() => r.d.answers.length === 1, 'the answer');
  assert.deepEqual(r.d.answers[0], { turn, id, result: { behavior: 'allow', updatedInput: FIXTURE_PROMPT.input } });
  const settledCard = r.store.item(r.t.id, card.id);
  assert.equal(settledCard.status, 'allowed');
  assert.equal(settledCard.edited, undefined);
  r.d.end(turn);
  await settled(r);
});

test('#979: a host card’s edit that changes only whitespace inside the command answers the host with the edited command', async () => {
  const r = rig();
  const turn = await running(r);
  const id = r.d.prompt(turn, FIXTURE_PROMPT);
  await until(() => r.store.items(r.t.id).some((i) => i.kind === 'permission'), 'the card');
  const card = r.store.items(r.t.id).find((i) => i.kind === 'permission');
  const command = FIXTURE_PROMPT.input.command.replace(' ', '  ');
  r.rt.resolvePermission(r.t.id, card.id, 'edit', { command });
  await until(() => r.d.answers.length === 1, 'the answer');
  assert.deepEqual(r.d.answers[0], { turn, id, result: { behavior: 'allow', updatedInput: { ...FIXTURE_PROMPT.input, command } } });
  assert.equal(r.store.item(r.t.id, card.id).status, 'allowed-edited');
  r.d.end(turn);
  await settled(r);
});
