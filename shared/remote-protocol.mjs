// The contract between Postbox on the laptop and its daemon on a remote host (#120): the JSON lines spoken over the
// SSH channel’s stdio, over the daemon’s Unix socket (the shim) and over each runner’s Unix socket, and the layout of a
// turn’s folder on the host. Every message is validated where it enters a process, on both machines, by the validators
// here, so a message that one side builds and the other refuses is a bug in this file, not in either side. The design
// is architecture.md, “Remote hosts” (sections “The daemon”, “Postbox and the daemon”, “Postbox’s tools on the host”,
// “Permission prompts while nobody is connected”, “Files and cleanup”).
//
// It ships to the host with the daemon, so it imports only shared/, and like the rest of shared/ it imports no node:
// module at all: bytes are counted and decoded with the global TextEncoder and TextDecoder.
//
// Choices the design left open, decided here:
// - Framing: one JSON object per line, ended by \n, UTF-8. Every message has a `type`. A field the type doesn’t name is
//   refused, as is an unknown type, so a typo fails at the boundary instead of being ignored. The exception is a
//   permission request (`permission.request`, `prompt.request`): Claude Code owns its fields, so one it adds passes.
//   A line over REMOTE_LIMITS.lineBytes, invalid UTF-8, bad JSON or a refused message is reported as an error and
//   skipped; the reader carries on with the next line.
// - Messages on one channel are handled in the order they arrive, so Postbox may send `read` right after `start`.
// - `version` in `hello` is PROTOCOL_VERSION, an integer, not Postbox’s package version; a mismatch is the `version`
//   error. The package version names the code folder (`~/.postbox-remote/<version>/`), which keeps the repo’s layout
//   (server/remote/host/, shared/) so the host code’s relative imports work unchanged.
// - One token for all versions, at `~/.postbox-remote/token`, since a turn can outlive the daemon that started it. The
//   shim and the runners read it from that file, never from arguments, which other users can read through /proc.
// - Turn folders are `~/.postbox-remote/turns/<turn>/`, shared by every version; runner.json names the version that
//   started the turn. A turn ID is at most 36 characters (a UUID fits) and the runner’s socket is named `sock`, so its
//   path fits in Linux’s 108-byte sun_path for a home folder of up to 43 bytes; the daemon checks with socketPathFits.
// - `argv` is the harness’s arguments without the program: the daemon runs the program it found for `harness` (or the
//   path in `settings`’ claudePath, kiroPath or codexPath), so Postbox can only start a harness the daemon reported.
// - `files` are text (UTF-8) and land in the turn folder, mode 0600; their names are plain names that aren’t one of the
//   folder’s own files. A `file` stdin is the turn’s message file, message.jsonl, which `files` must carry. The one file
//   that belongs elsewhere is a Kiro agent file, `start.agentFile` (name and text only): the daemon puts it in the
//   agents folder of the Kiro home the runner will use, from start.env’s KIRO_HOME, its own, or ~/.kiro.
// - `env` names are checked for shape only. Which names may go is the adapter’s `capabilities.remote.env`, checked on
//   the laptop; the token holder already runs any argv as the host’s user, so a list here would protect nothing.
// - `welcome` gives the daemon’s home folder, so Postbox can build absolute paths (the default `~/postbox-work/<handle>`
//   folder, the shim’s path for `--mcp-config`) without the host’s shell expanding `~`. It also lists every turn folder
//   it found, with its state, so a restarted Postbox knows what to replay.
// - Offsets are byte offsets into out.jsonl (or in.jsonl, `log: 'in'`, for rebuilding a Codex turn). A `line` carries
//   its own offset and `next`, the offset just past its \n; `ack.upTo` and a later `read.from` are a `next`. A last line
//   with no \n is sent only once the turn has ended, with `next` equal to the file’s size. A line over
//   REMOTE_LIMITS.streamLineBytes, or whose `line` message would encode to over lineBytes, is sent with `cut: true` and
//   empty text, so the stream moves on and the adapter can say a line was lost.
// - `ended` follows a turn’s last line on a `read` that’s following it, once per `read`; `exit` is null for an
//   interrupted turn (no live runner and no exit.json).
// - `caught-up` follows a `read`’s first pass, once per `read`: it has sent every line the log had when that pass
//   reached the file’s end, and `size` is the offset past the last of them (the file’s size then, less a last line
//   still without its \n). A peer rebuilding from both logs (Codex) knows from it when it has seen what was there.
// - The conversation snapshot is `snapshot` (the whole thing, replacing any before) and `snapshot-items` (items added or
//   changed, by ID, in one thread). Each item carries the line read_conversation shows and the full text read_message
//   reads, both already worded by Postbox, so the daemon only pages them. Postbox sends `snapshot` before `start`, so
//   the reading tools never find it missing; the daemon keeps it for that turn ID until `start` writes it to the folder.
// - A shim tool call crosses to Postbox as `tool` unless the daemon answers it itself (TOOL_ROUTES). Postbox answers
//   every `tool` with `reply`: for a queued tool it’s the acknowledgement (the shim already returned), for an asked one
//   the daemon passes its text to the shim. The daemon resends unreplied tools and unanswered prompts after each
//   `hello`, so Postbox treats each as an identity and applies it once. prompts.jsonl and tools.jsonl in
//   the turn folder are reserved for that queue, so it survives a daemon restart.
// - A prompt’s or a tool call’s identity is (turn, id), never the ID alone: each turn’s shim picks its own `call` and
//   `permission` IDs, so two turns may both use 1. The daemon keys its pending prompts and tools by both, and every
//   message to or from Postbox that names one (`tool`, `prompt`, `prompt-expired`, `answer`, `reply`) carries `turn`.
// - A second Postbox gets `busy` unless its hello says `takeover`; the one it replaces gets `taken-over`.
// - A `stop` for a turn the daemon doesn’t have answers `no-turn`, and from then on a `start` for that turn is refused
//   with `turn-stopped`, on any connection: a start written to a channel that dropped may still reach the daemon after
//   the stop sent on the next one. A stop that comes while its turn’s start is under way waits for that start to
//   answer, and the start launches nothing if its runner hadn’t launched yet. So `no-turn` to a stop means the turn
//   won’t run there. The daemon keeps this in memory only: a restart ends the old channels too.
// - Settings that the host enforces (HOST_ENFORCED) go in `hello.settings`, with remote-settings.mjs’s names, units
//   and ranges; HOST_DEFAULTS applies to any not sent. The rest of a host’s settings stay on the laptop.
// - `check` asks the daemon to run the host’s sign-in check, the signInCheck its driver’s hello sent, as an argument
//   list with no shell and no stdin, for at most SIGN_IN_CHECK_MS; `checked` says how it exited (ok is exit code 0;
//   code is null when it couldn’t start, was killed or ran out of time). One `checked` answers each `check`, in the
//   order they came; a hello with no signInCheck gets the `no-check` error instead. Postbox uses it to resume after
//   Sign-in needed only when the check passes (D2), and to warn before a turn.

