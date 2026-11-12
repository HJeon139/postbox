// The limits agents must know, in one place. The code that enforces each one reads it from here
// (shared/catalog.mjs for blocks, shared/events.mjs and the app kit for app events), and what agents read
// (server/adapters/guide.mjs, the MCP tool descriptions in shared/mcp-tools.mjs) is written from here, so the number
// an agent is told is the number Postbox enforces (#50). tests/limits.test.mjs fails when one isn’t in the guide.

/** The most an app version’s intent keeps, in characters: a cut for storage, past the 16 words agents are asked for. */
export const INTENT_CHARS = 300;

/** Sizes an agent can reach. Text lengths are in characters. */
export const LIMITS = Object.freeze({
  /** An app event’s values as JSON (postbox.send), in bytes. */
  eventBytes: 64 * 1024,
  /** An app’s code (show_app, update_app), inline or from codePath. */
  appCode: 600_000,
  /** What an app version should leave the reader with: one sentence of at most this many words (show_app and update_app’s intent, #995). */
  appIntentWords: 16,
  /** Data files one app version carries (show_app and update_app’s files, #54). */
  appFiles: 8,
  /** One of those data files, in bytes. */
  appFileBytes: 20 * 1024 * 1024,
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
  /** An option’s description, under its label in a choice and after it in a select (#838). */
  optionDescription: 200,
  formFields: 24,
  /** A form field’s label (#455). */
  fieldLabel: 120,
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
  /** The handles one open_topic wakes with its first message (#650). */
  mentions: 16,
});

/**
 * The longest prompt, in UTF-8 bytes, Postbox passes as one command-line argument to a backend that has another way in
 * (#362). Linux refuses one argument past 128 KiB (MAX_ARG_STRLEN) with E2BIG; this leaves room for the rest of the line.
 */
export const ARG_PROMPT_MAX = 100_000;

/**
 * How long a remote turn may wait in silence on a background task before it’s stopped as hung (#847). The longest a
 * Claude Code background Bash call may run (its timeout’s maximum, 7,200,000 ms), so Postbox never stops one first.
 */
export const QUIET = Object.freeze({
  backgroundMax: 2 * 60 * 60 * 1000,
});

/** A persona’s handle (Runtime.createPersona), which a handle an agent sends must match before it’s looked up (#650). */
export const HANDLE = /^[a-z][a-z0-9_-]{1,23}$/i;
/** What HANDLE allows, for a refusal that can’t echo what it was sent: that’s an agent’s text. */
export const HANDLE_SHAPE = 'a handle is 2–24 letters, digits, - or _, and starts with a letter, such as “critic”';

/**
 * What a conversation’s asset store holds (#516 S3, designs/architecture/assets.md, “Assets”). A write past one is refused,
 * naming it. The values marked as drafts are set by the calibration run (#508’s MS-3); the room budget is the person’s
 * draft of 2 November 2026, and the rest have no measured source yet. The asset tools name these when they refuse.
 */
export const ASSETS = Object.freeze({
  /** One version’s bytes. Draft: the largest file an agent sends today, an app data file (LIMITS.appFileBytes). */
  assetBytes: 20 * 1024 * 1024,
  /** Every kept version of a room’s assets, each distinct file counted once. Draft: the person’s 1 GiB. */
  roomBytes: 1024 * 1024 * 1024,
  /** Assets in one room, deleted ones included. Draft. */
  roomAssets: 1000,
  /** Versions of one asset. Draft. */
  assetVersions: 1000,
  /** Assets one list_assets page shows (#516 S3b). */
  listPage: 100,
  /** A name, in UTF-8 bytes. */
  nameBytes: 255,
  /** A write’s op, which agents choose, in characters of letters, digits, - and _. */
  opChars: 64,
  /** A binary version over this is pruned once binaryVersionsKept newer versions exist. Draft. */
  largeBinaryBytes: 1024 * 1024,
  /** Newer versions a large binary version waits for before it’s pruned. Draft. */
  binaryVersionsKept: 3,
});

