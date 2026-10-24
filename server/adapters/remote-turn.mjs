// What every backend’s remote turn (#120, ctx.remote) shares: the host’s stdio shim as Postbox’s server, how long a
// call to it can wait on Postbox, and where the agent reads the message’s attachments there. Each adapter’s own remote
// module (claude-code-remote.mjs, codex-remote.mjs, kiro-cli-remote.mjs) puts them where its CLI reads its servers.

import { ATTACHMENTS_DIR, hostPaths } from '../../shared/remote-protocol.mjs';
import { defaultHostSettings } from '../../shared/remote-settings.mjs';
import { shimArgs } from './adapter.mjs';

/**
 * The host’s permissionWaitMax, in milliseconds: its settings’, else the default (shared/remote-settings.mjs).
 * @param {import('./adapter.mjs').RemoteContext} remote
 */
export const hostWaitMax = (remote) =>
  Number.isInteger(remote.settings?.permissionWaitMax) ? remote.settings.permissionWaitMax : defaultHostSettings().permissionWaitMax;

/**
 * The shim as a command: the host’s node, running the shim of the Postbox installed there (ctx.remote.version) for
 * host turn `turn`.
 * @param {import('./adapter.mjs').RemoteContext} remote @param {any} welcome  the daemon’s latest @param {string} turn
 */
export const hostShim = (remote, welcome, turn) => ({
  command: welcome.node.path,
  args: shimArgs(remote, hostPaths(welcome.home, remote.version).shim, turn),
});

/**
 * Where a turn’s agent reads each attachment of its message, as guide.mjs’s formatMessage asks: on a host, its copy in
 * host turn `turn`’s folder, which that turn’s start carries (startAttachments), or nowhere for one the runtime didn’t
 * carry; on this computer, ctx.pathOf. The host’s paths are worked out only for an attachment that has a copy.
 * @param {any} ctx @param {string | null | undefined} turn  the host turn the message goes to
 * @returns {(a: any) => string | null}
 */
export function attachmentPaths(ctx, turn) {
  /** @type {import('./adapter.mjs').RemoteContext | undefined} */
  const remote = ctx.remote;
  if (!remote) return ctx.pathOf ?? (() => null);
  return (a) => {
    const copy = turn ? (remote.attachments ?? []).find((x) => x.of === a) : null;
    const welcome = remote.welcome ?? remote.link?.welcome;
    return copy && turn ? hostPaths(welcome.home, remote.version).turn(turn, `${ATTACHMENTS_DIR}/${copy.name}`) : null;
  };
}

/** What a remote turn’s start carries of its attachments: each one’s name on the host and its bytes. @param {import('./adapter.mjs').RemoteContext} remote */
export const startAttachments = (remote) => (remote.attachments ?? []).map(({ name, base64 }) => ({ name, base64 }));
