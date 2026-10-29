// The protocol’s version, its limits and its fixed names: harnesses, tool routes, error codes and the host’s files
// (shared/remote-protocol.mjs, whose header is the contract). Only values live here, so every other part imports them.

import { LIMITS, READING } from './limits.mjs';
import { defaultHostSettings, PATH_BYTES } from './remote-settings.mjs';

/** Bumped on any change a peer of the previous version would refuse or misread. */
export const PROTOCOL_VERSION = 2;

/** How long the daemon lets the host’s signInCheck run before it kills it and answers that the check failed. */
export const SIGN_IN_CHECK_MS = 30_000;

const KiB = 1024;
const MiB = 1024 * KiB;

/** Sizes the protocol enforces. Bytes are UTF-8 bytes, characters are UTF-16 code units, as `.length` counts them. */
export const REMOTE_LIMITS = Object.freeze({
  /** One encoded message, on any channel, without its \n. */
  lineBytes: 16 * MiB,
  /**
   * A turn’s tool calls waiting for Postbox on the host (sent, not yet answered), and their encoded bytes in all, at
   * most: past either, the host refuses the next call rather than keep it, as it would while Postbox is away. And a
   * turn’s record of its calls (tools.jsonl), which a daemon reads whole when it restarts.
   */
  waitingCalls: 256,
  waitingCallBytes: 64 * MiB,
  callRecordBytes: 256 * MiB,
  /** One out.jsonl or in.jsonl line as text; a longer one is sent cut (see the header). A `write` line too. */
  streamLineBytes: 8 * MiB,
  /** Linux’s limit on one argument (MAX_ARG_STRLEN, 128 KiB with its NUL). */
  argBytes: 128 * KiB - 1,
  args: 4096,
  /** All of argv together, well inside ARG_MAX with the environment. */
  argvBytes: 1 * MiB,
  envVars: 64,
  envNameChars: 128,
  envValueBytes: 32 * KiB,
  /** A path on the host (PATH_MAX, less its NUL), as remote-settings.mjs’s checkHostPath measures it. */
  pathBytes: PATH_BYTES,
  /** Files one `start` carries. */
  files: 8,
  fileBytes: 4 * MiB,
  filesBytes: 8 * MiB,
  /**
   * The person’s files one `start` carries (start.attachments), and their size as decoded bytes, one and in all. They
   * go as base64, a third larger, so a start with files, argv and env at their limits (8 + 1 + 2 MiB) and attachments
   * at theirs (4/3 of 3.5 MiB, under 4.7) still fits in lineBytes.
   */
  attachments: 16,
  attachmentBytes: 3 * MiB,
  attachmentsBytes: 3.5 * MiB,
  /** An error’s or a problem’s message, and a permission denial’s. */
  messageChars: LIMITS.prompt,
  problems: 32,
  /** A snapshot item’s line, as read_conversation shows it: READING.item plus the note on where the rest is. */
  snapshotLineChars: READING.item + 300,
  /** A snapshot item’s full text, as read_message reads it. */
  snapshotTextChars: 1_000_000,
  snapshotThreads: 64,
  snapshotItems: 20_000,
  /** A `reply`’s text, such as a corpus search’s results. */
  replyChars: 1_000_000,
  /** Paths a harness was looked for in. */
  looked: 32,
  turns: 10_000,
});

/** The host settings the daemon enforces, so the only ones `hello.settings` may carry. */
export const HOST_ENFORCED = Object.freeze(
  /** @type {const} */ ([
    'permissionWaitMax',
    'idleTimeout',
    'logRetention',
    'logMaxBytes',
    'nodePath',
    'claudePath',
    'kiroPath',
    'codexPath',
    'detach',
    'signInCheck',
  ]),
);

/** What the host does when Postbox doesn’t say: remote-settings.mjs’s defaults for HOST_ENFORCED. */
export const HOST_DEFAULTS = Object.freeze(Object.fromEntries(HOST_ENFORCED.map((k) => [k, defaultHostSettings()[k]])));

/** The harnesses a host can run, by the adapter’s `name`. */
export const HARNESSES = Object.freeze(/** @type {const} */ (['claude-code', 'kiro-cli', 'codex']));
/** @typedef {typeof HARNESSES[number]} Harness */

/** How a turn’s stdin is fed (the design’s “A turn doesn’t depend on anything staying connected”). */
export const STDIN_KINDS = Object.freeze(/** @type {const} */ (['file', 'none', 'held']));

