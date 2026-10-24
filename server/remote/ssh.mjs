// The laptop’s connection to one remote host (#120): the system `ssh`, started by Postbox with fixed options and a
// fixed remote command, carrying shared/remote-protocol.mjs’s JSON lines over its stdio to the host’s daemon. The design
// is architecture.md, “Remote hosts”, sections “The SSH connection” and “Security”.
//
// - ssh is started from an argument array, never a shell on the laptop. On the host, sshd hands the one command string
//   to the login shell, so that string is fixed: the code folder for a validated version, then `attach`. Everything
//   else (the token, settings, turns) goes as JSON on stdin, so no shell ever parses a prompt, a path or a setting.
// - Command-line options come first, so they win over ~/.ssh/config: “for each configuration directive, the first
//   specified value will be used”, and command-line options are read before the user’s file (ssh_config(5)). The
//   person’s config still supplies everything these don’t set (ProxyJump, certificates, known hosts, a user).
// - A failure is classified from ssh’s exit status and stderr, or from the daemon’s `error` to hello, so the UI can say
//   what happened and what the person can do next (FAILURE_KINDS). ssh “exits with the exit status of the remote
//   command or with 255 if an error occurred” (ssh(1), EXIT STATUS).
// - Reconnecting is a policy the caller drives (createReconnector): Postbox retries with capped, jittered backoff only
//   while it needs the host (a turn running, a prompt waiting) and at once on the laptop’s wake (D2), and never retries
//   what only the person can fix.
//
// The daemon’s token: the daemon creates it on the host (~/.postbox-remote/token, 0600); install (L2) reads it back
// over ssh and keeps it on the laptop in its own file under Postbox’s data folder, `data/remote-tokens/<host id>`,
// mode 0600, never in the state the page reads. This module only takes it as `token` and sends it in hello, on stdin,
// never as an argument, which other local users could read from the process list.
//
// This module is the connection’s one entry point; its parts are beside it: ssh-args.mjs (the arguments and the remote
// command), ssh-failures.mjs, ssh-connection.mjs and ssh-reconnect.mjs.

export { helloSettings, remoteCommand, sshArgs } from './ssh-args.mjs';
export { createSshConnection, WELCOME_TIMEOUT } from './ssh-connection.mjs';
export { classifyExit, FAILURE_KINDS, failure, retries, SshFailure } from './ssh-failures.mjs';
export { BACKOFF, backoffDelay, createReconnector } from './ssh-reconnect.mjs';

/** @typedef {import('./ssh-failures.mjs').FailureKind} FailureKind */
/** @typedef {import('./ssh-connection.mjs').SshChild} SshChild */
/** @typedef {import('./ssh-connection.mjs').SpawnLike} SpawnLike */
