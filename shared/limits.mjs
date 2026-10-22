// The limits agents must know, in one place. The code that enforces each one reads it from here
// (shared/catalog.mjs for blocks, shared/events.mjs and the app kit for app events), and what agents read
// (server/adapters/guide.mjs, the MCP tool descriptions in server/mcp.mjs) is written from here, so the number
// an agent is told is the number Postbox enforces (#50). tests/limits.test.mjs fails when one isn’t in the guide.

/** Sizes an agent can reach. Text lengths are in characters. */
export const LIMITS = Object.freeze({
  /** An app event’s values as JSON (postbox.send), in bytes. */
  eventBytes: 64 * 1024,
  /** An app’s code (show_app, update_app). */
  appCode: 600_000,
  /** Every block’s plain-text fallback. */
  fallback: 4000,
  /** A choice’s or form’s prompt, and a confirm’s statement. */
  prompt: 2000,
  /** A card’s body. */
  cardBody: 4000,
  /** A code block’s code, and a review’s content and previous. */
  longText: 200_000,
  choiceOptions: 24,
  formFields: 24,
  /** A select field’s options. */
  selectOptions: 50,
  tableColumns: 16,
  tableRows: 5000,
  progressSteps: 60,
  cardFacts: 16,
  cardActions: 3,
});

/** @typedef {keyof typeof LIMITS} LimitName */

/**
 * A limit as agents read it: “64 KB” for a byte size, “5,000” for the rest.
 * @param {LimitName} name  @param {Record<string, number>} [limits]  the limits to read, for tests
 */
export function limitText(name, limits = LIMITS) {
  const n = limits[name];
  return name.endsWith('Bytes') ? `${Math.round(n / 1024).toLocaleString('en-US')} KB` : n.toLocaleString('en-US');
}