import { LIMITS, READING } from './limits.mjs';
import { checkHostPath, checkHostSettings, defaultHostSettings, PATH_BYTES, RANGES } from './remote-settings.mjs';

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
  show_app: 'queue',
  update_app: 'queue',
  retire_app: 'queue',
  define_term: 'queue',
  propose_agent: 'queue',
  schedule_wake: 'queue',
  wake_agent: 'queue',
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
  /** The conversation snapshot the reading tools answer from. */
  snapshot: 'snapshot.json',
  /** The daemon’s queue of prompts and tool calls for Postbox. */
  prompts: 'prompts.jsonl',
  tools: 'tools.jsonl',
});

/** The turn’s message, one stream-json user message, which a `file` stdin reads. Sent in `start.files`. */
export const MESSAGE_FILE = 'message.jsonl';

/** Folders under REMOTE_DIR are created with this mode, files with FILE_MODE (the design’s “Security”). */
export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Linux’s sun_path is 108 bytes, with its NUL. */
export const SOCKET_PATH_BYTES = 107;

/**
 * The host’s paths for one version of the code. Built from `welcome.home` on the laptop and from the home folder on
 * the host, so both agree.
 * @param {string} home  the host user’s home folder, absolute
 * @param {string} version  Postbox’s package version
 */
export function hostPaths(home, version) {
  const h = hostPath(home, 'home');
  if (h) throw new TypeError(h);
  if (!VERSION_RE.test(version) || version.includes('..')) throw new TypeError(`“${clip(version)}” isn’t a version Postbox installs, such as 0.10.0.`);
  const root = `${home === '/' ? '' : home}/${REMOTE_DIR}`;
  const code = `${root}/${version}`;
  const hostDir = `${code}/server/remote/host`;
  return {
    root,
    code,
    /** The program `ssh` runs: `<host> attach`. */
    host: `${hostDir}/host`,
    shim: `${hostDir}/shim.mjs`,
    runner: `${hostDir}/runner.mjs`,
    socket: `${code}/daemon.sock`,
    /**
     * The version’s start lock, a folder made with mkdir: an attach holds it while it starts `host serve`, and the
     * installer while it checks and replaces the version’s folder. It’s outside that folder, which the installer renames.
     */
    lock: `${root}/locks/${version}.lock`,
    token: `${root}/token`,
    turns: `${root}/turns`,
    /** @param {string} turn @param {string} [file]  one of TURN_FILES’ values, or MESSAGE_FILE */
    turn(turn, file) {
      if (!TURN_RE.test(turn)) throw new TypeError(`“${clip(turn)}” isn’t a turn ID.`);
      return `${root}/turns/${turn}${file ? `/${file}` : ''}`;
    },
  };
}

/** Whether a Unix socket can be bound at this path on Linux. @param {string} path */
export const socketPathFits = (path) => utf8Bytes(path) <= SOCKET_PATH_BYTES;

/**
 * exit.json: how the harness ended. Node gives a code or a signal, never both; `at` is milliseconds since the epoch.
 * @typedef {{ code: number | null, signal: string | null, at: number }} ExitRecord
 */
/**
 * runner.json: the runner’s identity. The daemon signals its process group only when the PID, the boot ID
 * (/proc/sys/kernel/random/boot_id) and the start time (/proc/<pid>/stat field 22, in clock ticks since boot) all still
 * match (the design’s “The daemon”). The runner leads its own session and group, so the group is -pid.
 * @typedef {{ turn: string, version: string, pid: number, bootId: string, startTime: number }} RunnerRecord
 */

/**
 * start.json: what the daemon tells a runner to start. The daemon launches the runner as
 * `<node> <hostPaths().runner> <turn>`, detached, with no stdio of its own; the runner reads this file, never its
 * arguments, for the rest. `program` is the absolute path of the harness the daemon found (or the configured one);
 * `argv`, `env`, `stdin` and `folder` are the `start` message’s, unchanged.
 * @typedef {{ turn: string, harness: string, program: string, argv: string[], env: Record<string, string>,
 *   stdin: 'file' | 'none' | 'held', folder: string }} StartRecord
 */

/** @param {unknown} v @returns {Result<StartRecord>} */
export function validateStartRecord(v) {
  return run('start.json', v, () => {
    const m = /** @type {any} */ (v);
    return (
      fields(m, 'start.json', ['turn', 'harness', 'program', 'argv', 'env', 'stdin', 'folder']) ||
      turnId(m.turn, 'start.json.turn') ||
      oneOf(m.harness, 'start.json.harness', HARNESSES) ||
      hostPath(m.program, 'start.json.program') ||
      checkArgv(m.argv) ||
      checkEnv(m.env) ||
      oneOf(m.stdin, 'start.json.stdin', STDIN_KINDS) ||
      hostPath(m.folder, 'start.json.folder')
    );
  });
}

/** @param {unknown} v @returns {Result<ExitRecord>} */
export function validateExitRecord(v) {
  return run('exit.json', v, () => checkExit(v, 'exit.json'));
}

