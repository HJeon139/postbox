// Whether the page has held still for two frames: its scroll positions and layout, read before and after two frames.
// It runs in the page, so it uses nothing from outside its own body. tests/browser/postbox.mjs’s settled() polls it in
// the browser specs (#298), and PF-1’s key-to-frame tool (tools/key-frame-measure.mjs) waits on it before it types.

/** Resolves true when nothing moved over two frames. Runs in the page. */
export async function heldStill() {
  const snap = () =>
    JSON.stringify([
      scrollX,
      scrollY,
      innerWidth,
      innerHeight,
      document.scrollingElement?.scrollHeight,
      ...[...document.querySelectorAll('.sp-body, #main > *, .working, .jump')].map((n) => {
        const b = n.getBoundingClientRect();
        return [n.scrollTop, Math.round(b.top), Math.round(b.height)];
      }),
    ]);
  const before = snap();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  return snap() === before;
}
