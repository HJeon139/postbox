// File types shared by the server and the app. The server serves only these inline (sandboxed, nosniff),
// and the app shows a thumbnail only for these. Everything else downloads and shows as a file chip.

/** Image types shown inline; everything else downloads. */
export const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
