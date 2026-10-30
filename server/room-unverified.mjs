// What a check says of what it couldn’t read (#508): an agent with no Claude Code transcript, a turn with no line in
// it, and which backend each runs on. Not defects: each is kept apart as unverified, so a check skipped on Codex, Kiro
// or Antigravity never reads as a pass (server/room-checks.mjs’s liveChecks, tools/uat/report.mjs). Moved whole from
// server/room-delivery.mjs, for size.

import { MIN_WHOLE, plain } from './room-delivery.mjs';

/** The backends by their persona’s id (server/adapters/*.mjs’s name), as a report names them. */
const BACKEND_NAMES = {
  'claude-code': 'Claude Code',
  'agent-sdk': 'the Agent SDK',
  codex: 'Codex',
  'kiro-cli': 'Kiro',
  'antigravity-cli': 'Antigravity',
  mock: 'the mock backend',
};

/** A backend as a report names it. @param {string|null} backend */
export const backendName = (backend) => BACKEND_NAMES[backend ?? ''] ?? backend ?? 'an unknown backend';

/** The backend an agent runs on: its session’s persona’s, or a persona of its handle’s; null when the state has neither. */
export function backendOf(f, handle) {
  const personas = f.state?.personas ?? {};
  const se = Object.values(f.state?.sessions ?? {}).find((x) => x?.handle === handle && personas[x.personaId]);
  return (se ? personas[se.personaId] : Object.values(personas).find((p) => p?.handle === handle))?.backend ?? null;
}

/**
 * What a check says of an agent whose inputs it can’t read (no Claude Code transcript of it): that it didn’t check
 * it, on which backend, and for how many deliveries. Not a defect, so it neither fails a run nor gets filed; the
 * report lists it under “Checks not verified”, so a check skipped on Codex, Kiro or Antigravity never reads as a pass.
 * @param {any} f  @param {string} check  @param {string} handle  @param {number} n  the deliveries it couldn’t check
 */
export function notCheckable(f, check, handle, n) {
  const backend = backendOf(f, handle);
  const name = backendName(backend);
  const why =
    backend === 'claude-code' || backend === null
      ? 'this run recorded no Claude Code transcript of it'
      : `what reaches an agent is read from its Claude Code transcript, and ${name} writes none`;
  return {
    key: `${check}:unverified:${handle}`,
    issue: null,
    title: `${check} isn’t checkable for @${handle} on ${name}`,
    evidence: `${n} ${n === 1 ? 'delivery' : 'deliveries'} to @${handle} went unchecked: ${why}, so what reached it can’t be read.`,
    verdict: 'measurement',
    note: `Not a defect: ${check} couldn’t check @${handle}, so this run doesn’t verify it on ${name}.`,
    unverified: { check, handle, backend },
  };
}

/**
 * What a check says of a turn it can’t read: an agent with a transcript can still have a turn it holds no line of,
 * as when Send now stopped the turn before Claude Code wrote its prompt. A delivery due in that turn may have reached
 * it or not, so the check says it didn’t check it there, rather than calling it lost or arrived.
 * @param {any} f  @param {string} check  @param {string} handle  @param {{ started: number, output: boolean }} turn
 * @param {number} n  the deliveries it couldn’t check
 */
export function notCheckableTurn(f, check, handle, turn, n) {
  const at = new Date(turn.started).toISOString();
  return {
    key: `${check}:unverified:${handle}:${at}`,
    issue: null,
    title: `${check} isn’t checkable for @${handle}: its turn at ${at} has no recorded transcript`,
    evidence: `${n} ${n === 1 ? 'delivery' : 'deliveries'} to @${handle} went unchecked: ${n === 1 ? 'it was' : 'they were'} due in its turn at ${at}, which${turn.output ? '' : ' wrote nothing and'} left no line in its Claude Code transcript (a turn stopped before Claude Code wrote its prompt, as Send now can), so what reached it then can’t be read.`,
    verdict: 'measurement',
    note: `Not a defect: ${check} couldn’t check @${handle}’s turn at ${at}, so this run doesn’t verify it there.`,
    unverified: { check, handle, backend: backendOf(f, handle), turn: at },
  };
}

/**
 * What a check says of a delivery it can’t tell from other text (room-delivery.mjs’s tellable): a message too short for
 * a head or a whole match, that none of its agent’s inputs names by its id. Unverified, not a defect.
 * @param {any} f  @param {string} check  @param {{ to: string, itemId: string|null, text: string }} a
 */
export function notCheckableText(f, check, a) {
  const name = a.itemId ?? plain(a.text);
  return {
    key: `${check}:unverified:${a.to}:${name}`,
    issue: null,
    title: `${check} isn’t checkable for ${a.itemId ?? 'a delivery'} to @${a.to}: its text is too short to tell from other text`,
    evidence: `The message to @${a.to} (“${a.text}”) has ${plain(a.text).length} letters and digits, fewer than the ${MIN_WHOLE} a whole match needs, and none of @${a.to}’s prompts or tool results names its item, so the check can’t tell whether it arrived.`,
    verdict: 'measurement',
    note: `Not a defect: ${check} couldn’t tell ${name} from other text for @${a.to}, so this run doesn’t verify it there.`,
    unverified: { check, handle: a.to, backend: backendOf(f, a.to), item: a.itemId ?? null },
  };
}

/**
 * Counts a delivery a check couldn’t read: for an agent, when there’s no transcript of it; for one of its turns, when
 * there’s a transcript but none of that turn.
 * @param {Map<string, { handle: string, turn: any, n: number }>} unread  @param {string} handle  @param {any} [turn]
 */
export function unreadable(unread, handle, turn = null) {
  const k = turn ? `${handle}@${turn.started}` : handle;
  unread.set(k, { handle, turn, n: (unread.get(k)?.n ?? 0) + 1 });
}

/** The not-checkable records for a check, from its unreadable deliveries (unreadable). */
export const notCheckableAll = (f, check, unread) =>
  [...unread.values()].map(({ handle, turn, n }) => (turn ? notCheckableTurn(f, check, handle, turn, n) : notCheckable(f, check, handle, n)));
