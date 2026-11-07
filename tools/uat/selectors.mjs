// How the UAT driver names things in the page. Moved out of tools/uat/driver.mjs, so its review and hosts modules
// share them.

import { js } from '../browser.mjs';

export const ITEM = (key) => `document.querySelector('[data-key=${js(key)}]')`;
// Matches a control by its visible text or its label, since icon buttons (Expand table) have only a label.
export const byText = (scope, sel, text) =>
  `[...(${scope}?.querySelectorAll(${js(sel)}) ?? [])].find((e) => e.offsetParent !== null && (e.textContent + ' ' + (e.getAttribute('aria-label') ?? '')).replace(/\\s+/g, ' ').trim().toLowerCase().includes(${js(String(text).toLowerCase())}))`;
// A message’s thread link (#720): its topic’s, by class, since it reads “Thread” only until the first reply and then
// “1 reply · last reply …”; else “Reply in thread”, before it has a topic. Either opens the thread in the panel.
export const THREAD_LINK = (key) => `(${ITEM(key)}?.querySelector('.msg-actions a.replies') ?? ${byText(ITEM(key), '.msg-actions button', 'Reply in thread')})`;
