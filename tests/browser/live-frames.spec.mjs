// A running turn’s steps and its agent’s current step reach the page live, unstored, and a page that loads mid-turn
// draws them too (designs/architecture/live-progress.md, step 3): the server stores a step only at a commit point, a
// new step of the agent’s own or the turn’s end, and the session’s live fields never while the turn runs, so the page
// draws them from the live frames, and at load from /api/state’s snapshot of the running turns.

import { expect, test } from '@playwright/test';
import * as arrange from '../arrange.mjs';
import { scriptedRoom } from './live-scripts.mjs';
import { synced } from './postbox.mjs';

const scripted = scriptedRoom(test, 'live-frames');
const { scripts, hold, at, room, go } = scripted;

test('a step and the agent’s current step show live, though unstored, and again after a reload mid-turn', async ({ page }) => {
  const t = room('Live frames', ['fixer']);
  scripts.set('fixer', async ({ emit, who }) => {
    emit({ kind: 'text', text: 'Running the tests.' });
    emit({ kind: 'tool_call', id: 'b1', name: 'Bash', input: { command: 'npm test -- --grep live' }, final: true });
    await hold(who, 1);
    emit({ kind: 'tool_result', id: 'b1', text: '3 passing' });
    emit({ kind: 'text', text: ' Done.' });
  });
  await page.goto(`${scripted.app.origin}/#/t/${t.id}`);
  await synced(page, scripted.app);
  scripted.app.rt.sendMessage(t.id, { text: 'Run the tests.' });
  await expect.poll(() => at('fixer')).toBe(1);
  const se = arrange.sessionsIn(scripted.app.rt, t.id)[0];
  const step = page.locator('.live-steps li', { hasText: 'npm test -- --grep live' });
  const now = page.locator(`#agent-row-${se.id} .agent-state`);
  await expect(step, 'the running command, live').toHaveCount(1);
  await expect(now, 'the agent’s current step, live').toContainText('npm test');
  // Neither is stored yet: the step waits for a commit point, and the current step goes live only.
  const reply = scripted.app.store.items(t.id).find((i) => i.kind === 'agent');
  expect(reply?.activity?.steps?.some((s) => s.id === 'b1') ?? false, 'the step isn’t stored mid-call').toBe(false);
  expect(scripted.app.store.state.sessions[se.id].currentStep ?? '', 'the current step isn’t stored').not.toContain('npm test');
  // A reload mid-turn: the state’s snapshot of the running turn draws them again.
  await page.reload();
  await synced(page, scripted.app);
  await expect(step, 'the running command after a reload').toHaveCount(1);
  await expect(now, 'the current step after a reload').toContainText('npm test');
  go('fixer');
  await expect(page.locator(`[data-key="${reply?.id}"]`)).toContainText('Done.');
  await expect
    .poll(
      () =>
        scripted.app.store
          .items(t.id)
          .find((i) => i.kind === 'agent')
          ?.activity?.steps?.some((s) => s.id === 'b1'),
      { message: 'stored at the turn’s end' },
    )
    .toBe(true);
});
