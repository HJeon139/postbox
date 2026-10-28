// The limits agents must know, in one place. The code that enforces each one reads it from here
// (shared/catalog.mjs for blocks, shared/events.mjs and the app kit for app events), and what agents read
// (server/adapters/guide.mjs, the MCP tool descriptions in shared/mcp-tools.mjs) is written from here, so the number
// an agent is told is the number Postbox enforces (#50). tests/limits.test.mjs fails when one isn’t in the guide.

/** Sizes an agent can reach. Text lengths are in characters. */
export const LIMITS = Object.freeze({
  /** An app event’s values as JSON (postbox.send), in bytes. */
  eventBytes: 64 * 1024,
  /** An app’s code (show_app, update_app), inline or from codePath. */
  appCode: 600_000,
  /** Data files one app version carries (show_app and update_app’s files, #54). */
  appFiles: 8,
  /** One of those data files, in bytes. */
  appFileBytes: 20 * 1024 * 1024,
  /** A dataset file an agent loads into the corpus with add_dataset (#47), in bytes. */
  datasetBytes: 50 * 1024 * 1024,
  /** Every block’s plain-text fallback. */
  fallback: 4000,
  /** A choice’s or form’s prompt, and a confirm’s statement. */
  prompt: 2000,
  /** A card’s body. */
  cardBody: 4000,
  /** A result reported on an answered choice, form, confirm or review (#94, #106), and why an agent withdrew one (#106). */
  outcome: 500,
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

/**
 * What agents read of the conversation, rather than what they send (#109). Each cut says where the rest is, so the
 * guide doesn’t list these; read_conversation’s and read_message’s descriptions name them.
 */
export const READING = Object.freeze({
  /** One item in the history at the start of a turn and in read_conversation, before it’s cut. */
  item: 2000,
  /** What one read_message call returns of a long item. */
  part: 40_000,
});

/**
 * What agents send each other and the conversation (#351). Past it a send is refused, and the refusal and the tool
 * descriptions (wake_agent, bring_to_conversation) name it, so the guide doesn’t list it.
 */
export const SENDING = Object.freeze({
  /** A message to another agent with wake_agent, and a post to the conversation with bring_to_conversation. */
  message: 50_000,
});

/** The most characters in the whole-sentence glimpse shown while an agent works (#478). */
export const GLIMPSE_CHARS = 160;

/** Agent wakes in a row, without you, before the next waits for your Allow: 3 until #320 raised it. */
export const HOP_LIMIT = 10;
/** Wakes in a row between the same two agents before the next waits for your Allow (#372): a hand-off and its answer. */
export const PAIR_LIMIT = 2;

/** @typedef {keyof typeof LIMITS} LimitName */

/**
 * A limit as agents read it: “64 KB” or “20 MB” for a byte size, “5,000” for the rest.
 * @param {LimitName} name  @param {Record<string, number>} [limits]  the limits to read, for tests
 */
export function limitText(name, limits = LIMITS) {
  const n = limits[name];
  if (!name.endsWith('Bytes')) return n.toLocaleString('en-US');
  return n >= 1024 * 1024 && n % (1024 * 1024) === 0 ? `${(n / 1024 / 1024).toLocaleString('en-US')} MB` : `${Math.round(n / 1024).toLocaleString('en-US')} KB`;
}

const range = (prefix, n) => Array.from({ length: n }, (_, i) => `--${prefix}${i + 1}`);

/**
 * The chart palettes and status colors in app/workbench.css, and when to use each (#52). Agents read them in the
 * guide and show_app’s description; tests/limits.test.mjs fails when a token here isn’t defined in the stylesheet.
 * @type {readonly { name: string, tokens: string[], for: string, when: string }[]}
 */
export const PALETTES = Object.freeze([
  {
    name: '--s1…--s8',
    tokens: range('s', 8),
    for: 'categories',
    when: 'groups or series with no order between them, one color each, from --s1 on',
  },
  {
    name: '--seq-1…--seq-6',
    tokens: range('seq-', 6),
    for: 'magnitude',
    when: 'counts, scores, density and heatmaps, with --seq-1 the least',
  },
  {
    name: '--div-neg, --div-mid, --div-pos',
    tokens: ['--div-neg', '--div-mid', '--div-pos'],
    for: 'polarity',
    when: 'values either side of a midpoint, such as refutes or supports',
  },
  {
    name: '--good and --alert',
    tokens: ['--good', '--alert'],
    for: 'status only',
    when: 'passed or failed; never for a category, where they read as a verdict',
  },
]);
