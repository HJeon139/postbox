// What every backend’s remote turn (#120, ctx.remote) shares: the host’s stdio shim as Postbox’s server, and how long a
// call to it can wait on Postbox. Each adapter’s own remote module (claude-code-remote.mjs, codex-remote.mjs,
// kiro-cli-remote.mjs) puts them where its CLI reads its servers.

import { hostPaths } from '../../shared/remote-protocol.mjs';
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
