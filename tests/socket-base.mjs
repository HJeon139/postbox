// Where a test fixture that binds Unix sockets makes its temp folder (#797): under TMPDIR, the gate run’s own folder
// that npm run check removes, when the longest socket path the fixture builds still fits in sun_path there, else /tmp.
// macOS’s own temp folder is deep enough to push a socket path past it.

import { hostVersion } from '../server/remote/host/paths.mjs';
import { hostPaths, TURN_FILES } from '../shared/remote-protocol.mjs';
import { tempDir } from './temp-dirs.mjs';

/** sun_path’s size, with its terminating NUL: a socket’s path must be shorter. */
export const SUN_PATH_BYTES = { darwin: 104, linux: 108 };

/**
 * The folder to make a fixture’s temp folder in.
 * @param {string} prefix  mkdtemp’s prefix, which it follows with six characters
 * @param {(dir: string) => string} longest  the longest socket path the fixture builds under the folder it makes
 * @param {{ env?: Record<string, string | undefined>, platform?: string }} [o]
 */
export function socketBase(prefix, longest, { env = process.env, platform = process.platform } = {}) {
  const tmp = env.TMPDIR?.replace(/\/+$/, '');
  if (!tmp?.startsWith('/')) return '/tmp';
  const limit = SUN_PATH_BYTES[/** @type {keyof SUN_PATH_BYTES} */ (platform)] ?? SUN_PATH_BYTES.darwin;
  return Buffer.byteLength(longest(`${tmp}/${prefix}XXXXXX`)) < limit ? tmp : '/tmp';
}

/** The longest socket path of a host home: a turn’s, with the longest turn ID, or the daemon’s. @param {string} home */
export function longestHostSocket(home) {
  const p = hostPaths(home, hostVersion());
  return [p.turn('t'.repeat(36), TURN_FILES.socket), p.socket].reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a));
}

/**
 * socketBase for a fixture whose host home is `sub` inside the folder it makes.
 * @param {string} prefix @param {string} sub  such as '/h', or '' for the folder itself
 * @param {{ env?: Record<string, string | undefined>, platform?: string }} [o]
 */
export const hostSocketBase = (prefix, sub, o) => socketBase(prefix, (dir) => longestHostSocket(`${dir}${sub}`), o);

/**
 * A unit fixture’s host home (#802): a temp folder removed when the test file ends, under TMPDIR when the home’s
 * sockets fit there, else under /tmp. The gate’s run folder under macOS’s temp folder is too deep for them.
 * @param {string} prefix
 */
export const hostHome = (prefix) => tempDir(prefix, hostSocketBase(prefix, ''));