/** @param {unknown} v @returns {Result<RunnerRecord>} */
export function validateRunnerRecord(v) {
  return run('runner.json', v, () => {
    const m = /** @type {any} */ (v);
    return (
      fields(m, 'runner.json', ['turn', 'version', 'pid', 'bootId', 'startTime']) ||
      turnId(m.turn, 'runner.json.turn') ||
      (VERSION_RE.test(m.version) ? '' : `runner.json.version must be a version such as 0.10.0.`) ||
      int(m.pid, 'runner.json.pid', 2, 2 ** 31) ||
      (typeof m.bootId === 'string' && BOOT_ID_RE.test(m.bootId) ? '' : 'runner.json.bootId must be the boot ID, a lowercase UUID.') ||
      int(m.startTime, 'runner.json.startTime', 0, Number.MAX_SAFE_INTEGER)
    );
  });
}

// ── Messages ────────────────────────────────────────────────────────────────────────

/**
 * The channels, named sender-to-receiver. Each maps a message type to its validator, which returns an error to show
 * or ''. Field types are in each validator.
 */
const CHANNELS = {
  /** Postbox → daemon, over the SSH channel’s stdin. */
  'postbox-to-daemon': {
    /** { version, token, takeover?, settings? } */
    hello: (m) =>
      fields(m, 'hello', ['version', 'token'], ['takeover', 'settings']) ||
      int(m.version, 'hello.version', 1, 1_000_000) ||
      token(m.token, 'hello.token') ||
      opt(m.takeover, (v) => bool(v, 'hello.takeover')) ||
      opt(m.settings, (v) => checkSettings(v)),
    /** { turn, harness, folder, argv, env, stdin, files, agentFile? } */
    start: (m) =>
      fields(m, 'start', ['turn', 'harness', 'folder', 'argv', 'env', 'stdin', 'files'], ['agentFile']) ||
      turnId(m.turn, 'start.turn') ||
      oneOf(m.harness, 'start.harness', HARNESSES) ||
      hostPath(m.folder, 'start.folder') ||
      checkArgv(m.argv) ||
      checkEnv(m.env) ||
      oneOf(m.stdin, 'start.stdin', STDIN_KINDS) ||
      checkFiles(m.files) ||
      (m.stdin === 'file' && !m.files.some((f) => f.name === MESSAGE_FILE)
        ? `A turn that reads its stdin from a file must send ${MESSAGE_FILE} in start.files.`
        : '') ||
      opt(m.agentFile, (v) => (m.harness === 'kiro-cli' ? checkAgentFile(v) : `start.agentFile is only for kiro-cli; this start is for ${m.harness}.`)),
    /** { turn, home, threads: [{ id, items: SnapshotItem[] }] }: the whole snapshot, replacing any before. */
    snapshot: (m) =>
      fields(m, 'snapshot', ['turn', 'home', 'threads']) ||
      turnId(m.turn, 'snapshot.turn') ||
      id(m.home, 'snapshot.home') ||
      list(m.threads, 'snapshot.threads', REMOTE_LIMITS.snapshotThreads, (t, i) => {
        const at = `snapshot.threads[${i}]`;
        return fields(t, at, ['id', 'items']) || id(t.id, `${at}.id`) || checkItems(t.items, `${at}.items`);
      }) ||
      unique(
        m.threads.map((t) => t.id),
        'snapshot.threads',
        'thread',
      ) ||
      (m.threads.some((t) => t.id === m.home) ? '' : `snapshot.home “${clip(m.home)}” must be one of snapshot.threads.`),
    /** { turn, thread, items }: items added or changed in one thread of the snapshot; an existing ID is replaced in place. */
    'snapshot-items': (m) =>
      fields(m, 'snapshot-items', ['turn', 'thread', 'items']) ||
      turnId(m.turn, 'snapshot-items.turn') ||
      id(m.thread, 'snapshot-items.thread') ||
      checkItems(m.items, 'snapshot-items.items'),
    /** { turn, from, log? }: lines from that byte offset, then new ones as they come. */
    read: (m) =>
      fields(m, 'read', ['turn', 'from'], ['log']) ||
      turnId(m.turn, 'read.turn') ||
      int(m.from, 'read.from', 0, Number.MAX_SAFE_INTEGER) ||
      opt(m.log, (v) => oneOf(v, 'read.log', LOGS)),
    /** { turn, line }: a line for a held stdin, without its \n. */
    write: (m) => fields(m, 'write', ['turn', 'line']) || turnId(m.turn, 'write.turn') || streamLine(m.line, 'write.line'),
    /** { turn, prompt, result }: the person’s answer to a waiting permission prompt, the `prompt` with that turn and ID. */
    answer: (m) =>
      fields(m, 'answer', ['turn', 'prompt', 'result']) ||
      turnId(m.turn, 'answer.turn') ||
      id(m.prompt, 'answer.prompt') ||
      checkDecision(m.result, 'answer.result'),
    /** { turn, id, ok, text }: Postbox’s answer to the `tool` with that turn and ID. */
    reply: (m) =>
      fields(m, 'reply', ['turn', 'id', 'ok', 'text']) ||
      turnId(m.turn, 'reply.turn') ||
      id(m.id, 'reply.id') ||
      bool(m.ok, 'reply.ok') ||
      str(m.text, 'reply.text', REMOTE_LIMITS.replyChars),
    /** { turn } */
    stop: (m) => fields(m, 'stop', ['turn']) || turnId(m.turn, 'stop.turn'),
    /** { turn, upTo }: Postbox has applied out.jsonl up to this offset. */
    ack: (m) => fields(m, 'ack', ['turn', 'upTo']) || turnId(m.turn, 'ack.turn') || int(m.upTo, 'ack.upTo', 0, Number.MAX_SAFE_INTEGER),
    /** {}: stop everything and delete ~/.postbox-remote. */
    remove: (m) => fields(m, 'remove', []),
    /** {}: run the host’s signInCheck (hello.settings’), answered by `checked`. */
    check: (m) => fields(m, 'check', []),
  },

  /** daemon → Postbox, over the SSH channel’s stdout. */
  'daemon-to-postbox': {
    /** The reply to a good hello. */
    welcome: (m) =>
      fields(m, 'welcome', ['version', 'home', 'node', 'harnesses', 'problems', 'turns']) ||
      int(m.version, 'welcome.version', 1, 1_000_000) ||
      hostPath(m.home, 'welcome.home') ||
      fields(m.node, 'welcome.node', ['path', 'version']) ||
      hostPath(m.node.path, 'welcome.node.path') ||
      str(m.node.version, 'welcome.node.version', 64) ||
      list(m.harnesses, 'welcome.harnesses', HARNESSES.length, (h, i) => {
        const at = `welcome.harnesses[${i}]`;
        return (
          fields(h, at, ['name', 'path', 'version', 'looked']) ||
          oneOf(h.name, `${at}.name`, HARNESSES) ||
          (h.path === null ? '' : hostPath(h.path, `${at}.path`)) ||
          (h.version === null ? '' : str(h.version, `${at}.version`, 200)) ||
          list(h.looked, `${at}.looked`, REMOTE_LIMITS.looked, (p, j) => hostPath(p, `${at}.looked[${j}]`))
        );
      }) ||
      unique(
        m.harnesses.map((h) => h.name),
        'welcome.harnesses',
        'harness',
      ) ||
      list(m.problems, 'welcome.problems', REMOTE_LIMITS.problems, (p, i) => {
        const at = `welcome.problems[${i}]`;
        return fields(p, at, ['code', 'message']) || id(p.code, `${at}.code`) || str(p.message, `${at}.message`, REMOTE_LIMITS.messageChars, 1);
      }) ||
      list(m.turns, 'welcome.turns', REMOTE_LIMITS.turns, (t, i) => {
        const at = `welcome.turns[${i}]`;
        return (
          fields(t, at, ['turn', 'harness', 'state', 'size', 'exit']) ||
          turnId(t.turn, `${at}.turn`) ||
          oneOf(t.harness, `${at}.harness`, HARNESSES) ||
          oneOf(t.state, `${at}.state`, TURN_STATES) ||
          int(t.size, `${at}.size`, 0, Number.MAX_SAFE_INTEGER) ||
          (t.state === 'ended' ? checkExit(t.exit, `${at}.exit`) : t.exit === null ? '' : `${at}.exit must be null unless the turn has ended.`)
        );
      }),
    /** { turn }: the runner is up and runner.json is written. */
    started: (m) => fields(m, 'started', ['turn']) || turnId(m.turn, 'started.turn'),
    /** { turn, log?, offset, next, text, cut? } */
    line: (m) =>
      fields(m, 'line', ['turn', 'offset', 'next', 'text'], ['log', 'cut']) ||
      turnId(m.turn, 'line.turn') ||
      opt(m.log, (v) => oneOf(v, 'line.log', LOGS)) ||
      int(m.offset, 'line.offset', 0, Number.MAX_SAFE_INTEGER) ||
      int(m.next, 'line.next', 0, Number.MAX_SAFE_INTEGER) ||
      opt(m.cut, (v) => (v === true ? '' : 'line.cut is only ever true.')) ||
      (m.cut ? (m.text === '' ? '' : 'A cut line’s text must be empty.') : streamLine(m.text, 'line.text')) ||
      (m.cut ? (m.next > m.offset ? '' : 'A cut line must move the offset on.') : lineSpan(m.offset, m.next, m.text)),
    /** { turn, upTo }: a `write` reached the held stdin; upTo is in.jsonl’s size after it. */
    written: (m) => fields(m, 'written', ['turn', 'upTo']) || turnId(m.turn, 'written.turn') || int(m.upTo, 'written.upTo', 1, Number.MAX_SAFE_INTEGER),
    /** { turn, log, size }: a `read` has sent every line of that log up to `size`, its size when the first pass got there. */
    'caught-up': (m) =>
      fields(m, 'caught-up', ['turn', 'log', 'size']) ||
      turnId(m.turn, 'caught-up.turn') ||
      oneOf(m.log, 'caught-up.log', LOGS) ||
      int(m.size, 'caught-up.size', 0, Number.MAX_SAFE_INTEGER),
    /** { turn, exit, size }: after the turn’s last line; exit is null for an interrupted turn. */
    ended: (m) =>
      fields(m, 'ended', ['turn', 'exit', 'size']) ||
      turnId(m.turn, 'ended.turn') ||
      (m.exit === null ? '' : checkExit(m.exit, 'ended.exit')) ||
      int(m.size, 'ended.size', 0, Number.MAX_SAFE_INTEGER),
    /** { turn, id, name, args }: a shim tool call for Postbox; id is the shim’s, unique only within the turn. */
    tool: (m) =>
      fields(m, 'tool', ['turn', 'id', 'name', 'args']) ||
      turnId(m.turn, 'tool.turn') ||
      id(m.id, 'tool.id') ||
      (Object.hasOwn(TOOL_ROUTES, m.name) && TOOL_ROUTES[m.name] !== 'host' ? '' : `tool.name “${clip(m.name)}” isn’t a tool Postbox answers.`) ||
      obj(m.args, 'tool.args'),
    /** { id, turn, request }: a permission prompt waiting in the shim; id is the shim’s, unique only within the turn. */
    prompt: (m) =>
      fields(m, 'prompt', ['id', 'turn', 'request']) || id(m.id, 'prompt.id') || turnId(m.turn, 'prompt.turn') || checkRequest(m.request, 'prompt.request'),
    /** { id, turn, at, reason? }: nobody can answer it any more: the host denied it at permissionWaitMax (`expired`,
     * the default), or the harness canceled the call (`canceled`). */
    'prompt-expired': (m) =>
      fields(m, 'prompt-expired', ['id', 'turn', 'at'], ['reason']) ||
      id(m.id, 'prompt-expired.id') ||
      turnId(m.turn, 'prompt-expired.turn') ||
      int(m.at, 'prompt-expired.at', 0, Number.MAX_SAFE_INTEGER) ||
      opt(m.reason, (v) => oneOf(v, 'prompt-expired.reason', ['expired', 'canceled'])),
    /** {}: everything is stopped and deleted; the daemon exits next. */
    removed: (m) => fields(m, 'removed', []),
    /** { ok, code, at }: how the signInCheck a `check` ran exited; ok exactly when code is 0, at when it ended. */
    checked: (m) =>
      fields(m, 'checked', ['ok', 'code', 'at']) ||
      bool(m.ok, 'checked.ok') ||
      (m.code === null ? '' : int(m.code, 'checked.code', 0, 255)) ||
      int(m.at, 'checked.at', 0, Number.MAX_SAFE_INTEGER) ||
      (m.ok === (m.code === 0) ? '' : 'checked.ok is true exactly when checked.code is 0.'),
    error: (m) => checkError(m),
  },

  /** daemon → runner, over the runner’s socket. */
  'daemon-to-runner': {
    /** { token }: is this runner alive, and whose is it? */
    who: (m) => fields(m, 'who', ['token']) || token(m.token, 'who.token'),
    /** { line }: a line for the held stdin. */
    stdin: (m) => fields(m, 'stdin', ['line']) || streamLine(m.line, 'stdin.line'),
  },

  /** runner → daemon. */
  'runner-to-daemon': {
    /** { turn, pid }: the answer to who, with the turn’s ID. */
    iam: (m) => fields(m, 'iam', ['turn', 'pid']) || turnId(m.turn, 'iam.turn') || int(m.pid, 'iam.pid', 2, 2 ** 31),
    /** { upTo }: in.jsonl’s size once the stdin line is written. */
    written: (m) => fields(m, 'written', ['upTo']) || int(m.upTo, 'written.upTo', 1, Number.MAX_SAFE_INTEGER),
    error: (m) => checkError(m),
  },

  /** shim → daemon, over the daemon’s socket. */
  'shim-to-daemon': {
    /** { token, turn }: sent first, and again on each reconnect. */
    hello: (m) => fields(m, 'hello', ['token', 'turn']) || token(m.token, 'hello.token') || turnId(m.turn, 'hello.turn'),
    /** { id, name, args }: a tool call, other than permission_prompt. */
    call: (m) =>
      fields(m, 'call', ['id', 'name', 'args']) ||
      id(m.id, 'call.id') ||
      (Object.hasOwn(TOOL_ROUTES, m.name) && m.name !== 'permission_prompt' ? '' : `call.name “${clip(m.name)}” isn’t a Postbox tool the daemon serves.`) ||
      obj(m.args, 'call.args'),
    /** { id, request }: permission_prompt’s arguments. Resent with the same ID after a reconnect. */
    permission: (m) => fields(m, 'permission', ['id', 'request']) || id(m.id, 'permission.id') || checkRequest(m.request, 'permission.request'),
    /** { id, at }: the shim denied it at permissionWaitMax. */
    'permission-expired': (m) =>
      fields(m, 'permission-expired', ['id', 'at']) || id(m.id, 'permission-expired.id') || int(m.at, 'permission-expired.at', 0, Number.MAX_SAFE_INTEGER),
    /** { id, at }: the harness canceled the call (MCP’s cancel notification), so nobody waits on the answer. */
    'permission-canceled': (m) =>
      fields(m, 'permission-canceled', ['id', 'at']) || id(m.id, 'permission-canceled.id') || int(m.at, 'permission-canceled.at', 0, Number.MAX_SAFE_INTEGER),
  },

  /** daemon → shim. */
  'daemon-to-shim': {
    /** { turn, permissionWaitMax }: in milliseconds, as remote-settings.mjs’s RANGES bound it. */
    welcome: (m) =>
      fields(m, 'welcome', ['turn', 'permissionWaitMax']) ||
      turnId(m.turn, 'welcome.turn') ||
      int(m.permissionWaitMax, 'welcome.permissionWaitMax', RANGES.permissionWaitMax.min, RANGES.permissionWaitMax.max),
    /** { id, ok, text }: a call’s result, as the tool’s text content. */
    result: (m) =>
      fields(m, 'result', ['id', 'ok', 'text']) || id(m.id, 'result.id') || bool(m.ok, 'result.ok') || str(m.text, 'result.text', REMOTE_LIMITS.replyChars),
    /** { id, result }: the person’s answer. */
    'permission-answer': (m) =>
      fields(m, 'permission-answer', ['id', 'result']) || id(m.id, 'permission-answer.id') || checkDecision(m.result, 'permission-answer.result'),
    error: (m) => checkError(m),
  },
};

