// #518: holding a block’s answer on its way, so a test can revise the block before the answer settles.

/** A gate a test opens: wait() resolves once open() is called. */
export function gate() {
  /** @type {() => void} */
  let open = () => {};
  const opened = new Promise((r) => {
    open = () => r(undefined);
  });
  return { open, wait: () => opened };
}

/**
 * Holds a block’s answer on its way: its reply to the page until release(), and, with untilSent, the request itself
 * until send(). @param {import('@playwright/test').Page} page @param {string} threadId @param {string} itemId
 */
export async function holdAct(page, threadId, itemId, { untilSent = false } = {}) {
  const sent = gate();
  const released = gate();
  if (!untilSent) sent.open();
  await page.route(`**/api/threads/${threadId}/items/${itemId}/act`, async (route) => {
    await sent.wait();
    const response = await route.fetch();
    await released.wait();
    await route.fulfill({ response });
  });
  return { send: sent.open, release: released.open };
}
