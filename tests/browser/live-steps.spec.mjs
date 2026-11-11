// A running turn’s steps as they happen, and a finished turn’s one-line record (designs/rooms-at-scale.md, “Live
// state”). Agents here report through the harness-event contract (server/harness-events.mjs) from scripts the test
// holds at each stage, as the mock backend’s do, so a stage can be looked at while the turn still runs.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { HarnessEvents } from '../../server/harness-events.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
let project;
/** @type {Map<string, (step: any) => Promise<void>>} each agent’s script, by its handle */
const scripts = new Map();
/** @type {Map<string, { stage: number, go: () => void }>} where each agent’s script waits */
const holds = new Map();

/** Waits in a script until the test says go, noting the stage it waits at. */
const hold = (/** @type {string} */ who, /** @type {number} */ stage) =>
  new Promise((r) => {
    holds.set(who, { stage, go: () => r(undefined) });
  });
const go = (/** @type {string} */ who) => holds.get(who)?.go();
const at = (/** @type {string} */ who) => holds.get(who)?.stage ?? -1;

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeAll(async () => {
  app = await startPostbox('live-steps');
  app.rt.adapters.register({
    name: 'claude-code',
    async folderFor() {
      return app.root;
    },
    async deliver(session, _message, ctx) {
      const emit = new HarnessEvents(ctx).event;
      await scripts.get(session.handle)?.({ emit, who: session.handle });
    },
  });
  project = Object.values(app.store.state.projects)[0];
});
test.afterAll(async () => {
  for (const h of holds.values()) h.go();
  await app?.stop();
});
failOnPageErrors(test);

/** A room of agents on the scripted backend. @param {string} title @param {string[]} handles */
function room(title, handles) {
  const ids = handles.map((handle) => app.rt.createPersona({ handle, backend: 'claude-code', model: 'claude-haiku-5-5' }).id);
  return app.rt.createThread({ projectId: project.id, title, personaIds: ids });
}

/** An edit the agent makes for real, so the work ledger records it, reported as Claude Code reports it. */
async function edit(/** @type {any} */ emit, /** @type {string} */ id, /** @type {string} */ file, /** @type {string} */ from, /** @type {string} */ to) {
  const path = join(app.root, file);
  const input = { file_path: path, old_string: from, new_string: to };
  emit({ kind: 'tool_call', id, name: 'Edit', input, final: true });
  const before = await readFile(path, 'utf8');
  await writeFile(path, before.replace(from, to));
  emit({ kind: 'tool_result', id, text: 'ok', result: { originalFile: before } });
}

test('the newest step shows in full, an edit as its diff; an older one is a line with its counts', async ({ page }) => {
  await writeFile(join(app.root, 'calc.py'), 'def add(a, b):\n    return a - b\n');
  const t = room('Newest in full', ['fixer']);
  scripts.set('fixer', async ({ emit, who }) => {
    emit({ kind: 'tool_call', id: 'r1', name: 'Read', input: { file_path: join(app.root, 'calc.py') }, final: true });
    emit({ kind: 'tool_result', id: 'r1', text: 'def add(a, b):\n    return a - b' });
    await edit(emit, 'e1', 'calc.py', '    return a - b', '    return a + b');
    await hold(who, 1);
    emit({ kind: 'tool_call', id: 'b1', name: 'Bash', input: { command: 'python -m pytest -q' }, final: true });
    emit({ kind: 'tool_result', id: 'b1', text: '....\n4 passed in 0.02s' });
    await hold(who, 2);
    emit({ kind: 'text', text: 'Fixed `add`.' });
  });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  app.rt.sendMessage(t.id, { text: 'Fix add.' });
  await expect.poll(() => at('fixer')).toBe(1);
  const live = page.locator('.live-steps');
  await test.step('the edit, newest, shows in full with its diff', async () => {
    const full = live.locator('li.step-full');
    await expect(full).toHaveCount(1);
    await expect(full).toContainText('Edited calc.py');
    await expect(full.locator('.step-diff .del')).toHaveText('-    return a - b');
    await expect(full.locator('.step-diff .add')).toHaveText('+    return a + b');
    await expect(live.locator('li.step-line', { hasText: 'Read calc.py' }), 'the read before it is one line').toHaveCount(1);
  });
  go('fixer');
  await expect.poll(() => at('fixer')).toBe(2);
  await test.step('the command, newest, shows its output; the edit is one line, its counts green and red', async () => {
    await expect(live.locator('li.step-full')).toContainText('4 passed in 0.02s');
    const line = live.locator('li.step-line', { hasText: 'Edited calc.py' });
    await expect(line.locator('.work-n .add')).toHaveText('+1');
    await expect(line.locator('.work-n .del')).toHaveText('−1');
  });
  go('fixer');
  await expect.poll(() => app.rt.turns.size).toBe(0);
});