/** @typedef {keyof typeof CHANNELS} Channel */
/** @template T @typedef {{ ok: true, msg: T } | { ok: false, error: string }} Result */

/** The channel names. */
export const CHANNEL_NAMES = /** @type {Channel[]} */ (Object.keys(CHANNELS));

/** The message types each channel carries. @param {Channel} channel */
export const messageTypes = (channel) => Object.keys(CHANNELS[channel]);

/**
 * Checks one decoded message for a channel.
 * @param {Channel} channel @param {unknown} value
 * @returns {Result<{ type: string, [field: string]: any }>}
 */
export function validateMessage(channel, value) {
  const types = CHANNELS[channel];
  if (!types) return { ok: false, error: `There’s no channel “${clip(channel)}”.` };
  if (!isObj(value)) return { ok: false, error: 'A message must be a JSON object.' };
  const type = /** @type {any} */ (value).type;
  if (typeof type !== 'string' || !Object.hasOwn(types, type))
    return { ok: false, error: `“${clip(type)}” isn’t a message on this channel; it carries ${Object.keys(types).join(', ')}.` };
  return run(type, value, () => types[type](value));
}

/**
 * One validator per message: VALIDATORS[channel][type](value).
 * @type {Record<Channel, Record<string, (value: unknown) => Result<{ type: string, [field: string]: any }>>>}
 */
