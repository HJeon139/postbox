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
// Matches a block’s option as the tester names it (#1750). A chip draws its label and description as separate spans
// (app/js/blocks.mjs), so its text joins them with nothing between, and a name the tester writes as “label — description”
// matches nothing whole. Then the name must start with a chip’s whole label (its `.chip-text > span`, or its whole text
// when it has no description) and “ — ”, and the longest such label wins: “Weekly — …” never picks “Weekly with alerts”,
// and “Daily — with digest — …” picks “Daily — with digest”, not “Daily”. Of two chips with that label, the one whose
// description the name gives wins, since on the page only their descriptions tell them apart.
// A name joined any other way (#1782) matches only when it gives the label and the whole description: a newline or a
// plain space (“Weekly every Monday”), as innerText draws the two spans, a colon, an en dash, a hyphen or an em dash
// with no spaces, so a loose join never guesses from a label alone. A name that is a chip’s whole label picks that chip
// before any match by part of a chip’s text, so “Weekly” never picks “Weekly with alerts” drawn first.
const LOOSE = [' – ', ' - ', ': ', '—', '–', ' '];
export const byOption = (scope, sel, text) => {
  const name = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
  const fold = `.textContent.replace(/\\s+/g, ' ').trim().toLowerCase()`;
  // Whether the name is this label and description, whole, joined by one of the separators.
  const whole = `((o) => o.desc && ${js([' — ', ...LOOSE])}.some((s) => ${js(name)} === o.label + s + o.desc))`;
  const options = `[...(${scope}?.querySelectorAll(${js(sel)}) ?? [])]
    .filter((e) => e.offsetParent !== null)
    .map((e) => ({ e, label: (e.querySelector('.chip-text > span') ?? e)${fold}, desc: e.querySelector('.chip-desc')?${fold} }))`;
  const exact = `${options}.find((o) => o.label === ${js(name)})?.e`;
  // A whole label and description goes before any match by part of a chip’s text, so “Plan: fast” never picks a
  // “Plan: fast mode” drawn first.
  const joined = `${options}.find(${whole})?.e`;
  const labeled = `${options}
    .filter((o) => ${js(name)}.startsWith(o.label + ' — '))
    .sort((a, b) => b.label.length - a.label.length)[0]?.e`;
  return `(${exact} ?? ${joined} ?? ${byText(scope, sel, text)} ?? ${labeled})`;
};
