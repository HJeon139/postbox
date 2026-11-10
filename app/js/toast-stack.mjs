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
 * Put the newest notice first. At four, evict the oldest ordinary notice before an Undo; when the rest are all Undos,
 * evict the oldest Undo, so the stack remains bounded. The notice just added is never the one evicted: a blocking alert
 * behind three Undos still shows, and its screen reader announcement isn’t cut off.
 * @param {Element} box @param {Element} element
 */
export function addToast(box, element) {
  box.prepend(element);
  while (box.children.length > 3) {
    const older = [...box.children].reverse().filter((child) => child !== element);
    removeToast(older.find((child) => !cleanups.has(child)) ?? older[0]);
  }
}
