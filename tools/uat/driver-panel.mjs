// The UAT runner’s agent_panel action (#105, #1315): an agent’s row in the sidebar’s Agents section opens its persona
// sheet in Settings, where the runner sets what the tester gives, saves, and closes Settings, as a person would. Kept
// out of tools/uat/driver.mjs, to keep that file to its size; it uses the driver’s clickAt and press.

import { js, sleep } from '../browser.mjs';

/** What the sheet’s fields hold now: Backend as its option says it, Model as typed, Effort’s level, and Permissions. */
const HELD = `(() => {
  const d = document.querySelector('.dialog');
  return {
    backend: document.getElementById('pe-b')?.selectedOptions[0]?.textContent.trim() ?? null,
    model: document.getElementById('pe-m')?.value ?? null,
    effort: document.getElementById('pe-e')?.value ?? null,
    mode: d?.querySelector('[role=radiogroup][aria-label="Permissions"] [aria-checked=true]')?.textContent.trim() ?? null,
  };
})()`;

/**
 * Picks an option in one of the sheet’s dropdowns by its level or its words: an exact match first, so “high” is High
 * and not Extra high. A dropdown’s own list can’t be clicked through the page, so it’s set and told, as a pick tells it.
 * @param {(expr: string) => Promise<any>} ev @param {string} id @param {string} value @param {string} what
 */
async function pick(ev, id, value, what) {
  const v = String(value).trim().toLowerCase();
  const ok = await ev(`(() => {
    const s = document.getElementById(${js(id)});
    if (!s) return false;
    const opts = [...s.options].filter((o) => !o.disabled);
    const words = (o) => o.textContent.trim().toLowerCase();
    const o = opts.find((o) => o.value === ${js(v)} || words(o) === ${js(v)}) ?? opts.find((o) => words(o).includes(${js(v)}));
    if (!o) return false;
    s.focus();
    s.value = o.value;
    s.dispatchEvent(new Event('input', { bubbles: true }));
    s.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!ok) throw new Error(`The sheet’s ${what} has no option “${value}” that can be picked.`);
  await sleep(300);
}

/**
 * Opens an agent’s persona sheet from its row in the Agents section, sets what’s given (the backend first, since it
 * resets the model and effort), saves, and closes Settings. Returns what the sheet said, and in `left` what it held
 * when Save was pressed, whether it saved, what Postbox said, and the agent’s row after.
 * @param {{ ev: (expr: string) => Promise<any>, clickAt: (expr: string, what: string) => Promise<void>, press: (key: string) => Promise<void>, page: any }} kit
 * @param {string} handle  @param {{ backend?: string, model?: string, effort?: string, mode?: string, shell?: boolean }} set
 */
export async function agentPanel({ ev, clickAt, press, page }, handle, set = {}) {
  const row = `[...document.querySelectorAll('.agent-btn')].find((b) => b.offsetParent !== null && b.querySelector('.name b')?.textContent === ${js(handle)})`;
  await clickAt(row, `@${handle}’s row in the Agents section`);
  await page.waitFor(`!!document.getElementById('pe-d')`, { label: `@${handle}’s persona sheet` });
  let said = '';
  /** @type {any} */
  let held = {};
  let outcome = '';
  try {
    if (set.backend) await pick(ev, 'pe-b', set.backend, 'Backend');
    if (set.model) {
      const field = `document.getElementById('pe-m')`;
      await clickAt(field, 'the Model field');
      await ev(`${field}?.select()`);
      await page.send('Input.insertText', { text: String(set.model).trim() });
      // Leaving the field is what commits it, as it is for a person.
      await press('Tab');
      await sleep(300);
    }
    if (set.effort) await pick(ev, 'pe-e', set.effort, 'Effort');
    if (set.mode)
      await clickAt(
        `[...(document.querySelector('.dialog [role=radiogroup][aria-label="Permissions"]')?.querySelectorAll('[role=radio]') ?? [])].find((r) => r.textContent.toLowerCase().includes(${js(String(set.mode).toLowerCase())}))`,
        `“${set.mode}” under Permissions`,
      );
    const shell = `[...document.querySelectorAll('.dialog button.chip')].find((b) => b.textContent.trim() === 'shell')`;
    if (set.shell !== undefined && (await ev(`${shell}?.getAttribute('aria-pressed') === 'true'`)) !== Boolean(set.shell))
      await clickAt(shell, 'the shell tool');
    said = await ev(`document.querySelector('.dialog')?.innerText.replace(/\\n{3,}/g, '\\n\\n').slice(0, 2500) ?? ''`);
    held = await ev(HELD);
    await clickAt(`[...document.querySelectorAll('.dialog button.btn.send')].find((b) => b.textContent.trim() === 'Save')`, 'Save');
    // Saved, it says so in a toast and goes back to the list; refused, it says why.
    for (let i = 0; i < 25 && !outcome; i++) {
      outcome = await ev(
        `[...document.querySelectorAll('.toast')].map((t) => t.innerText.replace(/\\s+/g, ' ').trim()).find((t) => /^(Saved|Couldn’t save)/.test(t)) ?? ''`,
      );
      if (!outcome) await sleep(200);
    }
  } finally {
    // Closed whatever happened, so the next action starts from the conversation.
    if (await ev(`!!document.querySelector('.dialog')`)) await press('Escape');
  }
  await sleep(300);
  const after = await ev(`${row}?.innerText.replace(/\\s+/g, ' ').trim() ?? null`);
  return { said, left: { ...held, saved: outcome.startsWith('Saved'), outcome: outcome || '(Postbox said nothing)', row: after } };
}
