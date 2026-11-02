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
  /**
   * A message that @-mentions the agent, in that history, before it’s cut (#499). Agents asked for one cut at item to be
   * sent again rather than read the rest. Under half the summary’s cap on mentions (MENTION_CHARS), so two fit whole.
   */
  mention: 15_000,
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
/** The most streamed text inspected to find that glimpse, bounding work on each update (#478). */
export const GLIMPSE_SOURCE_CHARS = 2000;

/**
 * Agent wakes in a row, without you, before the next waits for your Allow: a backstop against agents that never stop,
 * until a supervisor agent watches the room (#538). 3 until #320 raised it to 10, and 50 since #492.
 */
export const DEFAULT_HOP_LIMIT = 50;
/**
 * The chain limit POSTBOX_CHAIN_LIMIT asks for, or the default when it isn’t set (#508). The UAT runner sets it for the
 * Postbox it starts, so a scenario’s `- chain-limit: 3` reaches the card in a few wakes. It can only lower the limit: a
 * value that isn’t a whole number from 1 to 50 is refused, so a mistyped one can’t run as 50 and a shell can’t turn the
 * backstop off. Read once, when the module loads: every reader of HOP_LIMIT,
 * the one that enforces it (server/side-threads.mjs) and the one agents read (shared/mcp-tools.mjs), gets the same number.
 * @param {string|undefined} value  the variable’s text
 */
export function chainLimit(value) {
  const text = String(value ?? '').trim();
  if (!text) return DEFAULT_HOP_LIMIT;
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > DEFAULT_HOP_LIMIT)
    throw new Error(`POSTBOX_CHAIN_LIMIT takes a whole number from 1 to ${DEFAULT_HOP_LIMIT}, not “${text}”.`);
  return Number(text);
}
// The browser loads this module too (app/js/composer-to.mjs), where there is no process: it reads the default.
export const HOP_LIMIT = chainLimit(globalThis.process?.env?.POSTBOX_CHAIN_LIMIT);
/**
 * Agent wakes in a row, without you, after which the room shows the count with a hint to Stop agents going nowhere
 * (#492), well before the chain limit: E2’s replay found no loop past 2 wakes, and ordinary hand-offs run longer.
 */
export const CHAIN_HINT = 6;
/** Wakes held on one waiting wake card, delivered or not as the person answers it (#439); past this, they’re refused. */
export const HELD_WAKES = 20;

/** How long a remote read waits for Postbox before it is answered from the host's snapshot (#582). Kiro gives up a call after 120 s, so the answer has to be there well before. */
export const REMOTE_READ_TIMEOUT_MS = 100_000;

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