export const VALIDATORS = /** @type {any} */ (
  Object.fromEntries(
    CHANNEL_NAMES.map((c) => [
      c,
      Object.fromEntries(
        Object.keys(CHANNELS[c]).map((t) => [
          t,
          (v) =>
            isObj(v) && /** @type {any} */ (v).type === t ? validateMessage(c, v) : { ok: false, error: `A ${t} message must be an object with type “${t}”.` },
        ]),
      ),
    ]),
  )
);

/**
 * Builds a message to send, and throws if it isn’t valid: a refused message is the sender’s bug.
 * @param {Channel} channel @param {string} type @param {Record<string, unknown>} [body]
 */
export function message(channel, type, body = {}) {
  const r = validateMessage(channel, { type, ...body });
  if (!r.ok) throw new TypeError(r.error);
  return r.msg;
}

/** A message as one line, with its \n. Throws if it’s over REMOTE_LIMITS.lineBytes. @param {object} msg */
export function encode(msg) {
  const s = JSON.stringify(msg);
  if (utf8Bytes(s) > REMOTE_LIMITS.lineBytes) throw new RangeError(`A ${/** @type {any} */ (msg).type} message is over ${REMOTE_LIMITS.lineBytes} bytes.`);
  return `${s}\n`;
}

/** A message’s encoded size without its \n, to decide whether a line must be sent cut. @param {object} msg */
export const encodedBytes = (msg) => utf8Bytes(JSON.stringify(msg));

