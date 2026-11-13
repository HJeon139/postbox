// The UAT runner’s agent_panel action (#105): an agent’s row in the sidebar’s Agents section, opened and set as a
// person would. Kept out of tools/uat/driver.mjs, to keep that file to its size; it uses the driver’s clickAt and press.

import { js, sleep } from '../browser.mjs';

/**
 * Opens an agent’s quick panel from the sidebar’s Agents section (#105), sets what’s given, and closes it.
 * Returns what the panel said, and what each control was left at.
 * @param {{ ev: (expr: string) => Promise<any>, clickAt: (expr: string, what: string) => Promise<void>, press: (key: string) => Promise<void>, page: any }} kit
 * @param {string} handle  @param {{ model?: string, effort?: string, mode?: string, shell?: boolean }} set
 */
export async function agentPanel({ ev, clickAt, press, page }, handle, set = {}) {
  await clickAt(
    `[...document.querySelectorAll('.agent-btn')].find((b) => b.offsetParent !== null && b.querySelector('.name b')?.textContent === ${js(handle)})`,
    `@${handle}’s row in the Agents section`,
  );
  await page.waitFor(`!!document.querySelector('.dialog [role=radiogroup], .dialog [role=switch]')`, { label: 'the quick panel' });
  try {
    const group = (label) =>
      `[...document.querySelectorAll('.dialog [role=radiogroup]')].find((g) => (g.getAttribute('aria-label') ?? '').toLowerCase().startsWith(${js(label.toLowerCase())}))`;
    for (const [label, value] of [
      ['Model', set.model],
      ['Effort', set.effort],
      ['Permission mode', set.mode],
    ]) {
      if (!value) continue;
      await clickAt(
        `[...(${group(label)}?.querySelectorAll('[role=radio]') ?? [])].find((r) => r.textContent.toLowerCase().includes(${js(String(value).toLowerCase())}))`,
        `“${value}” under ${label}`,
      );
    }
    const shellSwitch = `[...document.querySelectorAll('.dialog [role=switch]')].find((x) => (x.getAttribute('aria-label') ?? '').startsWith('Shell,'))`;
    if (set.shell !== undefined && (await ev(`${shellSwitch}?.getAttribute('aria-checked') === 'true'`)) !== Boolean(set.shell))
      await clickAt(shellSwitch, 'the Shell switch');
    await sleep(400);
    const said = await ev(`document.querySelector('.dialog')?.innerText ?? ''`);
    const left = await ev(`({
      groups: Object.fromEntries([...document.querySelectorAll('.dialog [role=radiogroup]')].map((g) => [g.getAttribute('aria-label'), g.querySelector('[aria-checked=true]')?.textContent.trim() ?? null])),
      switches: Object.fromEntries([...document.querySelectorAll('.dialog [role=switch]')].map((x) => [x.getAttribute('aria-label'), x.getAttribute('aria-checked') === 'true'])),
    })`);
    return { said, left };
  } finally {
    // Closed whatever happened, so the next action starts from the conversation.
    if (await ev(`!!document.querySelector('.dialog')`)) await press('Escape');
  }
}
