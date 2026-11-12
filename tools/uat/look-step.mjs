// The tester’s look while agents work (an interrupt {after, do: look}). A step can’t see a running turn, since the run
// waits for the agents before each one. This gives the tester what a person sees mid-turn: a screenshot, and the
// conversation’s last items as text, in the order it shows them, each running reply’s live view whole
// (app/js/activity-live.mjs). It presses nothing.

import { join } from 'node:path';

// How many of the conversation’s last items it reads, and the most of a running reply and of any other item.
const ITEMS = 12;
const LIVE = 1500;
const OTHER = 160;

/** @param {{ d: any, shots?: string, step?: number }} ctx */
export async function lookStep({ d, shots, step }) {
  const file = shots ? await d.shotScreen(join(shots, `look-${step}.png`)) : null;
  /** @type {{ live: boolean, text: string }[]} */
  const items = await d.kit.ev(
    `[...document.querySelectorAll('#main.transcript > [data-key]')].slice(-${ITEMS}).map((n) => ({ live: !!n.querySelector('.live-steps'), text: n.innerText.trim() }))`,
  );
  const lines = (items ?? []).map((it) => (it.live ? `Running: ${it.text.slice(0, LIVE)}` : `Posted: ${it.text.replace(/\s+/g, ' ').slice(0, OTHER)}`));
  return [`You looked while the agents worked${file ? ` (screenshot ${file})` : ''}. The conversation’s last items, in order:`, ...lines].join('\n');
}