/**
 * Parses and validates one line of text (without its \n).
 * @param {Channel} channel @param {string} text
 * @returns {Result<{ type: string, [field: string]: any }> & { code?: 'bad-json' | 'bad-message' }}
 */
export function parseLine(channel, text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch (e) {
    return { ok: false, code: 'bad-json', error: `A line wasn’t JSON (${e.message}).` };
  }
  const r = validateMessage(channel, v);
  return r.ok ? r : { ...r, code: 'bad-message' };
}

// ── Framing ─────────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ code: 'too-long' | 'bad-utf8' | 'torn' | 'bad-json' | 'bad-message', message: string, offset: number }} LineError
 * @typedef {{ offset: number, next: number }} LineSpan
 */

/**
 * Splits bytes into lines on \n. It never throws on bad input: a line over maxBytes, or one that isn’t UTF-8, goes to
 * onError and is skipped, and the next line is read as usual. Whatever onLine and onError throw is the caller’s.
 * @param {{ onLine: (text: string, span: LineSpan) => void, onError: (e: LineError) => void, maxBytes?: number,
 *           offset?: number, trailing?: boolean }} opts
 *   offset: the byte offset of the first byte pushed, for reading a log from the middle. trailing: deliver a last line
 *   with no \n at end() (a finished out.jsonl), instead of reporting it torn (a channel that dropped mid-message).
 * @returns {{ push(chunk: Uint8Array | string): void, end(): void }}
 */
export function createLineReader({ onLine, onError, maxBytes = REMOTE_LIMITS.lineBytes, offset = 0, trailing = false }) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  /** @type {Uint8Array[]} */
  let parts = [];
  let held = 0; // bytes of the current line so far, including any being skipped
  let start = offset;
  let skipping = false;
  let ended = false;
  const deliver = (next) => {
    const bytes = parts.length === 1 ? parts[0] : concat(parts, held);
    let text;
    try {
      text = decoder.decode(bytes);
    } catch {
      onError({ code: 'bad-utf8', message: `The line at byte ${start} isn’t UTF-8.`, offset: start });
      return;
    }
    onLine(text, { offset: start, next });
  };
  const reset = (next) => {
    parts = [];
    held = 0;
    skipping = false;
    start = next;
  };
  return {
    push(chunk) {
      if (ended) return;
      const buf = typeof chunk === 'string' ? ENCODER.encode(chunk) : chunk;
      let i = 0;
      while (i < buf.length) {
        const nl = buf.indexOf(10, i);
        const stop = nl === -1 ? buf.length : nl;
        const n = stop - i;
        if (!skipping && held + n > maxBytes) {
          skipping = true;
          parts = [];
          onError({ code: 'too-long', message: `The line at byte ${start} is over ${maxBytes} bytes, so it was skipped.`, offset: start });
        }
        // A piece kept past this call is copied, since a stream may reuse its buffer.
        if (!skipping && n) parts.push(nl === -1 ? buf.slice(i, stop) : buf.subarray(i, stop));
        held += n;
        if (nl === -1) break;
        const next = start + held + 1;
        if (!skipping) deliver(next);
        reset(next);
        i = nl + 1;
      }
    },
    end() {
      if (ended) return;
      ended = true;
      if (!held && !skipping) return;
      if (trailing && !skipping) deliver(start + held);
      else if (!skipping) onError({ code: 'torn', message: `The input ended in the middle of a line, at byte ${start + held}.`, offset: start });
    },
  };
}

/**
 * Reads a channel’s messages from bytes: createLineReader, then parseLine. A refused line goes to onError with its
 * reason, and reading goes on.
 * @param {Channel} channel
 * @param {{ onMessage: (msg: { type: string, [field: string]: any }) => void, onError: (e: LineError) => void, maxBytes?: number }} opts
 */
export function createMessageReader(channel, { onMessage, onError, maxBytes = REMOTE_LIMITS.lineBytes }) {
  return createLineReader({
    maxBytes,
    onError,
    onLine(text, { offset }) {
      const r = parseLine(channel, text);
      if (r.ok) onMessage(r.msg);
      else onError({ code: r.code ?? 'bad-message', message: r.error, offset });
    },
  });
}

/** UTF-8 bytes in a string, without encoding it. Lone surrogates count 3, as TextEncoder writes U+FFFD. @param {string} s */
export function utf8Bytes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// ── Checks ──────────────────────────────────────────────────────────────────────────
// Each returns the error to show, or '' when the value is fine, so they chain with ||.

