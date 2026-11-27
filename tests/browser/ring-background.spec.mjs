// An agent whose turn only waits on its background work, a job or a subagent that runs on after its reply, says so on
// its ring (#189): “Waiting on background work”, held still in the idle color, rather than “Calling tools” with a dot
// that crosses the ring. Its session’s state stays “tool”, so messages to it still wait; `background` says what on.
// A call of its own after that wait turns the ring back to calling tools. A side thread’s line says the wait too. The
// agents report through the harness-event contract from scripts the spec holds at each stage
// (tests/browser/live-scripts.mjs), as Claude Code’s stream does in tests/fixtures/claude-code/background-done.jsonl and
// background-subagent.jsonl.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { scriptedRoom } from './live-scripts.mjs';
import { synced } from './postbox.mjs';

const scripted = scriptedRoom(test, 'ring-background');
const { scripts, hold, at, room, go } = scripted;

/** The agent’s ring in its row in the sidebar, its working row at the end of the transcript, and that row’s words. */
function surfaces(page, se) {
  const ring = page.locator(`.rail pb-ring[data-session="${se.id}"]`).first();
  return { ring, svg: ring.locator('svg[role="img"]'), row: page.locator('.working .work-row', { hasText: se.handle }) };
}

/** The animations running in an element, its own and its descendants’. @param {import('@playwright/test').Locator} el */
const animations = (el) => el.evaluate((n) => n.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length);

test('a ring waiting on a background job says so and holds still, and calls tools again when the agent does', async ({ page }) => {
  const t = room('Background job', ['builder']);
  scripts.set('builder', async ({ emit, who }) => {
    emit({ kind: 'tool_call', id: 'j1', name: 'Bash', input: { command: 'npm run build', run_in_background: true }, final: true });
    emit({ kind: 'tool_result', id: 'j1', text: 'Command running in background with ID: bj1.', background: { job: 'bj1', named: true } });
    emit({ kind: 'text', text: 'The build runs in the background.' });
    emit({ kind: 'turn_end' });
    await hold(who, 1);
    emit({ kind: 'tool_end', job: 'bj1', status: 'completed' });
    emit({ kind: 'tool_call', id: 'b2', name: 'Bash', input: { command: 'npm test' }, final: true });
    await hold(who, 2);
    emit({ kind: 'tool_result', id: 'b2', text: 'ok' });
    emit({ kind: 'text', text: ' Built and tested.' });
  });
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  scripted.app.rt.sendMessage(t.id, { text: 'Build it, then test it.' });
  await expect.poll(() => at('builder')).toBe(1);
  const se = arrange.sessionsIn(scripted.app.rt, t.id)[0];
  const { ring, svg, row } = surfaces(page, se);

  await test.step('waiting on its job alone', async () => {
    await expect.soft(ring, 'the ring’s state').toHaveAttribute('state', 'background-wait');
    await expect.soft(svg, 'its label').toHaveAttribute('aria-label', /^builder: Waiting on background work, /);
    await expect.soft(svg.locator('title'), 'its title').toHaveText(/^builder: Waiting on background work, /);
    await expect.soft(ring.locator('.mover'), 'nothing in it moves').toHaveCount(0);
    expect.soft(await animations(ring), 'no animation runs').toBe(0);
    await expect.soft(row, 'its working row').toContainText('waiting on background work: Waiting for a background job');
    expect.soft(scripted.app.store.state.sessions[se.id].state, 'its session stays busy, so messages to it wait').toBe('tool');
  });

  go('builder');
  await expect.poll(() => at('builder')).toBe(2);
  await test.step('a call of its own', async () => {
    await expect.soft(ring, 'the ring’s state').toHaveAttribute('state', 'tool');
    await expect.soft(svg, 'its label').toHaveAttribute('aria-label', /^builder: Calling tools, /);
    await expect.soft(ring.locator('.mover.cross'), 'its dot crosses the ring again').toHaveCount(1);
    await expect.soft(row, 'its working row').toContainText('calling tools: Ran npm test');
  });
  go('builder');
  await expect(page.locator('.transcript')).toContainText('Built and tested.');
  await expect(ring, 'idle once the turn ends').toHaveAttribute('state', 'idle');
});

