// One bounded stack for notices (#444).

/** Remove a notice. @param {Element} element */
export function removeToast(element) {
  element.remove();
}

let watching = false;
/**
 * Says on the stack, from its first notice on, whether a sheet is open over the page: the stylesheet shows one notice
 * then (designs/intent.md, the notifications row). A class set here, not `body:has(> .backdrop)` in the stylesheet:
 * with that selector on the body, follow() forced 4 to 11 layouts over 50 replies on a slow machine, where it forces 0
 * to 3 (#1047, tests/browser/gap-read-cost.spec.mjs).
 * @param {Element} box
 */
function watchSheets(box) {
  if (watching) return;
  watching = true;
  const mark = () => box.classList.toggle('over-sheet', !!document.querySelector('body > .backdrop:not(.anchored)'));
  new MutationObserver(mark).observe(document.body, { childList: true });
  mark();
}

/**
 * Put the newest notice first, and evict the oldest past three. The notice just added is never the one evicted, so a
 * blocking alert still shows, and its screen reader announcement isn’t cut off.
 * @param {Element} box @param {Element} element
 */
export function addToast(box, element) {
  watchSheets(box);
  box.prepend(element);
  while (box.children.length > 3) {
    const older = [...box.children].reverse().filter((child) => child !== element);
    removeToast(older[0]);
  }
}
