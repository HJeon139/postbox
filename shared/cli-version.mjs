// A CLI’s version, read from what its `--version` prints, the same way here and on a host’s daemon
// (server/remote/host/programs.mjs). Builds print it in different places: “2.1.211 (Claude Code)”,
// “claude 2.1.319.1689 (…, channel stable)”, “codex-cli 0.167.0”, “0.167.0.945 (stable)”.

/**
 * The first x.y.z in `out`, with a pre-release or build suffix after `-` or `+`, else its first line, clipped; null
 * for no output.
 * @param {string} out
 */
export function versionIn(out) {
  const m = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(out);
  if (m) return m[0].slice(0, 200);
  const first = out.split('\n').find((l) => l.trim());
  return first ? first.trim().slice(0, 200) : null;
}