test('a turn’s own words sit between its steps, in the order it wrote and ran them', async ({ page }) => {
  await writeFile(join(app.root, 'notes.txt'), 'alpha\n');
  const t = room('Words between steps', ['writer']);
  scripts.set('writer', async ({ emit, who }) => {
    emit({ kind: 'text', text: 'Reading the notes first.' });
    emit({ kind: 'tool_call', id: 'r1', name: 'Read', input: { file_path: join(app.root, 'notes.txt') }, final: true });
    emit({ kind: 'tool_result', id: 'r1', text: 'alpha' });
    emit({ kind: 'text', text: 'One line; adding a second.' });
    await edit(emit, 'e1', 'notes.txt', 'alpha', 'alpha\nbeta');
    await hold(who, 1);
    emit({ kind: 'text', text: 'Done.' });
  });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  app.rt.sendMessage(t.id, { text: 'Add beta.' });
  await expect.poll(() => at('writer')).toBe(1);
  const reply = page.locator('.turn', { has: page.locator('.live-steps') });
  await expect(reply).toContainText('Edited notes.txt');
  const text = (await reply.textContent()) ?? '';
  const order = ['Reading the notes first.', 'Read notes.txt', 'One line; adding a second.', 'Edited notes.txt'].map((s) => text.indexOf(s));
  expect(
    order.every((i) => i >= 0),
    text,
  ).toBe(true);
  expect(order, 'each in the order it happened').toEqual([...order].sort((a, b) => a - b));
  go('writer');
  await expect.poll(() => app.rt.turns.size).toBe(0);
});

test('a finished turn’s steps fold into its work record at the top of the post, which opens to them and to Work', async ({ page }) => {
  await writeFile(join(app.root, 'calc2.py'), 'x = 1\n');
  const t = room('Work record', ['recorder']);
  scripts.set('recorder', async ({ emit }) => {
    await edit(emit, 'e1', 'calc2.py', 'x = 1', 'x = 2');
    emit({ kind: 'text', text: 'Set x to 2.' });
  });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  app.rt.sendMessage(t.id, { text: 'Set x.' });
  await expect.poll(() => app.rt.turns.size).toBe(0);
  await synced(page, app);
  const post = page.locator('.turn', { hasText: 'Set x to 2.' });
  const record = post.locator('details.activity');
  await expect(record).not.toHaveAttribute('open', '');
  await expect(record.locator('> summary'), 'the turn’s record').toContainText('1 file +1 −1');
  expect(await post.evaluate((el) => el.querySelector('details.activity')?.compareDocumentPosition(/** @type {Node} */ (el.querySelector('.md'))) ?? 0)).toBe(
    4,
  );
  await record.locator('> summary').click();
  await expect(record.locator('.steps'), 'it opens to the steps').toContainText('Edited calc2.py');
  await expect(record.getByRole('link', { name: /Work/ }), 'and to Work').toBeVisible();
});

test('detail fades within each agent’s share of the screen: four agents show a few lines each, eight a line each', async ({ page }) => {
  const four = ['ana', 'ben', 'cal', 'dee'];
  const eight = ['eve', 'fay', 'gus', 'hal', 'ivy', 'jon', 'kim', 'lou'];
  for (const who of [...four, ...eight])
    scripts.set(who, async ({ emit }) => {
      for (let i = 1; i <= 9; i++) {
        emit({ kind: 'tool_call', id: `${who}-${i}`, name: 'Bash', input: { command: `make step-${i}` }, final: true });
        emit({ kind: 'tool_result', id: `${who}-${i}`, text: `step ${i} ok` });
      }
      await hold(who, 1);
    });
  const show = async (/** @type {string[]} */ handles) => {
    const t = room(`${handles.length} agents`, handles);
    // A room the page hasn’t heard of yet isn’t one it can open: with the stream late, it waits for it first.
    if (page.url().startsWith(app.origin)) await synced(page, app);
    await page.goto(`${app.origin}/#/t/${t.id}`);
    await expect(page.locator('.transcript'), 'the new room is open').toHaveAttribute('data-thread', t.id);
    await synced(page, app);
    app.rt.sendMessage(t.id, { text: `${handles.map((w) => `@${w}`).join(' ')} build` });
    await expect.poll(() => handles.map((w) => `${w}:${at(w)}`).join(' ')).toBe(handles.map((w) => `${w}:1`).join(' '));
    await synced(page, app);
    return t;
  };
  await test.step('four agents: the newest step in full, a few lines, the rest as earlier steps', async () => {
    await show(four);
    const blocks = page.locator('.live-steps');
    await expect(blocks).toHaveCount(4);
    for (const b of await blocks.all()) {
      await expect(b.locator('li.step-full')).toHaveCount(1);
      await expect(b.locator('details.earlier > summary')).toHaveText(/\d+ earlier steps/);
      expect((await b.boundingBox())?.height ?? 0, 'within its share of 760 px').toBeLessThanOrEqual(200);
    }
    for (const w of four) go(w);
    await expect.poll(() => app.rt.turns.size).toBe(0);
  });
  await test.step('eight agents: one line each, what it’s doing and its step count', async () => {
    await show(eight);
    const blocks = page.locator('.live-steps');
    await expect(blocks).toHaveCount(8);
    for (const b of await blocks.all()) {
      await expect(b).toHaveClass(/crowded/);
      await expect(b).toContainText('9 steps');
      await expect(b.locator('li.step-full')).toHaveCount(0);
    }
    for (const w of eight) go(w);
    await expect.poll(() => app.rt.turns.size).toBe(0);
  });
});
