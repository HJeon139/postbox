// Holding the page’s `thread` events back, for threads of the kinds a spec names (#887, #926): moved from
// reply-in-thread.spec.mjs, so a spec can make a thread’s event arrive after its address does, on every run.

/**
 * Has the page hold back each `thread` event for a topic thread while holding, then hand them to the page in order on
 * release, numberless, so the events that came after them don’t make the page drop them as already seen.
 * @param {import('@playwright/test').Page} page
 */
export const holdTopics = (page) => holdThreads(page, ['topic']);

/**
 * The same for threads of any of these kinds: `thread` for a conversation, `topic`, `side`.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} kinds
 */
export async function holdThreads(page, kinds) {
  await page.addInitScript((kinds) => {
    const held = [];
    const hold = { on: true, count: () => held.length };
    hold.release = () => {
      hold.on = false;
      for (const deliver of held.splice(0)) deliver();
    };
    Object.assign(window, { heldTopics: hold });
    const add = EventSource.prototype.addEventListener;
    EventSource.prototype.addEventListener = function (type, fn, options) {
      if (type !== 'thread') return add.call(this, type, fn, options);
      const late = (e) => {
        if (hold.on && kinds.includes(JSON.parse(e.data).kind)) held.push(() => fn({ data: e.data, lastEventId: '' }));
        else fn(e);
      };
      return add.call(this, type, late, options);
    };
  }, kinds);
}
/** How many events the page holds. @param {import('@playwright/test').Page} page */
export const heldCount = (page) => page.evaluate(() => /** @type {any} */ (window).heldTopics.count());
/** Lets the held events go, in order. @param {import('@playwright/test').Page} page */
export const release = (page) => page.evaluate(() => /** @type {any} */ (window).heldTopics.release());
