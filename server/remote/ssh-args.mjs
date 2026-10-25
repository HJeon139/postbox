// ssh’s arguments for one host, and the one remote command sshd runs there (ssh.mjs, whose header says why both are
// fixed): options first, so they win over ~/.ssh/config, then the checked destination, then the command.

import { HOST_ENFORCED, hostPaths } from '../../shared/remote-protocol.mjs';
import { checkDestination, checkHostSettings } from '../../shared/remote-settings.mjs';

/**
 * The command sshd runs on the host, through the login shell, which expands the ~. The version is checked as
 * hostPaths checks it, and the path is hostPaths’ `host`, so install, the daemon and this agree on one layout.
 * @param {string} version  Postbox’s package version, such as 0.10.0
 */
export function remoteCommand(version) {
  const host = hostPaths('/', version).host; // /.postbox-remote/<version>/server/remote/host/host
  // hostPaths allows only letters, digits, . + and - in a version; checked again here, since the shell reads this.
  if (!/^[A-Za-z0-9/.+-]+$/.test(host)) throw new TypeError(`“${version}” isn’t a version Postbox installs.`);
  return `~${host} attach`;
}

/**
 * The options every connection gets, whatever ~/.ssh/config says for the host (sshArgs), since “the first specified
 * value will be used” and the command line comes first (ssh_config(5)). Postbox calls the daemon one way only, and
 * nothing listens on TCP (architecture.md, “Remote hosts”), so a config’s RemoteForward back to Postbox’s port, a
 * LocalForward or DynamicForward listener here, X11 with this computer’s display, a LocalCommand or a tunnel device
 * would each break that: ClearAllForwardings drops the forwards “from the configuration files and command line”.
 * StrictHostKeyChecking=yes refuses a host key that isn’t already known, or has changed, even where a config says
 * `no`, which “allows changed keys to proceed” whatever BatchMode says, and the hello would hand the daemon’s token to
 * whoever answered. Over a shared connection (dedicatedConnection off) the session still sends its own agent and X11
 * choices, but the leader’s port forwards stay as they are (the hosts settings say so).
 */
export const HARDENING = Object.freeze([
  'ClearAllForwardings=yes',
  'ForwardX11=no',
  'ForwardX11Trusted=no',
  'PermitLocalCommand=no',
  'Tunnel=no',
  'StrictHostKeyChecking=yes',
]);

/**
 * ssh’s arguments for one host, without the program. The destination is checked here as well as where it entered, so
 * one starting with “-” never reaches ssh, which would read it as an option.
 * @param {{ destination: string, settings: import('../../shared/remote-settings.mjs').HostSettings, version: string }} o
 * @returns {string[]}
 */
export function sshArgs({ destination, settings, version }) {
  const d = checkDestination(destination);
  if (!d.ok) throw new TypeError(d.error);
  const s = checkHostSettings(settings, settings);
  if (!s.ok) throw new TypeError(s.error);
  const { keepAlive, dedicatedConnection, forwardAgent } = s.value;
  return [
    // “If set to yes, user interaction such as password prompts and host key confirmation requests will be disabled”
    // (ssh_config(5), BatchMode), so ssh fails at once instead of waiting on a prompt nobody sees.
    '-o',
    'BatchMode=yes',
    // A session on a multiplexed connection gets the leader’s options, so these wouldn’t apply; “the string none”
    // disables connection sharing (ssh_config(5), ControlPath). dedicatedConnection off keeps the person’s own.
    ...(dedicatedConnection ? ['-o', 'ControlPath=none'] : []),
    // “Specifies whether the connection to the authentication agent (if any) will be forwarded to the remote
    // machine” (ssh_config(5), ForwardAgent). Off unless the host’s settings turn it on.
    '-o',
    `ForwardAgent=${forwardAgent ? 'yes' : 'no'}`,
    // A keepalive after this many seconds “if no data has been received from the server”, and ssh disconnects after
    // ServerAliveCountMax unanswered: 15 s × 3 is “approximately 45 seconds” (ssh_config(5), ServerAliveInterval and
    // ServerAliveCountMax). The setting is in milliseconds, in whole seconds (remote-settings.mjs).
    '-o',
    `ServerAliveInterval=${Math.round(keepAlive.interval / 1000)}`,
    '-o',
    `ServerAliveCountMax=${keepAlive.count}`,
    // Nothing from ~/.ssh/config that opens a way back, or a listener, or trusts a host it shouldn’t (HARDENING).
    ...HARDENING.flatMap((o) => ['-o', o]),
    // “Disable pseudo-terminal allocation” (ssh(1), -T): the channel carries JSON lines, which a tty would mangle.
    '-T',
    // ssh(1) doesn’t document “--”, but ssh parses its options with getopt(3), which ends them at “--”, and
    // openssh-portable’s ssh.c then sets opt_terminated, so the words after the destination aren’t parsed as options
    // either (without it, ssh re-reads them for options: the `goto again` after the host). So even a destination that
    // got past checkDestination with a leading “-” would be a destination, and the command stays a command.
    '--',
    d.value,
    // ssh(1): “If a command is specified, it will be executed on the remote host instead of a login shell.” One
    // argument, since ssh joins the words of a command with spaces anyway.
    remoteCommand(version),
  ];
}

/** The settings hello carries: HOST_ENFORCED, from the host’s settings. @param {import('../../shared/remote-settings.mjs').HostSettings} settings */
export function helloSettings(settings) {
  return Object.fromEntries(HOST_ENFORCED.map((k) => [k, structuredClone(settings[k])]));
}
