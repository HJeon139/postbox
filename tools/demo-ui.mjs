// A scene’s prepare steps (tools/demo.mjs, UI) on a page from tools/browser.mjs. Moved out of tools/shoot-app.mjs.

import { js } from './browser.mjs';

/**
 * A scene’s prepare steps (tools/demo.mjs, UI) on the shooter: each waits for the first element a selector finds,
 * then acts on it in the page.
 * @param {any} page  a page from tools/browser.mjs @returns {import('./demo.mjs').UI}
 */
export function demoUI(page) {
  const node = (sel, text) => `[...document.querySelectorAll(${js(sel)})].find((n) => ${text === undefined ? 'true' : `n.textContent.includes(${js(text)})`})`;
  const act = async (sel, text, code) => {
    await page.waitFor(`!!${node(sel, text)}`, { label: `${sel}${text === undefined ? '' : ` with “${text}”`}` });
    await page.evaluate(`(() => { const n = ${node(sel, text)}; ${code}; })()`);
  };
  return {
    click: (sel, text) => act(sel, text, 'n.click()'),
    activate: (sel, text) => act(sel, text, 'n.click()'),
    press: (sel, key) =>
      act(
        sel,
        undefined,
        `n.scrollIntoView({ block: 'center' }); n.focus(); n.dispatchEvent(new KeyboardEvent('keydown', { key: ${js(key)}, bubbles: true }))`,
      ),
    fill: (sel, value) => act(sel, undefined, `n.value = ${js(value)}; n.dispatchEvent(new Event('input', { bubbles: true }))`),
    attach: async (sel, file) => {
      await page.waitFor(`!!document.querySelector(${js(sel)})`, { label: sel });
      const { root } = await page.send('DOM.getDocument', {});
      const { nodeId } = await page.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
      await page.send('DOM.setFileInputFiles', { nodeId, files: [file] });
    },
    scroll: (sel) => act(sel, undefined, `n.scrollIntoView({ block: 'center' })`),
    shows: async (sel, text) => {
      await page.waitFor(`!!${node(sel, text)}?.checkVisibility()`, { label: `${sel}${text === undefined ? '' : ` with “${text}”`} to show` });
    },
  };
}
