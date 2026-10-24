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
//
// This module is the protocol’s one entry point, and its parts are the remote-protocol-*.mjs modules beside it, one
// concern each: constants, checks (single values), parts (what several messages carry), files (the host’s), the
// channels’ messages (channels-postbox, channels-host), messages (check, build, parse) and framing.

import { utf8Bytes } from './remote-protocol-checks.mjs';
import {
  DIR_MODE,
  ERROR_CODES,
  FILE_MODE,
  HARNESSES,
  HOST_DEFAULTS,
  HOST_ENFORCED,
  MESSAGE_FILE,
  PROTOCOL_VERSION,
  REMOTE_DIR,
  REMOTE_LIMITS,
  SIGN_IN_CHECK_MS,
  SOCKET_PATH_BYTES,
  STDIN_KINDS,
  TOOL_ROUTES,
  TURN_FILES,
} from './remote-protocol-constants.mjs';
import { hostPaths, socketPathFits, validateExitRecord, validateRunnerRecord, validateStartRecord } from './remote-protocol-files.mjs';
import { createLineReader, createMessageReader } from './remote-protocol-framing.mjs';
import { CHANNEL_NAMES, encode, encodedBytes, message, messageTypes, parseLine, VALIDATORS, validateMessage } from './remote-protocol-messages.mjs';

export {
  CHANNEL_NAMES,
  createLineReader,
  createMessageReader,
  DIR_MODE,
  ERROR_CODES,
  encode,
  encodedBytes,
  FILE_MODE,
  HARNESSES,
  HOST_DEFAULTS,
  HOST_ENFORCED,
  hostPaths,
  MESSAGE_FILE,
  message,
  messageTypes,
  PROTOCOL_VERSION,
  parseLine,
  REMOTE_DIR,
  REMOTE_LIMITS,
  SIGN_IN_CHECK_MS,
  SOCKET_PATH_BYTES,
  STDIN_KINDS,
  socketPathFits,
  TOOL_ROUTES,
  TURN_FILES,
  utf8Bytes,
  VALIDATORS,
  validateExitRecord,
  validateMessage,
  validateRunnerRecord,
  validateStartRecord,
};

/** @typedef {import('./remote-protocol-constants.mjs').Harness} Harness */
/** @typedef {import('./remote-protocol-files.mjs').ExitRecord} ExitRecord */
/** @typedef {import('./remote-protocol-files.mjs').RunnerRecord} RunnerRecord */
/** @typedef {import('./remote-protocol-files.mjs').StartRecord} StartRecord */
/** @typedef {import('./remote-protocol-messages.mjs').Channel} Channel */
/** @template T @typedef {import('./remote-protocol-checks.mjs').Result<T>} Result */
/** @typedef {import('./remote-protocol-framing.mjs').LineError} LineError */
/** @typedef {import('./remote-protocol-framing.mjs').LineSpan} LineSpan */
