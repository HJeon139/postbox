// A subagent’s context when the backend sends none (#189), from a recorded stream: Claude Code forwards no usage for a
// subagent (tests/fixtures/claude-code/subagent-tree.jsonl), so its ring says its context is unknown rather than 0%,
// and its activity still shows, as the person decided on 24 October 2026:
// - each subagent ring in the agent tree is labeled “context unknown”, not “0%”;
// - a thinking or generating subagent draws no arc, which would read as an amount, but its dot still moves.
// With a scripted Claude Code agent that replays the stream and holds partway, in a conversation of its own.

import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { createStreamMapper } from '../../server/adapters/claude-stream.mjs';
import { failOnPageErrors, startPostbox, synced } from './postbox.mjs';

/** @type {Awaited<ReturnType<typeof startPostbox>>} */
let app;
const lines = readFileSync(new URL('../fixtures/claude-code/subagent-tree.jsonl', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l));
// Held once the Reader has started its own subagent, as agents.spec.mjs does.
const NESTED = 'toolu_014cQVtisPCNL6gRibMij5jM';
const pause = lines.findIndex((e) => e.type === 'user' && e.message?.content?.some?.((b) => b.tool_use_id === NESTED)) + 1;
let go = () => {};
let held = false;

test.beforeAll(async () => {
  app = await startPostbox('ring-context');
  const { rt, store } = app;
  rt.adapters.register({
    name: 'claude-code',
    async folderFor() {
      return app.root;
    },
    async deliver(_session, _message, ctx) {
      const m = createStreamMapper(ctx);
      for (const e of lines.slice(0, pause)) m.push(e);
      held = true;
      await new Promise((r) => {
        go = () => r(undefined);
      });
      for (const e of lines.slice(pause)) m.push(e);
    },
  });
  store.emit('project', { id: 'pr_ring', name: 'Rings', folder: app.root });
});
test.afterAll(async () => {
  go();
  await app?.stop();
});
failOnPageErrors(test);
test.use({ colorScheme: 'light' });

test('#189 a subagent with no reported context says so, and its activity still shows', async ({ page }) => {
  const { rt } = app;
  const p = rt.createPersona({ handle: 'counter', backend: 'claude-code', permissionMode: 'auto' });
  const t = rt.createThread({ projectId: 'pr_ring', title: 'Count the words', personaIds: [p.id] });
  await page.goto(`${app.origin}/#/t/${t.id}`);
  await synced(page, app);
  rt.sendMessage(t.id, { text: 'Count the words, with a subagent.' });
  await expect.poll(() => held, { message: 'the replay to reach its pause' }).toBe(true);
  await synced(page, app);
  const se = rt.sessionsIn(t.id)[0];
  expect(
    app.store.state.sessions[se.id].subagents.map((s) => s.ctx),
    'the server keeps it unknown',
  ).toEqual([null, null]);
  const rings = page.locator('.rail .agent-row .agent-sub.subagent pb-ring');
  await expect(rings).toHaveCount(2);
  for (const ring of await rings.all()) {
    await expect(ring.locator('svg')).toHaveAttribute('aria-label', /context unknown/);
    await expect(ring.locator('svg')).not.toHaveAttribute('aria-label', /0%/);
  }
  // The agent’s own ring lists its subagents the same way.
  const own = page.locator(`.rail pb-ring[data-session="${se.id}"] svg`).first();
  await expect(own).toHaveAttribute('aria-label', /subagents: .*context unknown/);
  // A subagent thinking or generating draws no arc, which would read as an amount, but its dot still moves.
  const marks = await rings.evaluateAll((els) =>
    els.map((el) => ({
      state: el.getAttribute('state'),
      dash: Number.parseFloat(el.querySelectorAll('.arc')[el.querySelectorAll('.arc').length - 1]?.getAttribute('stroke-dasharray') ?? '0'),
      dot: !!el.querySelectorAll('svg circle.dot').length,
    })),
  );
  const active = marks.filter((x) => x.state === 'think' || x.state === 'gen');
  expect(active.length, 'the replay holds a subagent thinking or generating').toBeGreaterThan(0);
  for (const a of active) {
    expect(a.dash, `a ${a.state} subagent draws no arc`).toBe(0);
    expect(a.dot, `a ${a.state} subagent’s dot moves`).toBe(true);
  }
  go();
});
