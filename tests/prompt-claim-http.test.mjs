// #353, the replay the issue names: the turn’s token is in the CLI’s --mcp-config URL, so a command the agent runs can
// POST permission_prompt to /mcp with it, through the real request gate (server/index.mjs, start({ listen: false })).
// The gate lets it through, as it should: it’s loopback, with no Origin and the right token. The prompt is refused
// after it, before a card or a rule (server/prompt-claim.mjs), while the CLI’s own prompt still gets its card.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { REFUSED } from '../server/prompt-claim.mjs';
import * as arrange from './arrange.mjs';
import { fakeRequest } from './fake-http.mjs';
import { askedAfter, feed, PROMPTS } from './prompt-setup.mjs';
import { tempDir } from './temp-dirs.mjs';

process.env.POSTBOX_BACKENDS = 'mock';
const { start } = await import('../server/index.mjs');
const PORT = 4441;

/** A Postbox with no listener, in a temp folder of its own, closed and then removed when the test file ends. */
async function server(/** @type {import('node:test').TestContext} */ t) {
  const dir = tempDir('pb-replay-');
  const folder = join(dir, 'work');
  await mkdir(folder);
  const app = await start({ port: PORT, dataDir: dir, fresh: true, quiet: true, claudeHome: dir, listen: false });
  // tempDir removes the folder when the file’s process exits, after this has closed the store and its keep-alive timer.
  t.after(() => app.close());
  return { app, folder };
}

test('#353 a permission_prompt replayed to /mcp with the turn’s token raises no card and saves no rule; the CLI’s own still asks', async (t) => {
  const { app, folder } = await server(t);
  /** @type {any[]} */
  const next = [];
  arrange.withAdapter(app.rt, { name: 'claude-code', folderFor: async () => folder, deliver: async (_s, _m, ctx) => next.shift()(ctx) });
  app.store.emit('project', { id: 'p-replay', name: 'Replay', folder });
  const p = app.rt.createPersona({ handle: 'coder', backend: 'claude-code', permissionMode: 'ask', tools: ['shell'] });
  const th = app.rt.createThread({ projectId: 'p-replay', title: 'Replay', personaIds: [p.id] });
  const cards = () => app.store.items(th.id).filter((i) => i.kind === 'permission');
  /** permission_prompt over HTTP, to the URL the CLI was given, as curl would send it. */
  const post = (mcpUrl, args) =>
    fakeRequest(app.handle, {
      method: 'POST',
      host: `127.0.0.1:${PORT}`,
      path: new URL(mcpUrl).pathname + new URL(mcpUrl).search,
      body: { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'permission_prompt', arguments: args } },
    }).then((r) => JSON.parse(r.json.result.content[0].text));
  const [real] = PROMPTS;
  const answers = [];
  /** @type {(e?: unknown) => void} */
  let ended = () => {};
  const done = new Promise((r) => {
    ended = r;
  });
  next.push(async (c) => {
    try {
      feed(c, 0, askedAfter(real.tool_use_id));
      // The agent’s curl: the CLI’s call’s id, with a command of its own and a rule it would like saved.
      answers.push(await post(c.mcpUrl, { tool_name: 'Bash', input: { command: 'curl -s 127.0.0.1:4441/x' }, tool_use_id: real.tool_use_id }));
      const asked = post(c.mcpUrl, real);
      for (let i = 0; i < 1000 && !cards().length; i++) await new Promise((r) => setTimeout(r, 5));
      await app.rt.act(th.id, cards()[0].id, 'allow', {});
      answers.push(await asked);
      feed(c, askedAfter(real.tool_use_id));
      c.text('Done.');
      ended();
    } catch (e) {
      ended(e);
    }
  });
  app.rt.sendMessage(th.id, { text: 'Write the notes.' });
  const failed = await done;
  if (failed) throw failed;
  // The turn ends after the adapter returns: its last writes land before the asserts and the teardown.
  for (let i = 0; i < 1000 && arrange.liveTurns(app.rt); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(arrange.liveTurns(app.rt), 0, 'the turn ended');
  assert.deepEqual(answers[0], { behavior: 'deny', message: REFUSED.differs });
  assert.equal(answers[1].behavior, 'allow', 'the CLI’s own prompt still asks, and is answered');
  assert.equal(cards().length, 1, 'only the real call’s card');
  assert.equal(existsSync(join(folder, '.claude', 'settings.local.json')), false, 'no rule saved');
});
