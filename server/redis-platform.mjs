// Where Postbox runs: the platforms it has a Redis 8 build for (designs/508/design.md, “Storage: a Redis 8 server that
// Postbox bundles and runs”, “License and platforms”). macOS on Intel has no build (Homebrew has none for it either),
// and Redis doesn’t support Windows, so Postbox refuses to start on either before it downloads anything.

/** @typedef {'darwin-arm64' | 'linux-arm64' | 'linux-x64'} RedisTarget */

/** @type {readonly string[]} */
const TARGETS = ['darwin-arm64', 'linux-arm64', 'linux-x64'];

const SUPPORTED = 'macOS on Apple silicon (arm64), Linux on arm64 and Linux on x64';

/**
 * A platform as people know it.
 * @param {string} platform  as `process.platform` names it
 * @param {string} arch  as `process.arch` names it
 */
function platformName(platform, arch) {
  if (platform === 'darwin' && arch === 'x64') return 'macOS on Intel';
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return platform;
}

/**
 * Whether Postbox runs here, and on which build. Pure: the caller passes `process.platform` and `process.arch`.
 * @param {{ platform: string, arch: string }} host
 * @returns {{ ok: true, target: RedisTarget } | { ok: false, message: string }}
 */
export function checkPlatform({ platform, arch }) {
  const target = `${platform}-${arch}`;
  if (TARGETS.includes(target)) return { ok: true, target: /** @type {RedisTarget} */ (target) };
  const next = platform === 'win32' ? 'Run Postbox on one of those, such as Linux on x64 in WSL.' : 'Run Postbox on one of those.';
  return {
    ok: false,
    message: `Postbox doesn’t run on ${platformName(platform, arch)} (${platform} ${arch}). Its store is a Redis 8 server, and Postbox has a build of it only for ${SUPPORTED}. ${next}`,
  };
}
