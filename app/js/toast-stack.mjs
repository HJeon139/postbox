// One bounded stack for notices (#444).

/** Remove a notice. @param {Element} element */
export function removeToast(element) {
  element.remove();
}

/**
 * Put the newest notice first, and evict the oldest past three. The notice just added is never the one evicted, so a
 * blocking alert still shows, and its screen reader announcement isn’t cut off.
 * @param {Element} box @param {Element} element
 */
export function addToast(box, element) {
  box.prepend(element);
  while (box.children.length > 3) {
    const older = [...box.children].reverse().filter((child) => child !== element);
    removeToast(older[0]);
  }
}