const ENCODER = new TextEncoder();
const TURN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,35}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const BOOT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SIGNAL_RE = /^SIG[A-Z0-9]{2,10}$/;
const LOGS = Object.freeze(['out', 'in']);
const TURN_STATES = Object.freeze(['running', 'ended', 'interrupted']);
const RESERVED = new Set([...Object.values(TURN_FILES)]);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (v, n = 60) => {
  const s = typeof v === 'string' ? v : (JSON.stringify(v) ?? String(v));
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** @template T @param {string} what @param {unknown} v @param {() => string} check @returns {Result<T>} */
function run(what, v, check) {
  try {
    const error = check();
    return error ? { ok: false, error } : { ok: true, msg: /** @type {T} */ (v) };
  } catch (e) {
    // A check reads only shapes it has already confirmed, so this is a bug in this file; it still mustn’t escape.
    return { ok: false, error: `Couldn’t check the ${what} message: ${e.message}` };
  }
}

/** The object has every required field, and no field outside required, optional and `type`. */
function fields(m, at, required, optional = []) {
  if (!isObj(m)) return `${at} must be an object.`;
  for (const k of Object.keys(m)) if (k !== 'type' && !required.includes(k) && !optional.includes(k)) return `“${clip(k)}” isn’t a field of ${at}.`;
  return has(m, at, required);
}

/** The object has every required field; it may have others. */
function has(m, at, required) {
  for (const k of required) if (!Object.hasOwn(m, k) || m[k] === undefined) return `${at} needs “${k}”.`;
  return '';
}

const opt = (v, check) => (v === undefined ? '' : check(v));
const bool = (v, at) => (typeof v === 'boolean' ? '' : `${at} must be true or false.`);
const obj = (v, at) => (isObj(v) ? '' : `${at} must be an object.`);
const oneOf = (v, at, options) => (options.includes(v) ? '' : `${at} must be one of ${options.join(', ')}; got “${clip(v)}”.`);
const turnId = (v, at) =>
  typeof v === 'string' && TURN_RE.test(v)
    ? ''
    : `${at} must be a turn ID: up to 36 letters, digits, - and _, starting with a letter or digit; got “${clip(v)}”.`;
const id = (v, at) =>
  typeof v === 'string' && ID_RE.test(v)
    ? ''
    : `${at} must be an ID: up to 128 letters, digits and _ . : -, starting with a letter or digit; got “${clip(v)}”.`;
const token = (v, at) =>
  typeof v === 'string' && TOKEN_RE.test(v) ? '' : `${at} must be the host’s token from ~/${REMOTE_DIR}/token: 32 to 128 letters, digits, - and _.`;

function int(v, at, min, max) {
  if (!Number.isSafeInteger(v)) return `${at} must be a whole number; got “${clip(v)}”.`;
  return v < min || v > max ? `${at} must be from ${min} to ${max}; got ${v}.` : '';
}

/** A string of at most `max` characters (and at least `min`), with no NUL. */
function str(v, at, max, min = 0) {
  if (typeof v !== 'string') return `${at} must be text.`;
  if (v.length < min) return `${at} can’t be empty.`;
  if (v.length > max) return `${at} is ${v.length} characters; the limit is ${max}.`;
  return v.includes('\0') ? `${at} can’t contain a NUL character.` : '';
}

function list(v, at, max, each) {
  if (!Array.isArray(v)) return `${at} must be a list.`;
  if (v.length > max) return `${at} has ${v.length} entries; the limit is ${max}.`;
  for (let i = 0; i < v.length; i++) {
    const e = each(v[i], i);
    if (e) return e;
  }
  return '';
}

function unique(values, at, what) {
  const seen = new Set();
  for (const v of values) {
    if (seen.has(v)) return `${at} names the ${what} “${clip(v)}” twice.`;
    seen.add(v);
  }
  return '';
}

/** A host path, by remote-settings.mjs’s one rule for them, so a saved setting is a path these messages carry. */
function hostPath(v, at) {
  const r = checkHostPath(v, at);
  return r.ok ? '' : r.error;
}

function checkArgv(v) {
  const e = list(v, 'start.argv', REMOTE_LIMITS.args, (a, i) => {
    if (typeof a !== 'string') return `start.argv[${i}] must be text.`;
    if (a.includes('\0')) return `start.argv[${i}] can’t contain a NUL character.`;
    const n = utf8Bytes(a);
    return n > REMOTE_LIMITS.argBytes ? `start.argv[${i}] is ${n} bytes; Linux limits one argument to 128 KiB.` : '';
  });
  if (e) return e;
  const total = v.reduce((n, a) => n + utf8Bytes(a) + 1, 0);
  return total > REMOTE_LIMITS.argvBytes ? `start.argv is ${total} bytes in all; the limit is ${REMOTE_LIMITS.argvBytes}.` : '';
}

function checkEnv(v) {
  if (!isObj(v)) return 'start.env must be an object of names to values.';
  const names = Object.keys(v);
  if (names.length > REMOTE_LIMITS.envVars) return `start.env has ${names.length} variables; the limit is ${REMOTE_LIMITS.envVars}.`;
  for (const k of names) {
    if (!ENV_RE.test(k) || k.length > REMOTE_LIMITS.envNameChars)
      return `start.env’s “${clip(k)}” isn’t a variable name: capital letters, digits and _, not starting with a digit.`;
    const val = v[k];
    if (typeof val !== 'string') return `start.env.${k} must be text.`;
    if (val.includes('\0')) return `start.env.${k} can’t contain a NUL character.`;
    if (utf8Bytes(val) > REMOTE_LIMITS.envValueBytes) return `start.env.${k} is over ${REMOTE_LIMITS.envValueBytes} bytes.`;
  }
  return '';
}

/**
 * start.agentFile: a Kiro CLI custom agent file, which Kiro reads from `<its home>/agents/`, not from the turn folder.
 * Postbox sends only its name and text. The daemon picks the folder from the Kiro home the runner will use (start.env’s
 * KIRO_HOME, which must be under ~/.postbox-remote, else its own KIRO_HOME, else ~/.kiro), writes the file there 0600,
 * never over one already there, and removes it when the turn ends.
 */
function checkAgentFile(v) {
  const e =
    fields(v, 'start.agentFile', ['name', 'text']) ||
    (typeof v.name === 'string' && FILE_RE.test(v.name) && !v.name.includes('..') && v.name.endsWith('.json')
      ? ''
      : `start.agentFile.name must be a plain file name ending in .json; got “${clip(v.name)}”.`) ||
    str(v.text, 'start.agentFile.text', Number.MAX_SAFE_INTEGER);
  if (e) return e;
  const n = utf8Bytes(v.text);
  return n > REMOTE_LIMITS.fileBytes ? `start.agentFile.text is ${n} bytes; the limit is ${REMOTE_LIMITS.fileBytes}.` : '';
}

function checkFiles(v) {
  let total = 0;
  return (
    list(v, 'start.files', REMOTE_LIMITS.files, (f, i) => {
      const at = `start.files[${i}]`;
      const e = fields(f, at, ['name', 'text']);
      if (e) return e;
      if (typeof f.name !== 'string' || !FILE_RE.test(f.name) || f.name.includes('..'))
        return `${at}.name must be a plain file name: letters, digits, . _ and -, starting with a letter or digit, with no / or ..; got “${clip(f.name)}”.`;
      if (RESERVED.has(f.name)) return `${at}.name “${f.name}” is one of the turn folder’s own files.`;
      if (typeof f.text !== 'string') return `${at}.text must be text.`;
      const n = utf8Bytes(f.text);
      if (n > REMOTE_LIMITS.fileBytes) return `${at} (${f.name}) is ${n} bytes; the limit is ${REMOTE_LIMITS.fileBytes}.`;
      total += n;
      return total > REMOTE_LIMITS.filesBytes ? `start.files are over ${REMOTE_LIMITS.filesBytes} bytes in all.` : '';
    }) ||
    unique(
      v.map((f) => f.name),
      'start.files',
      'file',
    )
  );
}

/** `hello.settings`: only HOST_ENFORCED, each checked by remote-settings.mjs so the ranges and the path rule live in one place. */
function checkSettings(v) {
  const e = fields(v, 'hello.settings', [], [...HOST_ENFORCED]);
  if (e) return e;
  const r = checkHostSettings(v);
  return r.ok ? '' : `hello.settings: ${r.error}`;
}

function checkExit(v, at) {
  return (
    fields(v, at, ['code', 'signal', 'at']) ||
    (v.code === null ? '' : int(v.code, `${at}.code`, 0, 255)) ||
    (v.signal === null || (typeof v.signal === 'string' && SIGNAL_RE.test(v.signal)) ? '' : `${at}.signal must be a signal name such as SIGINT, or null.`) ||
    ((v.code === null) === (v.signal === null) ? `${at} has a code or a signal, never both or neither.` : '') ||
    int(v.at, `${at}.at`, 0, Number.MAX_SAFE_INTEGER)
  );
}

function checkItems(v, at) {
  return (
    list(v, at, REMOTE_LIMITS.snapshotItems, (it, i) => {
      const a = `${at}[${i}]`;
      return (
        fields(it, a, ['id', 'line', 'text'], ['blockId']) ||
        id(it.id, `${a}.id`) ||
        opt(it.blockId, (b) => id(b, `${a}.blockId`)) ||
        str(it.line, `${a}.line`, REMOTE_LIMITS.snapshotLineChars) ||
        str(it.text, `${a}.text`, REMOTE_LIMITS.snapshotTextChars)
      );
    }) ||
    unique(
      v.map((it) => it.id),
      at,
      'item',
    )
  );
}

/**
 * permission_prompt’s arguments, as shared/mcp-tools.mjs’s inputSchema names them. Claude Code owns them and may add
 * one, which server/mcp.mjs’s permission() ignores, so a field not named here passes; the line limit still bounds it.
 */
function checkRequest(v, at) {
  return (
    obj(v, at) ||
    has(v, at, ['tool_name', 'input']) ||
    str(v.tool_name, `${at}.tool_name`, 256, 1) ||
    obj(v.input, `${at}.input`) ||
    opt(v.tool_use_id, (x) => str(x, `${at}.tool_use_id`, 256)) ||
    opt(v.permission_suggestions, (x) => list(x, `${at}.permission_suggestions`, 64, (s, i) => obj(s, `${at}.permission_suggestions[${i}]`))) ||
    opt(v.agent_id, (x) => str(x, `${at}.agent_id`, 256))
  );
}

/** The decision a permission prompt tool returns: { behavior: 'allow', updatedInput } or { behavior: 'deny', message }. */
function checkDecision(v, at) {
  if (!isObj(v)) return `${at} must be an object.`;
  if (v.behavior === 'allow')
    return (
      fields(v, at, ['behavior', 'updatedInput'], ['updatedPermissions']) ||
      obj(v.updatedInput, `${at}.updatedInput`) ||
      opt(v.updatedPermissions, (x) => list(x, `${at}.updatedPermissions`, 64, (s, i) => obj(s, `${at}.updatedPermissions[${i}]`)))
    );
  if (v.behavior === 'deny') return fields(v, at, ['behavior', 'message']) || str(v.message, `${at}.message`, REMOTE_LIMITS.messageChars, 1);
  return `${at}.behavior must be allow or deny; got “${clip(v.behavior)}”.`;
}

/**
 * { code, message, re?, turn?, id? }: re is the type of the message it answers, turn the turn it’s about, and id the
 * prompt or tool call it names, within that turn: an `re: 'prompt-expired'` error names the prompt whose end the daemon
 * couldn’t record, so Postbox ends exactly that card.
 */
function checkError(m) {
  return (
    fields(m, 'error', ['code', 'message'], ['re', 'turn', 'id']) ||
    oneOf(m.code, 'error.code', ERROR_CODES) ||
    str(m.message, 'error.message', REMOTE_LIMITS.messageChars, 1) ||
    opt(m.re, (v) => (typeof v === 'string' && /^[a-z][a-z-]{0,31}$/.test(v) ? '' : 'error.re must be the type of the message it answers.')) ||
    opt(m.turn, (v) => turnId(v, 'error.turn')) ||
    opt(m.id, (v) => id(v, 'error.id')) ||
    (m.id !== undefined && m.turn === undefined ? 'error.id names a prompt or a tool call within a turn, so it comes with error.turn.' : '')
  );
}

/** A line of a log, without its \n, which it can’t contain. */
function streamLine(v, at) {
  if (typeof v !== 'string') return `${at} must be text.`;
  if (v.includes('\n')) return `${at} is one line, so it can’t contain a newline.`;
  const n = utf8Bytes(v);
  return n > REMOTE_LIMITS.streamLineBytes ? `${at} is ${n} bytes; the limit is ${REMOTE_LIMITS.streamLineBytes}.` : '';
}

/** A line’s next is just past its \n, or at its end for a last line with none. */
function lineSpan(offset, next, text) {
  const end = offset + utf8Bytes(text);
  return next === end + 1 || next === end ? '' : `line.next must be ${end + 1}, just past the line’s \\n (or ${end} for a last line with none); got ${next}.`;
}

function concat(parts, n) {
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
