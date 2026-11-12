// Whether the page has held still for two frames: its scroll positions and layout, read before and after two frames.
// It runs in the page, so it uses nothing from outside its own body. tests/browser/postbox.mjs’s settled() polls it in
// the browser specs (#298), and PF-1’s key-to-frame tool (tools/key-frame-measure.mjs) waits on it before it types.
// A transcript’s smooth jump to the end that hasn’t ended isn’t still, even if it hasn’t moved yet: a slow machine can
// start the scroll frames after it’s asked for (data-view-moving, app/js/view-publish.mjs, #1238).

/** Resolves true when nothing moved over two frames, and no transcript’s jump to the end is still running. Runs in the page. */
export async function heldStill() {
  const moving = () => document.querySelector('[data-view-moving="to-end"]') !== null;
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
  return !moving() && snap() === before;
}
