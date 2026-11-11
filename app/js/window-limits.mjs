// The transcript window’s sizes (#866), shared by window.mjs and window-shrink.mjs.

/**
 * The fewest and most items a conversation mounts when it opens. The page’s size is bounded by elements too, which can
 * stop a range short of either (window-cost.mjs).
 */
export const FLOOR = 40;
export const CEILING = 240;
/** How far past the view, in view heights, the range reaches on each side. */
export const MARGIN = 2;
/** The fewest items a growth mounts at once. */
export const CHUNK = 10;
