// Which element of an app the runner clicks for a target text (driver.mjs appClick). The deepest element whose text
// contains it: a row that holds a label and its button matches too, and clicking the row’s centre lands on neither
// (needsnav.md phase 3’s run of 4 November, where every click on “Send to @critic” hit an <li>’s empty middle).

import { js } from '../browser.mjs';

/** The tags the runner can click in an app, outermost kinds last. */
export const APP_TARGETS = 'button, a, [role=button], [role=tab], label, summary, option, li, td, text, g';

/**
 * Of the candidates whose text contains `text`, case-insensitively, the first that contains no other match: the button
 * inside a matching row, not the row. O(matches²), over an app’s handful of matches.
 * @param {ArrayLike<{ textContent: string | null, contains: (o: any) => boolean }>} candidates @param {string} text
 */
export function deepestMatch(candidates, text) {
  const want = String(text).toLowerCase();
  const matches = [...candidates].filter((e) => (e.textContent ?? '').trim().toLowerCase().includes(want));
  const holdsAnother = (e) => matches.some((o) => o !== e && e.contains(o));
  return matches.find((e) => !holdsAnother(e)) ?? null;
}

/**
 * The script the runner evaluates in the app’s frame for a target text: it picks the element (deepestMatch), chooses a
 * native dropdown’s option the way a person’s pick ends, and otherwise returns the element’s centre to click.
 * @param {string} text
 */
export function targetScript(text) {
  const choose = `const s = el.closest('select'); s.value = el.value;
    s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: true };`;
  return `(() => {
    const el = (${deepestMatch})(document.querySelectorAll(${js(APP_TARGETS)}), ${js(String(text))});
    if (!el) return null;
    if (el.tagName === 'OPTION') { ${choose} }
    const b = el.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`;
}
