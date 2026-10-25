// The UAT runner’s go_to_needs action (#285, #320): the top bar’s “Next that needs you” button, or an agent’s needs-you
// ring wherever it shows, clicked as a person would, and where focus landed. Kept out of tools/uat/driver.mjs and
// tools/uat-run.mjs, to keep those files to their size; it uses the driver’s clickAt and press.

import { needsAt } from '../../server/room-checks-needs.mjs';
import { js, sleep } from '../cdp.mjs';

/**
 * Clicks the place named and returns where focus landed a moment later: the item it’s in, whether that’s on screen
 * and outlined, and the page before and after.
 * @param {any} d  the driver  @param {any} page  @param {'next'|'rail'|'agents'|'message'} from  @param {string} handle
 */
export async function goToNeeds(d, page, from, handle = '') {
  const ev = (expr) => page.evaluate(expr);
  const ring = (scope) => `[...document.querySelectorAll(${js(`${scope} pb-ring[name="@${handle}"]`)})].filter((r) => r.offsetParent !== null).at(-1)`;
  await ev('document.activeElement?.blur?.()');
  const target = {
    next: [`document.getElementById('next-needs')`, 'the “Next that needs you” button'],
    rail: [ring('.rail a.row'), `@${handle}’s ring in its conversation’s rail row`],
    agents: [ring('.rail .agent-line'), `@${handle}’s ring in its Agents-section row`],
    message: [ring('#main .who'), `the ring beside @${handle}’s newest message`],
  }[from];
  if (!target) throw new Error(`go_to_needs goes from next, rail, agents or message, not “${from}”.`);
  const before = await ev('location.hash');
  await d.clickAt(target[0], target[1]);
  const landed = `(() => {
    const item = document.activeElement?.closest?.('[data-key]');
    if (!item) return null;
    const b = item.getBoundingClientRect();
    return { key: item.dataset.key, onScreen: b.bottom > 0 && b.top < innerHeight && b.height > 0, outlined: item.classList.contains('arrived') };
  })()`;
  let at = null;
  for (let end = Date.now() + 3000; Date.now() < end && !at; ) {
    at = await ev(landed);
    if (!at) await sleep(100);
  }
  // A ring that opened a dialog instead (an agent’s quick panel) is closed, so the next action starts from the page.
  const dialog = await ev(`!!document.querySelector('.backdrop .dialog')`);
  if (dialog) await d.press('Escape');
  return { before, after: await ev('location.hash'), landed: at, dialog };
}

/**
 * The runner’s step: who needed you just before the click (from Postbox’s state), the click, and what to tell the tester.
 * @param {{ d: any, page: any, api: (p: string) => Promise<any>, keys: Map<string, string>, facts: any, step: number }} ctx  @param {any} a  the action
 */
export async function goToNeedsStep({ d, page, api, keys, facts, step }, a) {
  const from = a.from ?? 'next';
  const handle = String(a.target ?? '').replace(/^@/, '');
  const st = (await api('/api/state')).state;
  const r = await goToNeeds(d, page, from, handle);
  facts.probes.jumps.push({ step, at: Date.now(), from, handle, expect: needsAt(st, r.before), ...r });
  const item = r.landed && [...keys].find(([, k]) => k === r.landed.key)?.[0];
  return r.landed
    ? `Focus landed in ${item ?? 'an item not listed yet'}${r.landed.onScreen ? '' : ', off screen'}${r.landed.outlined ? ', outlined' : ', not outlined'}. The page is at ${r.after}.`
    : `Focus didn’t land in any message or block${r.dialog ? '; a dialog opened, and was closed' : ''}. The page is at ${r.after}.`;
}