test('a ring waiting on a background subagent says so, and names the subagent in its label', async ({ page }) => {
  const t = room('Background subagent', ['lead']);
  const input = { subagent_type: 'reader', description: 'Read the papers', prompt: 'Read the papers.', run_in_background: true };
  scripts.set('lead', async ({ emit, who }) => {
    emit({ kind: 'tool_call', id: 'a1', name: 'Agent', input, final: true });
    emit({ kind: 'tool_result', id: 'a1', text: 'Async agent launched.', background: { agent: true } });
    emit({ kind: 'text', text: 'A reader works on it in the background.' });
    emit({ kind: 'message_end', calledTools: false });
    await hold(who, 1);
    emit({ kind: 'tool_end', id: 'a1', status: 'completed', summary: 'Read three papers.' });
    emit({ kind: 'text', text: ' The reader is done.' });
  });
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  scripted.app.rt.sendMessage(t.id, { text: 'Have a reader read the papers.' });
  await expect.poll(() => at('lead')).toBe(1);
  const se = arrange.sessionsIn(scripted.app.rt, t.id)[0];
  const { ring, svg, row } = surfaces(page, se);
  await expect.soft(ring, 'the ring’s state').toHaveAttribute('state', 'background-wait');
  await expect.soft(svg, 'its label, with its subagent').toHaveAttribute('aria-label', /^lead: Waiting on background work, .*; 1 subagent: reader /);
  await expect.soft(row, 'its working row').toContainText('waiting on background work: Waiting for a background subagent');
  go('lead');
  await expect(page.locator('.transcript')).toContainText('The reader is done.');
  await expect(ring, 'idle once the turn ends').toHaveAttribute('state', 'idle');
});

test('a side thread’s line says its agent waits on background work there, and calls tools again when it does', async ({ page }) => {
  const t = room('Background in a side thread', ['curator', 'archivist']);
  const [curator, archivist] = ['curator', 'archivist'].map((handle) => arrange.agentIn(scripted.app.rt, t.id, handle));
  // A side thread from before #372, with its line in the conversation, as tests/browser/side-threads.mjs builds one.
  const side = arrange.putThread(scripted.app.rt, {
    ...{ id: `th_side${t.id.slice(3)}`, projectId: t.projectId, title: 'curator ↔ archivist', kind: 'side', parentId: t.id },
    ...{ pair: 'curator|archivist', woke: 'archivist', members: [], lastSpeaker: null, hops: 0, queue: [], createdAt: Date.now() },
  });
  arrange.post(scripted.app.rt, t.id, { kind: 'sidelink', sideThreadId: side.id, from: 'curator', to: 'archivist', count: 0 });
  scripts.set('archivist', async ({ emit, who }) => {
    emit({ kind: 'tool_call', id: 'j1', name: 'Bash', input: { command: 'npm run index', run_in_background: true }, final: true });
    await hold(who, 1);
    emit({ kind: 'tool_result', id: 'j1', text: 'Command running in background with ID: bj1.', background: { job: 'bj1', named: true } });
    emit({ kind: 'text', text: 'The index builds in the background.' });
    emit({ kind: 'turn_end' });
    await hold(who, 2);
    emit({ kind: 'tool_end', job: 'bj1', status: 'completed' });
    emit({ kind: 'tool_call', id: 'b2', name: 'Bash', input: { command: 'npm run check-index' }, final: true });
    await hold(who, 3);
    emit({ kind: 'tool_result', id: 'b2', text: 'ok' });
  });
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  arrange.deliver(scripted.app.rt, archivist.id, { kind: 'agent', from: `@${curator.handle}`, text: 'Build the index.' }, { threadId: side.id });
  await expect.poll(() => at('archivist')).toBe(1);
  const line = page.locator('#main .pill', { hasText: 'asked' });
  // It calls a tool first, so the line, already drawn, has to change to say it waits.
  await expect.soft(line, 'the line while it calls a tool').toContainText('archivist is calling tools');
  go('archivist');
  await expect.poll(() => at('archivist')).toBe(2);
  await expect.soft(line, 'the line’s words').toContainText('curator asked archivist · archivist is waiting on background work · ');
  await expect.soft(line.locator('pb-ring'), 'its ring').toHaveAttribute('state', 'background-wait');
  // A call of its own: its state stays “tool”, so only the wait’s end tells the line to change back.
  go('archivist');
  await expect.poll(() => at('archivist')).toBe(3);
  await expect.soft(line, 'the line once it calls a tool again').toContainText('archivist is calling tools');
  go('archivist');
  await expect(line, 'the line once the turn ends').not.toContainText('archivist is');
});