/**
 * Images a review block carries (#780). server/image-check.mjs refuses an image past either size limit, read from its
 * header; the caller that takes the files refuses one past either byte limit. Each refusal names the limit.
 */
export const REVIEW_IMAGES = Object.freeze({
  /** One image, in bytes. */
  reviewImageBytes: 5 * 1024 * 1024,
  /** Every image one revision of a review carries, in bytes. */
  reviewImagesBytes: 20 * 1024 * 1024,
  /** An image’s width times its height, in pixels: what a browser decodes, whatever the file’s size. 32 megapixels,
   * 32 × 2²⁰, which is 8,192 × 4,096 (#780’s note accepts 8,192 × 4,000). */
  reviewImagePixels: 32 * 1024 * 1024,
  /** Files an item keeps from revisions it replaced (pastFiles), the newest first kept: so an item, and what each
   * update writes, stays bounded however often it changes its figures. */
  reviewPastFiles: 8,
  /** An image’s width or height, in pixels. */
  reviewImageSide: 8192,
});

/**
 * A review block’s threads (#1143): at most REVIEW_THREADS_OPEN open at once, so resolving one frees its place, and
 * REVIEW_THREADS_MAX open and resolved, holding at most REVIEW_THREADS_BYTES of comment text in UTF-8, so one review
 * can’t carry megabytes into every snapshot. Past either of the last two, a new review block takes the text so far.
 */
export const REVIEW_THREADS_OPEN = 200;
export const REVIEW_THREADS_MAX = 1000;
export const REVIEW_THREADS_BYTES = 2 * 1024 * 1024;

/** The most characters in the whole-sentence glimpse shown while an agent works (#478). */
export const GLIMPSE_CHARS = 160;
/** The most streamed text inspected to find that glimpse, bounding work on each update (#478). */
export const GLIMPSE_SOURCE_CHARS = 2000;

/**
 * What a step keeps, in characters: its call’s input in a line, the end of what it returned, and a thought whole, as the
 * live view shows it (app/js/activity-live.mjs); and any other detail, a reason or a result’s note, which is all a
 * thought keeps once its turn ends (shared/step-fold.mjs).
 */
export const STEP_TEXT = Object.freeze({ input: 300, output: 400, thought: 8000, detail: 1200 });

/**
 * Agent wakes in a row, without you, before the next waits for your Allow: a backstop against agents that never stop,
 * until a supervisor agent watches the room (#538). 3 until #320 raised it to 10, 50 since #492, and 1,000 since #1035,
 * after one held wake left every agent in a room waiting about 7.5 hours. It’s the default: each room can set its own
 * (server/room-chain-limit.mjs).
 */
export const DEFAULT_HOP_LIMIT = 1000;
/**
 * The most a room’s chain limit, or POSTBOX_CHAIN_LIMIT, can be (#1035): about a week of wakes at one a minute, so a
 * chain that never ends still stops (designs/intent.md, principle 6).
 */
export const MAX_HOP_LIMIT = 10_000;
/** A count as the person reads it: 1,000. @param {number} n */
const count = (n) => n.toLocaleString('en-US');
/**
 * The server’s default chain limit, which POSTBOX_CHAIN_LIMIT sets, or DEFAULT_HOP_LIMIT when it isn’t set (#508,
 * #1035). The UAT runner sets it for the Postbox it starts, so a scenario’s `- chain-limit: 3` reaches the card in a few
 * wakes. A value that isn’t a whole number from 1 to MAX_HOP_LIMIT is refused, so a mistyped one can’t run as the
 * default and a shell can’t turn the backstop off. Read once, when the module loads, so the check, the card and what
 * agents are told (shared/mcp-tools.mjs) get the same default.
 * @param {string|undefined} value  the variable’s text
 */
