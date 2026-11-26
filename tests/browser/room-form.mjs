// The room’s form in the main menu, as a spec reaches it from the top bar’s Manage button (#1735): its Members list,
// an agent’s row there, and the way from a picked agent to its queued messages.

/** The main menu, on the room’s form. @param {import('@playwright/test').Page} page */
export const roomForm = (page) => page.getByRole('dialog', { name: 'Settings' });

/** The form’s Members list. @param {import('@playwright/test').Page} page */
export const members = (page) => roomForm(page).getByRole('listbox', { name: /^Members of / });

/** An agent’s row in Members. @param {import('@playwright/test').Page} page @param {string} handle */
export const member = (page, handle) =>
  members(page)
    .getByRole('option')
    .filter({ has: page.locator('b', { hasText: new RegExp(`^@${handle}$`) }) });

/**
 * Picks an agent in Members, and answers the bar’s button to its queued messages, which shows while it has any.
 * @param {import('@playwright/test').Page} page @param {string} handle
 */
export async function memberQueue(page, handle) {
  await member(page, handle).click();
  return roomForm(page).getByRole('button', { name: new RegExp(`^\\d+ messages? queued for ${handle}$`) });
}
