// One bounded stack for ordinary notices and time-limited Undo actions (#444).

const cleanups = new WeakMap();

/** Remove a notice and stop any work it owns. @param {Element} element */
export function removeToast(element) {
  cleanups.get(element)?.();
  cleanups.delete(element);
  element.remove();
}

/** Register work to stop when a notice leaves the stack. @param {Element} element @param {() => void} cleanup */
export function cleanupToast(element, cleanup) {
  cleanups.set(element, cleanup);
}

/**
 * Put the newest notice first. At four, evict the oldest ordinary notice before an Undo; when all are Undos, evict
 * the oldest Undo so the stack remains bounded.
 * @param {Element} box @param {Element} element
 */
export function addToast(box, element) {
  box.prepend(element);
  while (box.children.length > 3) {
    const oldest = [...box.children].reverse();
    removeToast(oldest.find((child) => !cleanups.has(child)) ?? oldest[0]);
  }
}
