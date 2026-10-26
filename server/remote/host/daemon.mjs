// The daemon on a remote host (#120, the design’s “The daemon”, “Postbox and the daemon”, “Files and cleanup”). It
// speaks shared/remote-protocol.mjs’s postbox-to-daemon and daemon-to-postbox channels, starts each turn as a runner
// (runner.mjs), hands Postbox each turn’s out.jsonl from any byte offset and follows it, and stops a turn only when its
// runner is still the process runner.json names.
//
// One daemon per version, and the processes `ssh` starts. Every `host attach` is a separate process started by ssh, so
// one daemon needs coordination. The daemon is its own process, `host serve`, listening on paths().socket in the
// version’s 0700 folder; `host attach` is only a relay that pipes its stdio (the SSH channel) to that socket:
// 1. attach connects to the socket. If a daemon answers, it relays, and that’s all.
// 2. Otherwise it takes the version’s start lock (paths().lock, ~/.postbox-remote/locks/<version>.lock), a folder made
//    with mkdir (atomic), connects once more (another attach may have just started one), and if nobody answers, makes
//    the version’s folder if it’s missing (a checkout’s), starts `host serve` detached, waits for its socket to answer,
//    drops the lock and relays. The installer holds the same lock while it checks and replaces the version’s folder
//    (install.mjs), so the lock is outside that folder, and an attach makes nothing in it without the lock. The lock
//    holds its owner’s record (proc.mjs, “The start lock’s owner”), and is broken only once that owner is gone, or
//    once it has had no record for LOCK_STALE_MS; its age alone never breaks it, however long an install holds it.
//    Each holder drops it only while the record in it is still its own. A stale one is removed under <lock>.break,
//    which holds its breaker’s record the same way, so a breaker suspended mid-removal keeps it (holdBreak).
// 3. serve takes the daemon’s own lock for its whole life: daemon.pid, made with O_EXCL, holding its PID, boot ID and
//    start time. One that names a live process (proc.mjs’s sameProcess) means a daemon is up or starting, and serve
//    exits; one that doesn’t is from a daemon that died, and is removed (under daemon.pid.break, so two serves that
//    both find it stale can’t remove a fresh one; it holds its serve’s record, as <lock>.break does). Only while it holds daemon.pid does serve connect once more, remove
//    a stale socket file (nothing answers: ENOENT or ECONNREFUSED; any other error is reported, and the file is left)
//    and bind. So the start lock going stale under a slow start can’t start a second daemon.
// The first attach doesn’t become the daemon itself, though that’s one process fewer: the daemon outlives the attach
// that started it, and sshd ends a session only once the channel’s stdout and stderr close, so a daemon holding them
// would keep that ssh open after Postbox dropped or was taken over. A relay closes them when its socket closes.
// Where logind kills a session’s processes at logout, the daemon goes with the session that started it; that’s
// harmless, since turns don’t need it (runners have their own scope) and the next attach restarts it from disk.
//
// The daemon’s socket also serves each turn’s shim (shim-to-daemon). A connection’s first line says which it is: a
// Postbox hello has `version`, a shim’s has `turn`. Serving the shim (tool calls, permission prompts, the snapshot’s
// reading tools) and declining Codex’s approvals at permissionWaitMax is broker.mjs’s; this file hands it each shim
// connection and the Postbox messages it owns (snapshot, snapshot-items, answer, reply), and tells it when a turn
// starts, when Stop arrives, and before a line goes to a held stdin. Tests can pass their own (`broker`, `shim`).
//
// Its log is its stderr: the attach’s for the relay, daemon.log in the version’s folder for serve. stdout carries
// protocol messages only.
//
// The modules, each a concern of the daemon’s, taking its state (`d`, daemon-constants.mjs’s Daemon) first:
// daemon-create.mjs (createDaemon), daemon-conn.mjs (connections), daemon-hello.mjs, daemon-start.mjs,
// daemon-read.mjs and daemon-follow.mjs (read and ack), daemon-write.mjs, daemon-stop.mjs, daemon-remove.mjs,
// daemon-check.mjs (the sign-in check), daemon-scan.mjs (turn folders and timers), daemon-reply.mjs and
// daemon-files.mjs. The `host` program is daemon-main.mjs, with its locks in daemon-locks.mjs. This file re-exports
// what they offer outside the daemon.

export {
  ASK_TIMEOUT_MS,
  EXIT,
  HOST_ENTRY,
  LOCK_STALE_MS,
  POLL_MS,
  REMOVE_WAIT_MS,
  RUNNER_START_MS,
  SERVE_START_MS,
  STOP_GRACE_MS,
} from './daemon-constants.mjs';
export { createDaemon } from './daemon-create.mjs';
export { ensureToken } from './daemon-files.mjs';
export { dropLock, takeDaemonLock, takeLock } from './daemon-locks.mjs';
export { main, tryConnect } from './daemon-main.mjs';
export { defaultWriteRunner } from './daemon-write.mjs';

/**
 * @typedef {import('./daemon-constants.mjs').Broker} Broker
 * @typedef {import('./daemon-constants.mjs').ShimSeam} ShimSeam
 * @typedef {import('./daemon-constants.mjs').TurnFound} TurnFound
 * @typedef {import('./daemon-main.mjs').MainOpts} MainOpts
 * @typedef {import('./daemon-locks.mjs').LockProc} LockProc
 */
