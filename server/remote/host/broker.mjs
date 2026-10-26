// The daemon’s broker (#120): what the daemon does for each turn’s shim, and for Codex’s approval requests, between
// the agent on the host and Postbox on the laptop. The design is architecture.md, “Remote hosts”, “Postbox’s tools on
// the host” and “Permission prompts while nobody is connected”; the messages are shared/remote-protocol.mjs’s
// shim-to-daemon, daemon-to-shim, and the tool, prompt, prompt-expired, reply, answer, snapshot and snapshot-items
// messages between Postbox and the daemon. daemon.mjs hands it each shim connection and those Postbox messages.
//
// - A shim says hello with its turn and that turn’s own token (TURN_FILES.shimToken, compared in constant time). A
//   turn that isn’t one the daemon started, has ended, or is stopping is refused with turn-ended, as the laptop refuses a call from a stopped turn
//   (#126): Stop marks the turn stopping first, so a call made after it never reaches the conversation.
// - Each tool call is answered by its route (TOOL_ROUTES). A `queue` call is written to the turn folder’s tools.jsonl,
//   then the shim gets its result at once, so it stops resending, and it crosses to Postbox as `tool` now or after the
//   next hello. Postbox’s `reply` takes it off the queue; a refusal is logged, since the agent was already answered.
//   An `ask` call crosses the same way, and Postbox’s reply is the shim’s result; with no Postbox attached it fails at
//   once and says so. read_conversation and read_message are answered here, from the snapshot Postbox sent.
// - A permission prompt is written to prompts.jsonl and crosses as `prompt`. Postbox’s `answer` goes to the turn’s
//   shims as permission-answer, and again whenever a shim resends the prompt (after a reconnect), since the daemon
//   can’t tell whether a shim that went away read it. The shim’s notice that it expired, or that the harness canceled the call, ends it,
//   and Postbox hears prompt-expired, now or after its next hello.
// - A call or prompt is (turn, id): each shim picks its own IDs. A resent one is recognized and never queued twice.
// - Everything waiting for Postbox survives a daemon restart: tools.jsonl and prompts.jsonl are append-only records of
//   what arrived and what settled, replayed at start, an asked call’s reply with its text, so a shim that sends the
//   call again after a restart gets it. After each Postbox hello every unreplied tool, unanswered prompt and unsent
//   expiry is sent again; Postbox applies each identity once (the protocol’s header). A call or prompt is acknowledged
//   or sent on only once its record is on disk: one that can’t be written down is dropped and logged, and the shim
//   hears why (a call’s result with ok false, a prompt denied). Likewise an answer or reply settles its prompt or call,
//   and reaches the shim, only once it’s on disk: one that can’t be written down leaves it waiting, and Postbox hears
//   an error, so a restart never asks the person again or tells the harness something different. An expiry is
//   written down before it’s sent. One that can’t be still ends the prompt (the shim or the turn gave up on it), which
//   is kept in memory so it can’t be answered or sent again, and Postbox hears an error, not prompt-expired. After a
//   restart such a prompt waits again, with no shim waiting on it: a prompt read back from the records that no shim
//   sends again is ended at permissionWaitMax from when it was asked, when any shim would have given up on it.
//
// show_app and update_app name files in the agent’s folder on the host (codePath, files[].path), which Postbox can’t
// read. The broker reads them first, in start.json’s folder, by server/runtime.mjs’s appFiles rules and limits, and the
// `tool` carries `code` in place of codePath and `files` as [{ name, base64 }], made only here: a files entry Postbox
// gets always came from a path the broker read. The agent can change its folder while the broker reads, so each file
// is opened without following a link at the end of its path, and the file opened is checked to be in the folder
// before anything is read from it (folderFile). add_dataset reads a file on Postbox’s computer, which a remote agent
// can’t name, so it’s refused for now with a message that says so.
//
// The snapshot (`snapshot`, then `snapshot-items`) is kept in snapshot.json in the turn folder, 0600, written
// atomically, or in memory until `start` makes the folder. Its threads come in the order read_message looks through
// them (the turn’s own thread first, as server/runtime.mjs’s conversationThreads gives them), and each thread’s items
// are the ones read_conversation pages through, oldest first: an item with an empty line counts but isn’t shown, as
// runtime.mjs counts an item its describeItem leaves out.
//
// Codex’s approvals don’t go through the shim: the app-server writes each as a JSON-RPC request on its stdout, so it’s
// in out.jsonl, and the answer goes back on the held stdin, so it’s in in.jsonl. While a held Codex turn runs, the
// broker reads both as they grow. A request still unanswered permissionWaitMax after the broker first saw it is
// declined on the held stdin, with the response server/adapters/codex.mjs’s codexApproval sends for a denial, and
// Postbox hears prompt-expired with the ID codex:<request id>. in.jsonl is what says Codex got an answer: the runner
// appends each line to it before the pipe, so a request with a response there is settled, and a `write` that answers
// it again is refused, as is one while the daemon’s own decline or another write for it is on its way: Codex gets one
// answer to each request. The decline goes on the held stdin first, and Postbox hears only once the runner took it; if
// it didn’t, the request waits again for the next look. After a restart, a decline in in.jsonl that Postbox didn’t
// hear about (no expiry-sent) gets its expiry then, unless Postbox wrote it itself: prompts.jsonl’s codex-answered,
// written once its write went, says so (one written just before a crash can still be taken for the daemon’s, and
// Postbox hears an expiry for a prompt it answered, which it applies once and ignores).

