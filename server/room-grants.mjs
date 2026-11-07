// Grant once (P0, Refs #852): a room rule the person saved with “Allow always in this room” on a permission card, and
// the decision it makes at settledCall. Packet: sprint4/grant-once-packet-r1.md (v3) with its r2 delta, read by critic
// and lead-security against sprint4/grant-once-security-criteria-r1.md.
//
// A rule is the person’s, and only theirs: it is made by their answer on a card (resolvePermission’s “room”), kept on
// the conversation in Postbox’s store (never in the agent’s folder, which the agent can write), keyed by the room, the
// persona’s id and the host, and removed from the Permissions panel or by Stop on a line it made. It names a shape
// (shared/grant-shapes.mjs), never a command, and every call is judged afresh against the project at the call: a push
// is Postbox’s own (push-on-request.mjs) to the repository the person set, never to the default branch; a gh call is
// run by Postbox with no shell (confirm-run.mjs), on the project’s repository, with what it posts scanned first.

import { realpath } from 'node:fs/promises';
import { grantShape, shapeKey } from '../shared/grant-shapes.mjs';
import { LIMITS } from '../shared/limits.mjs';
import { readBodyFile, subjectRepo } from './confirm-body.mjs';
import { clean, TEXT_FLAGS } from './confirm-grant.mjs';
import { ghConfigDir, ghConfigProblem } from './confirm-run.mjs';
import { httpError } from './helpers.mjs';
import { defaultBranch, gitDirs, isPushUrl, pushPlan } from './push-on-request.mjs';
import { newId } from './store.mjs';
import { personAsks } from './write-guard.mjs';

/**
 * Whether a granted gh call may post a body file nobody saw, with only the scan to check it. The person chose no
 * (block grant-once-body-file, as critic recommended): a body file keeps its card until the part judge lands.
 */
export const BODY_FILES_PASS = false;
/** A Bash call’s input may carry only these, as for a confirmed command (confirm-grant.mjs). */
const PLAIN_INPUT = new Set(['command', 'description', 'timeout']);
/** How many lines of a posted body the line shows. */
const BODY_HEAD_LINES = 10;

/**
 * The conversation a thread’s rules live on: the thread itself, or a topic thread’s parent. Read as pending, so a
 * rule saved or removed a moment ago counts at once.
 * @param {any} rt @param {string} threadId
 */
export function roomOf(rt, threadId) {
  const t = rt.store.pending.thread(threadId);
  if (t?.kind === 'topic' && t.parentId) return rt.store.pending.thread(t.parentId) ?? null;
  return t ?? null;
}

/** The rule for this room, persona, host and shape, or null. O(rules in the room). */
export function grantFor(rt, threadId, { personaId, hostId, key }) {
  const room = roomOf(rt, threadId);
  return (room?.grants ?? []).find((g) => g.personaId === personaId && g.hostId === hostId && g.shape === key) ?? null;
}

/**
 * What “Allow always in this room” would save for a card’s call, or null when there’s nothing it can save: the shape,
 * and the line the card shows under the button.
 * @param {any} rt @param {any} se @param {{ tool: unknown, input: any, hostId: string | null }} call
 */
export function grantOffer(rt, se, { tool, input, hostId }) {
  const persona = se && rt.persona(se.personaId);
  if (tool !== 'Bash' || hostId || !persona || !rt.readsRules(persona.backend)) return null;
  const shape = grantShape(input?.command);
  // A body file keeps its card (the person’s answer to grant-once-body-file), so a rule saved for one would never pass it.
  if (!shape || (shape.kind === 'gh' && shape.bodyFile && !BODY_FILES_PASS)) return null;
  const key = shapeKey(shape);
  const where = 'only to this project’s repository';
  const line =
    shape.kind === 'push'
      ? `Postbox will make \`git push\` for @${se.handle} in this room without asking: ${where}, never to main or its default branch. A push with a lease can replace that branch’s history.`
      : `Postbox will run \`${key}\` for @${se.handle} in this room without asking: ${where}, after a privacy scan of what it posts. A body file still asks you.`;
  return { shape: key, line };
}

