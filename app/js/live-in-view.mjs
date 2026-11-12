// Which agents’ crowded running replies are off screen (designs/rooms-at-scale.md, “Live state”). With eight agents or
// more, an agent’s reply in view says what its working row would, so the row hides (working-rows.mjs, markWorkRow),
// and off screen the row shows. A row starts hidden and shows once its reply is seen off screen, not the other way
// round: the view holds the page’s height when what’s at its end shrinks (view-state.mjs, follow), so a row hiding
// while you follow the end would leave a gap. The browser’s own intersection pass says what’s in view, reading no
// layout, so a step costs none.

/** The agents whose crowded running reply was last seen off screen, by session id. */
const away = new Set();
/** The crowded live blocks watched, each with its session. */
const watched = /** @type {Map<Element, string>} */ (new Map());

/** Whether an agent’s crowded running reply is off screen now. @param {string} sessionId */
export const offScreen = (sessionId) => away.has(sessionId);

// A change shows or hides that agent’s working row, which carries its session while it’s crowded (working-rows.mjs,
// markWorkRow).
const viewer =
  typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          const id = watched.get(e.target);
          if (!id || !e.target.isConnected) continue;
          if (e.isIntersecting) away.delete(id);
          else away.add(id);
        }
        unwatchGone();
        for (const row of document.querySelectorAll('.working .work-row[data-session]')) {
          const r = /** @type {HTMLElement} */ (row);
          r.hidden = !away.has(/** @type {string} */ (r.dataset.session));
        }
      })
    : null;

/** Lets go of the blocks no longer on the page, so watching one never keeps a room’s page alive. */
function unwatchGone() {
  for (const [b, id] of watched)
    if (!b.isConnected) {
      viewer?.unobserve(b);
      watched.delete(b);
      if (![...watched.values()].includes(id)) away.delete(id);
    }
}

/** Watches a crowded running reply’s live block for whether it’s in view. @param {Element} block @param {string} sessionId */
export function watchCrowded(block, sessionId) {
  unwatchGone();
  watched.set(block, sessionId);
  viewer?.observe(block);
}