// The broker is a state object (broker-state.mjs) and the modules that take it first: a shim’s connection
// (broker-shim.mjs), its calls (broker-tools.mjs) and prompts (broker-prompts.mjs), Postbox’s messages
// (broker-postbox.mjs), the snapshot (broker-snapshot.mjs) and its reading tools (broker-reading.mjs), the agent’s
// files (broker-files.mjs), the turn folder’s records (broker-records.mjs) and their replay (broker-replay.mjs), and
// Codex’s approvals (broker-codex.mjs).

import { checkWrite, watchCodex } from './broker-codex.mjs';
import { onHello, onMessage } from './broker-postbox.mjs';
import { stopTurn } from './broker-prompts.mjs';
import { load } from './broker-replay.mjs';
import { shimConnection } from './broker-shim.mjs';
import { saveSnapshot } from './broker-snapshot.mjs';
import { brokerState } from './broker-state.mjs';

export { CODEX_DECLINE, codexDeclineLine, codexPromptId } from './broker-codex.mjs';
export { inlineAppFiles } from './broker-files.mjs';
export { readConversation, readMessage } from './broker-reading.mjs';
export { CODEX_POLL_MS, STOPPED_TEXT } from './broker-state.mjs';

/**
 * The broker for one daemon. Everything it needs from the daemon is passed in, so tests drive it without one.
 * @param {import('./broker-state.mjs').BrokerOptions} o
 */
export function createBroker(o) {
  const b = brokerState(o);
  return {
    /** A shim’s connection to the daemon’s socket. Its first line is its hello. @param {{ first: string, write: (s: string) => boolean, end: () => void }} io */
    shim: (io) => shimConnection(b, io),
    /** @param {any} m @param {{ send: (type: string, body: Record<string, unknown>) => void, fail: (code: string, text: string) => void }} reply */
    message: (m, reply) => onMessage(b, m, reply),
    /** @param {(type: string, body: Record<string, unknown>) => void} send */
    hello: (send) => onHello(b, send),
    /** Replays every turn folder’s records, and starts watching the held Codex turns still running. @param {{ turn: string, state: string }[]} turns */
    load: (turns) => load(b, turns),
    /** Before a turn’s runner starts: its snapshot, sent before `start`, goes into the new folder. @param {string} turn */
    async starting(turn) {
      const snap = b.pendingSnapshots.get(turn);
      if (snap) await saveSnapshot(b, turn, snap);
    },
    /** Once a turn’s runner is up. @param {string} turn */
    started: (turn) => watchCodex(b, turn),
    /** Stop arrived for a turn: its shims are refused from now on, and its prompts can’t be answered. @param {string} turn */
    stopping: (turn) => stopTurn(b, turn),
    /** @param {string} turn @param {string} line */
    checkWrite: (turn, line) => checkWrite(b, turn, line),
    /** Whether a turn is stopping. @param {string} turn */
    isStopping: (turn) => b.stopping.has(turn),
    close() {
      b.closed = true;
      for (const w of b.watches.values()) if (w.timer) b.timers.clearTimeout(w.timer);
      b.watches.clear();
      for (const t of b.orphanTimers) b.timers.clearTimeout(t);
      b.orphanTimers.clear();
    },
    /** For tests: what waits. */
    get pending() {
      return {
        tools: [...b.tools.values()].filter((t) => !t.replied),
        prompts: [...b.prompts.values()],
        expiries: [...b.expiries.values()],
        watches: [...b.watches.keys()],
      };
    },
  };
}