/**
 * Saves the rule a card offered, on the person’s answer. One rule per room, persona, host and shape.
 * @param {any} rt @param {string} threadId @param {any} it  the permission card
 */
export function saveGrant(rt, threadId, it) {
  const se = rt.s.sessions[it.sessionId];
  const room = roomOf(rt, threadId);
  if (!it.roomGrant || !se || !room) throw httpError(409, 'There’s no rule to save for this one, so it can only be allowed once.');
  const hostId = it.remote?.hostId ?? null;
  const key = it.roomGrant.shape;
  if (grantFor(rt, threadId, { personaId: se.personaId, hostId, key })) return;
  const grant = { id: newId('gr'), personaId: se.personaId, handle: se.handle, hostId, shape: key, at: Date.now() };
  rt.putThread({ ...room, grants: [...(room.grants ?? []), grant] });
}

/**
 * Takes a rule away: from the Permissions panel, or by Stop on a line it made. The next call of that shape asks.
 * @param {any} rt @param {string} threadId @param {string} grantId
 */
export function removeGrant(rt, threadId, grantId) {
  const room = roomOf(rt, threadId);
  const grants = room?.grants ?? [];
  if (!grants.some((g) => g.id === grantId)) return false;
  rt.putThread({ ...room, grants: grants.filter((g) => g.id !== grantId) });
  return true;
}

/** The rules in a room, for the Permissions panel: the persona’s current handle, and rules of a deleted persona left out. */
export function grantsIn(rt, threadId) {
  return (roomOf(rt, threadId)?.grants ?? [])
    .filter((g) => rt.persona(g.personaId))
    .map((g) => ({ id: g.id, personaId: g.personaId, handle: rt.persona(g.personaId).handle, shape: g.shape, hostId: g.hostId, at: g.at }));
}

/**
 * settledCall’s found for a call a room rule covers, or null for a card: `{ threadId, how: 'granted', label, grantId }`
 * with the push Postbox makes, or the gh plan it runs.
 * @param {any} rt @param {string} sessionId @param {{ tool: string, input?: any, agentId?: string|null, bound?: boolean }} req
 */
export async function grantedFound(rt, sessionId, req) {
  const { tool, input, agentId, bound } = req;
  const turn = rt.turns.get(sessionId);
  const se = rt.s.sessions[sessionId];
  // A stream-bound Bash call of this session’s own turn here, with nothing but the command set (as confirm-grant.mjs).
  if (bound !== true || tool !== 'Bash' || agentId || !turn || turn.remote || !se) return null;
  if (typeof input?.command !== 'string' || Object.keys(input).some((k) => !PLAIN_INPUT.has(k))) return null;
  const persona = rt.persona(se.personaId);
  const shape = grantShape(input.command);
  if (!shape || !persona || !rt.readsRules(persona.backend)) return null;
  const rule = { personaId: se.personaId, hostId: null, key: shapeKey(shape) };
  const grant = grantFor(rt, turn.threadId, rule);
  if (!grant || (turn.granted ?? 0) >= LIMITS.roomGrantsPerTurn) return null;
  if (await personAsks(rt, sessionId, { tool, input })) return null;
  const { folder, project } = await rt.panelTarget({ sessionId });
  const made = shape.kind === 'push' ? await grantedPush(rt, shape, folder, project) : await grantedGh(shape, folder, project);
  // The reads took time: a rule removed meanwhile, or another turn, lets nothing through.
  if (!made || grantFor(rt, turn.threadId, rule)?.id !== grant.id || rt.turns.get(sessionId) !== turn) return null;
  turn.granted = (turn.granted ?? 0) + 1;
  return { threadId: turn.threadId, how: /** @type {const} */ ('granted'), label: rule.key, grantId: grant.id, ...made };
}

/** The real path of a repository’s shared git folder, which every worktree of it shares, or null. */
async function objectsOf(folder) {
  const dirs = folder ? await gitDirs(folder).catch(() => null) : null;
  return dirs ? realpath(dirs.common).catch(() => null) : null;
}