/**
 * Where each Postbox tool is answered on the host: `host` by the daemon itself (from the snapshot, or the shim’s
 * blocking permission prompt), `queue` returns at once and crosses to Postbox as a `tool`, `ask` crosses as a `tool`
 * and the shim waits for Postbox’s `reply` (an error at once when Postbox isn’t connected). Every tool in
 * shared/mcp-tools.mjs’s TOOL_DEFS is here; tests/remote-protocol.test.mjs checks it.
 */
export const TOOL_ROUTES = Object.freeze({
  show_block: 'queue',
  update_block: 'queue',
  // Its comments go on another agent’s review block, which only Postbox has, and a refusal says what to fix, so it waits.
  review_block: 'ask',
  show_app: 'queue',
  update_app: 'queue',
  retire_app: 'queue',
  define_term: 'queue',
  // A second call with the same emoji takes it back, so only Postbox’s answer says which it was, and its refusals (no
  // such item, two blocks with that id) name what to fix, as review_block’s do: it waits.
  react: 'ask',
  propose_agent: 'queue',
  // Its answer carries the wake’s id, which only Postbox has, for cancel_wake; both wait (#458).
  schedule_wake: 'ask',
  cancel_wake: 'ask',
  // Postbox may send it, hold it on a waiting card or refuse it, and only its answer says which (#439), so it waits.
  wake_agent: 'ask',
  // Whether it may post depends on the thread and who started the turn, which only Postbox knows, so it waits for the answer.
  bring_to_conversation: 'ask',
  ask_for_tool: 'queue',
  corpus_search: 'ask',
  // It loads the dataset into Postbox’s corpus and says how it went, so it waits like a search.
  add_dataset: 'ask',
  read_conversation: 'host',
  read_message: 'host',
  permission_prompt: 'host',
});

/** Codes an `error` carries. Peers branch on these, never on the message. */
export const ERROR_CODES = Object.freeze(
  /** @type {const} */ ([
    'bad-message', // a line that wasn’t JSON or wasn’t a valid message
    'not-ready', // a message before a successful hello
    'bad-token',
    'version',
    'busy', // another Postbox drives this daemon
    'taken-over', // to the Postbox another one replaced
    'root', // the daemon refuses to run as root
    'no-turn',
    'turn-exists',
    'turn-ended', // a shim or write for a turn that has ended
    'turn-stopped', // a start for a turn this daemon was asked to stop before it had it
    'no-harness', // the harness wasn’t found on the host
    'start-failed',
    'bad-offset', // read.from isn’t 0, a line’s start or the file’s size
    'not-held', // a write to a turn whose stdin isn’t held
    'no-prompt', // an answer to a prompt that isn’t waiting
    'no-tool', // a reply to a tool that isn’t queued
    'disconnected', // to the shim: an asked tool while Postbox isn’t connected
    'no-node', // the host has no Node 22 or later to run the daemon (the `host` launcher, or the daemon’s own check)
    'no-check', // a `check` when the driver’s hello sent no signInCheck
    'internal',
  ]),
);

// ── The host’s files ────────────────────────────────────────────────────────────────

/** The daemon’s root, under the host user’s home. */
export const REMOTE_DIR = '.postbox-remote';

/** A turn folder’s own files. Postbox can’t send a file with one of these names. */
export const TURN_FILES = Object.freeze({
  /** The harness’s stdout, appended. */
  out: 'out.jsonl',
  /** Each line the runner wrote to a held stdin. */
  in: 'in.jsonl',
  /** The harness’s stderr, appended. */
  err: 'err.log',
  /** How the harness ended: ExitRecord. Its presence means the turn is finished. */
  exit: 'exit.json',
  /** The runner: RunnerRecord, written before the harness starts. */
  runner: 'runner.json',
  /** What the runner starts: StartRecord, written by the daemon before it launches the runner. */
  start: 'start.json',
  /** The runner’s Unix socket. */
  socket: 'sock',
  /** The turn’s own token, which its shims prove in their hello (#120): written by the daemon before start.json. */
  shimToken: 'shim.token',
  /** The conversation snapshot the reading tools answer from. */
  snapshot: 'snapshot.json',
  /** The daemon’s queue of prompts and tool calls for Postbox. */
  prompts: 'prompts.jsonl',
  tools: 'tools.jsonl',
});

/** The turn’s message, one stream-json user message, which a `file` stdin reads. Sent in `start.files`. */
export const MESSAGE_FILE = 'message.jsonl';

/** The folder in a turn’s folder that `start.attachments` land in, each as `attachments/<name>`. */
export const ATTACHMENTS_DIR = 'attachments';

/** Folders under REMOTE_DIR are created with this mode, files with FILE_MODE (the design’s “Security”). */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Linux’s sun_path is 108 bytes, with its NUL. */
export const SOCKET_PATH_BYTES = 107;
