// The tester’s scroll (#531): the conversation scrolled as a person does with the keys. The page has no PageUp or End
// handler of its own, so the key is the browser’s own scroll of the box that has focus; the transcript takes focus
// (tabindex -1, app/js/thread.mjs) without moving, since the key does nothing while the composer has it. The input is
// recorded first, so whatever the key does to the view comes after it in facts.probes.inputs.

import { pressKey } from './keys.mjs';

const KEYS = Object.freeze({ up: 'PageUp', down: 'PageDown', end: 'End', start: 'Home' });

/**
 * @param {{ page: any, facts: any, step: number }} ctx  @param {{ by?: string }} a
 * @returns {Promise<string>}  what happened, for the tester
 */
export async function scrollStep({ page, facts, step }, { by }) {
  const key = Object.hasOwn(KEYS, String(by)) ? KEYS[/** @type {keyof typeof KEYS} */ (by)] : null;
  if (!key) throw new Error(`Scroll up, down, end or start, not “${by}”.`);
  facts.probes.inputs.push({ step, at: Date.now(), kind: 'scroll' });
  await page.evaluate(`document.querySelector('#main.transcript')?.focus({ preventScroll: true })`);
  await pressKey(page, key);
  return `Pressed ${key} in the conversation.`;
}