/**
 * The push Postbox makes for a granted `git push`, or null: from the folder the command names when it’s the agent’s
 * own repository or a worktree of it, to the URL the person set on the project, never to its default branch.
 */
async function grantedPush(rt, shape, folder, project) {
  const url = project?.pushUrl;
  if (!isPushUrl(url)) return null;
  const dir = shape.dir ?? folder;
  if (shape.dir) {
    const own = await Promise.all([objectsOf(folder), objectsOf(project?.folder)]);
    const theirs = await objectsOf(shape.dir);
    if (!theirs || !own.includes(theirs)) return null;
  }
  const plan = await pushPlan(dir, { branch: shape.branch });
  if (!plan) return null;
  // The default branch, from the remote itself: never .git’s origin/HEAD, which the agent can write. Unknown: a card.
  const main = await (rt.pushes?.defaultBranch ?? defaultBranch)(String(url));
  if (!main || main === plan.branch) return null;
  const how = shape.lease ? `with a lease on ${shape.lease.slice(0, 7)}` : 'with no force';
  return { push: { ...plan, url, lease: shape.lease, sentence: `commit ${plan.sha.slice(0, 7)} lands on branch ${plan.branch} of ${url}, ${how}` } };
}

/** The gh plan Postbox runs for a granted gh call, or null: the project’s repository, gh’s config clean, and what it posts scanned. */
async function grantedGh(shape, folder, project) {
  if (subjectRepo(project?.pushUrl) !== shape.repo.toLowerCase()) return null;
  if (await ghConfigProblem(ghConfigDir())) return null;
  const posted = shape.argv.filter((_, i) => TEXT_FLAGS.has(shape.argv[i - 1])).join('\n');
  if (!clean(posted)) return null;
  if (!shape.bodyFile) return { ghPlan: { argv: shape.argv, input: undefined } };
  if (!BODY_FILES_PASS) return null;
  // Only from the agent’s own folder or its project’s, and only text the scan finds clean (lead-security’s P1).
  const found = await Promise.all([folder, project?.folder].map((p) => (p ? realpath(p).catch(() => null) : null)));
  const places = /** @type {string[]} */ (found.filter(Boolean));
  const read = await readBodyFile(shape.bodyFile, places);
  if (!read.ok || !clean(read.file.text)) return null;
  const at = shape.argv.indexOf('--body-file');
  const argv = shape.argv.map((w, i) => (i === at + 1 ? '-' : w));
  const head = read.file.text.split('\n').slice(0, BODY_HEAD_LINES).join('\n');
  return { ghPlan: { argv, input: read.file.text }, body: { head, size: read.file.size } };
}

/** The allowed-call line’s fields for a granted call: the rule, and the body it posted. */
export const grantedFields = (found) =>
  found.how === 'granted' ? { granted: found.label, grantId: found.grantId, ...(found.body ? { body: found.body } : {}) } : {};

/**
 * The panel’s Remove (POST /api/permissions/rules with where “room”): the person takes a rule away from the room of the session
 * the panel was opened for.
 * @param {any} rt @param {{ sessionId?: string, grantId?: string }} body
 */
export function removeRoomGrant(rt, body) {
  const se = rt.s.sessions[String(body?.sessionId ?? '')];
  if (!se) throw httpError(404, 'Open the panel from a conversation to remove its rules.');
  if (!removeGrant(rt, se.threadId, String(body?.grantId ?? ''))) throw httpError(404, 'That rule was already removed.');
  return { ok: true };
}

/**
 * “Allow always in this room” on a card: this call, once, as asked; and its shape, from now on, in this room.
 * @param {any} rt @param {string} threadId @param {any} it  the card @param {string} asked  who asked to do what
 */
export function allowInRoom(rt, threadId, it, asked) {
  saveGrant(rt, threadId, it);
  rt.addItem(threadId, { kind: 'voice', text: `Allowed always in this room (${it.roomGrant.shape}): ${asked}` });
  rt.settlePermission(it.id, 'allowed');
  return { ok: true };
}
