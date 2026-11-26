// How the UAT driver names things in the page. Moved out of tools/uat/driver.mjs, so its review and hosts modules
// share them.

import { js } from '../browser.mjs';

export const ITEM = (key) => `document.querySelector('[data-key=${js(key)}]')`;
// A jump in the page goes through its own jumpTo, as a link or key there does, so the item it lands on stays put while
// the items it passed draw at their real sizes (#712). The expression awaits: use it inside an async function.
export const JUMP = (el, block) => `(await import('/app/js/view-jump.mjs')).jumpTo(${el}, ${js(block)})`;
// Matches a control by its visible text or its label, since icon buttons (Expand table) have only a label.
export const byText = (scope, sel, text) =>
  `[...(${scope}?.querySelectorAll(${js(sel)}) ?? [])].find((e) => e.offsetParent !== null && (e.textContent + ' ' + (e.getAttribute('aria-label') ?? '')).replace(/\\s+/g, ' ').trim().toLowerCase().includes(${js(String(text).toLowerCase())}))`;
// A message’s thread link (#720): its topic’s, by class, since it reads “Thread” only until the first reply and then
// “1 reply · last reply …”; else “Reply in thread”, before it has a topic. Either opens the thread in the panel.
export const THREAD_LINK = (key) => `(${ITEM(key)}?.querySelector('.msg-actions a.replies') ?? ${byText(ITEM(key), '.msg-actions button', 'Reply in thread')})`;
// Matches a block's option as the tester names it (#1750). A chip draws its label and description as separate spans
// (app/js/blocks.mjs), so its text joins them with nothing between, and a name the tester writes as “label — description”
// matches nothing whole. Then the part before the first “ — ” must equal a chip's label exactly (its `.chip-text > span`,
// or its whole text when it has no description), so “Weekly — …” never picks “Weekly with alerts”.
export const byOption = (scope, sel, text) => {
  const head = String(text).split(' — ')[0].trim();
  if (!head || head === String(text).trim()) return byText(scope, sel, text);
  const label = `[...(${scope}?.querySelectorAll(${js(sel)}) ?? [])].find((e) => e.offsetParent !== null && ((e.querySelector('.chip-text > span') ?? e).textContent).replace(/\\s+/g, ' ').trim().toLowerCase() === ${js(head.toLowerCase())})`;
  return `(${byText(scope, sel, text)} ?? ${label})`;
};
