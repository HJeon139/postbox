// Grant once (P0, Refs #852): the calls a room rule the person saved can pass, read from the words alone. Packet:
// sprint4/grant-once-packet-r1.md (v3) with its r2 delta. One command, after an optional `cd <dir> &&` or with
// `git -C <dir>`: a push of a named branch to origin, with at most an explicit lease, or one of slice 1a’s six gh shapes
// with --repo. Anything else is null, which means a card. The folder, repository and branch are checked against the
// disk and the project at the call (server/room-grants.mjs); this reads words only.

import { confirmShape, PUSH_BRANCH, shapeWords } from './confirm-shapes.mjs';

/** The labels a rule never adds or removes: the integrator’s label skips critic’s sign-off (lead-security’s P3). */
const RESERVED_LABELS = new Set(['ready for integrator']);
/** Branches a rule never pushes to by name, whatever the remote says its default is. */
const NEVER_BRANCHES = new Set(['main', 'master']);
const PUSH_FLAGS = new Set(['-u', '--set-upstream']);
const LEASE = /^--force-with-lease=([^:]+):([0-9a-f]{40})$/;
const LEADING_CD = /^cd (\/[^\s'"`$&|;<>()\\*?]*) && (.+)$/;

/**
 * @typedef {{ kind: 'push', branch: string, lease: string | null, dir: string | null }} PushShape
 * @typedef {{ kind: 'gh', noun: string, verb: string, repo: string, argv: string[], bodyFile: string | null, dir: string | null }} GhShape
 */

/**
 * What a command is, as a room rule reads it, or null for a card.
 * @param {string} command @returns {PushShape | GhShape | null}
 */
export function grantShape(command) {
  const text = String(command ?? '');
  const cd = LEADING_CD.exec(text);
  const dir = cd ? cd[1] : null;
  const rest = cd ? cd[2] : text;
  const words = shapeWords(rest);
  if (!words?.length) return null;
  if (words[0] === 'git') return pushShape(words, dir);
  if (words[0] === 'gh') return ghShape(rest, dir);
  return null;
}

/** The rule a shape is saved under: `git push`, or `gh <noun> <verb>`. */
export const shapeKey = (/** @type {PushShape | GhShape} */ shape) => (shape.kind === 'push' ? 'git push' : `gh ${shape.noun} ${shape.verb}`);

/** @param {string[]} words @param {string | null} dir @returns {PushShape | null} */
function pushShape(words, dir) {
  const minusC = words[1] === '-C';
  if (minusC && (dir || !words[2]?.startsWith('/'))) return null;
  const [sub, ...args] = minusC ? words.slice(3) : words.slice(1);
  if (sub !== 'push') return null;
  const leases = args.filter((w) => w.startsWith('--force-with-lease'));
  const plain = args.filter((w) => !PUSH_FLAGS.has(w) && !w.startsWith('--force-with-lease'));
  if (leases.length > 1 || plain.some((w) => w.startsWith('-'))) return null;
  const [remote, branch, ...more] = plain;
  if (remote !== 'origin' || !branch || more.length || branch === 'HEAD' || !PUSH_BRANCH.test(branch)) return null;
  if (NEVER_BRANCHES.has(branch)) return null;
  const lease = leases.length ? LEASE.exec(leases[0]) : null;
  if (leases.length && (!lease || lease[1] !== branch)) return null;
  return { kind: 'push', branch, lease: lease ? lease[2] : null, dir: minusC ? words[2] : dir };
}

/** @param {string} text @param {string | null} dir @returns {GhShape | null} */
function ghShape(text, dir) {
  const shape = confirmShape(text);
  if (shape.kind !== 'gh') return null;
  const { argv } = shape;
  const labels = argv.filter((_, i) => argv[i - 1] === '--add-label' || argv[i - 1] === '--remove-label' || argv[i - 1] === '--label');
  if (labels.some((l) => RESERVED_LABELS.has(l.trim().toLowerCase()))) return null;
  return { kind: 'gh', noun: argv[0], verb: argv[1], repo: shape.repo, argv, bodyFile: shape.bodyFile, dir };
}