export function chainLimit(value) {
  const text = String(value ?? '').trim();
  if (!text) return DEFAULT_HOP_LIMIT;
  if (!/^\d+$/.test(text) || Number(text) < 1 || Number(text) > MAX_HOP_LIMIT)
    throw new Error(`POSTBOX_CHAIN_LIMIT takes a whole number from 1 to ${count(MAX_HOP_LIMIT)}, not “${text}”.`);
  return Number(text);
}
// The browser loads this module too (app/js/composer-to.mjs), where there is no process: it reads the default, and the
// page reads the server’s from /api/state.
export const HOP_LIMIT = chainLimit(globalThis.process?.env?.POSTBOX_CHAIN_LIMIT);
/** What a room’s own chain limit takes (#1035): the server refuses anything else with this, and the dialog shows it. */
export const ROOM_CHAIN_LIMIT_TAKES = `A room’s wake chain limit is a whole number from 1 to ${count(MAX_HOP_LIMIT)}.`;
/** Whether a value is a chain limit a room can have: a whole number from 1 to MAX_HOP_LIMIT, never a string. @param {unknown} v */
export const isRoomChainLimit = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_HOP_LIMIT;
/**
 * Agent wakes in a row, without you, after which the room shows the count with a hint to Stop agents going nowhere
 * (#492), well before the chain limit: E2’s replay found no loop past 2 wakes, and ordinary hand-offs run longer.
 */
export const CHAIN_HINT = 6;
/**
 * The count the hint shows from in a room with that limit: CHAIN_HINT, or the room’s limit when it’s lower, so the hint
 * never names a count past the limit (#1035). @param {number} limit
 */
export const chainHintAt = (limit) => Math.min(CHAIN_HINT, limit);
/** Wakes held on one waiting wake card, delivered or not as the person answers it (#439); past this, they’re refused. */
export const HELD_WAKES = 20;
/** Wakes one agent session may have pending with schedule_wake, not yet fired (#362); past this, it’s refused. */
export const PENDING_WAKES = 20;

/** How long a remote read waits for Postbox before it is answered from the host's snapshot (#582). Kiro gives up a call after 120 s, so the answer has to be there well before. */
export const REMOTE_READ_TIMEOUT_MS = 100_000;

/**
 * How long a permission prompt waits for its call to show in the turn’s stream before it’s refused (#353, #665). The
 * CLI asks between a call’s tool_use line and its result, but the line and the prompt reach Postbox by different pipes
 * (stdout, and HTTP or the host’s link), so the prompt can come first by a moment.
 */
export const PROMPT_CALL_WAIT_MS = 5_000;

/**
 * How long, at most, a host’s permission prompt waits for its turn’s stream to be read up to where the host has it
 * before PROMPT_CALL_WAIT_MS starts (#353, server/remote/turns-replay.mjs), from when the prompt first came; past it,
 * it’s refused as one whose call never showed. A daemon that hangs mid-read, or a link that keeps dropping, never says
 * the read caught up, and the prompt would hold its request open for good. A minute reads a log of the host’s default
 * logMaxBytes (256 MiB) at about 5 MB/s, and stays far under the 10-minute floor of the host’s stallTimeout
 * (shared/remote-settings.mjs), so a held prompt is answered long before its turn could be judged stalled.
 */
export const PROMPT_REPLAY_WAIT_MS = 60_000;

/**
 * Lines a turn shows for its refused permission prompts, one per call, at most (#353, #665); past it, one line counts
 * the rest. A flood of prompts from a command the agent runs stays a few lines.
 */
export const PROMPT_REFUSAL_LINES = 5;

/**
 * Permission prompts a turn holds open at once while each waits for its call’s line (#353, #665), at most; one past it
 * is refused at once. Each held prompt is an open request, so a flood from a command the agent runs holds only a few.
 */
export const PROMPT_HOLDS_MAX = 8;

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
