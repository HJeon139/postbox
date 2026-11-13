// Hung remote turns, and the waits for a host (#120, server/remote/turns.mjs, the header; D2): a turn quiet for its
// host’s stallTimeout is stopped, one Interrupted resumes on its own once the host is back, one stopped with Sign-in
// needed only once the host’s signInCheck passes, and a turn Postbox restarted during is attached again once the
// host’s welcome lists it.

import { defaultHostSettings } from '../../shared/remote-settings.mjs';
import { hostOf, unregisteredWhy } from './placement.mjs';
import { backgroundStopText, waitingOnBackground } from './turns-background.mjs';
import { releaseHost } from './turns-need.mjs';
import { continuing } from './turns-origin.mjs';
import { endOrphanCards } from './turns-prompts.mjs';
import { AUTO_RESUMES, clock, isBack, ON_HOST, SIGN_IN_RECHECK_MS, updateRemote } from './turns-shared.mjs';
import { askStop } from './turns-stops.mjs';

/** @typedef {import('./turns.mjs').RemoteTurns} RemoteTurns */

/** The periodic look: stalls, and sign-in waits whose check is due. @param {RemoteTurns} rts */
export function tick(rts) {
  checkStalls(rts);
  for (const se of Object.values(rts.rt.s.sessions))
    if (se.remoteTurn?.state === 'signin' && se.remoteTurn.resume && rts.now() - (rts.checkedAt.get(se.id) ?? 0) >= SIGN_IN_RECHECK_MS)
      void trySignInResume(rts, se.id);
}

/** Stops each running remote turn that has been quiet for its host’s stallTimeout with nothing open. @param {RemoteTurns} rts */
export function checkStalls(rts) {
  const now = rts.now();
  for (const live of [...rts.live.values()]) {
    if (live.rt.closed || live.hung || !live.current || !live.link?.connected) continue;
    const host = rts.rt.s.hosts?.[live.hostId];
    const stall = Number(host?.settings?.stallTimeout ?? defaultHostSettings().stallTimeout);
    if (now - live.lastEvent < stall) continue;
    // Waiting on you isn’t hung, and neither is an open tool call for an adapter that prints nothing while one runs.
    if ([...rts.rt.permissionWaits.values()].some((w) => w.sessionId === live.sessionId)) continue;
    if (live.work === 'open-tool-call' && live.rt.steps.some((/** @type {any} */ s) => s.state === 'running')) continue;
    // Nor is a result sent with a background task still open, up to its ceiling (#847).
    if (waitingOnBackground(live, now)) continue;
    const text = backgroundStopText(live) ?? `Stopped: no output for ${Math.round(stall / 60_000)} min (the last at ${clock(live.lastEvent)})`;
    live.hung = { at: live.lastEvent, text };
    rts.rt.stop(live.sessionId, { by: 'hung', why: text });
  }
}

/** @param {RemoteTurns} rts @param {string} hostId */
export async function signInCheck(rts, hostId) {
  try {
    return (await rts.hosts?.signInCheck(hostId)) ?? null;
  } catch {
    return { ok: false, code: null, at: rts.now() };
  }
}

/** A host’s connection changed: one back attaches, resumes or checks the turns that wait for it. @param {RemoteTurns} rts @param {string} hostId @param {any} status */
export function onHostStatus(rts, hostId, status) {
  if (!isBack(status)) return;
  for (const se of Object.values(rts.rt.s.sessions)) {
    const r = se.remoteTurn;
    if (r?.hostId !== hostId || rts.live.has(se.id)) continue;
    if (ON_HOST.has(r.state) && rts.restoring.has(r.turn)) void reattach(rts, se.id);
    else if (r.state === 'interrupted' && r.resume) autoResume(rts, se.id);
    else if (r.state === 'signin' && r.resume) void trySignInResume(rts, se.id);
  }
}

/** After Interrupted: resume now if the host is up, else when it’s back (onHostStatus). @param {RemoteTurns} rts @param {string} hostId */
export function whenBack(rts, hostId) {
  if (!isBack(rts.hosts?.status(hostId))) return;
  queueMicrotask(() => onHostStatus(rts, hostId, { state: 'connected' }));
}

/** After Sign-in needed: resume only once the host’s check passes; with no check, the person resumes. @param {RemoteTurns} rts @param {string} sessionId */
async function trySignInResume(rts, sessionId) {
  const se = rts.rt.s.sessions[sessionId];
  if (se?.remoteTurn?.state !== 'signin' || !se.remoteTurn.resume) return;
  rts.checkedAt.set(sessionId, rts.now());
  const check = await signInCheck(rts, se.remoteTurn.hostId);
  if (check?.ok === true) autoResume(rts, sessionId);
}

/** @param {RemoteTurns} rts @param {string} sessionId */
function autoResume(rts, sessionId) {
  const rt = rts.rt;
  const se = rt.s.sessions[sessionId];
  const r = se?.remoteTurn;
  if (!r?.resume || se.retiredFork || rt.turns.has(sessionId) || rt.exiting.has(sessionId) || rt.closing) return;
  // Only on the host it stopped on: an agent moved since waits for the person.
  if (hostOf(rt.personaFor(se)) !== r.hostId) return;
  // Nor can one whose backend isn’t registered here: a resume would only fail again (#874, #909).
  if (!rt.placement.registeredAdapter(rt.personaFor(se))) return;
  // Nor while that host hasn’t confirmed a stop Postbox asked of it for this session (#965).
  if (stopWaitsOn(r, r.hostId)) return;
  // An interruption that keeps coming back waits for the person after a few resumes, and so does one whose process
  // there may still run (resume.unkilled: one killed that didn’t stop, #872, or one left to end on its own after a
  // restart, reattach, #909).
  if (r.resume.why === 'interrupted' && (r.resume.unkilled || (r.autoResumes ?? 0) >= AUTO_RESUMES)) return;
  updateRemote(rts, sessionId, { resume: { ...r.resume, auto: true }, autoResumes: (r.autoResumes ?? 0) + 1 });
  // It goes on as the turn it continues: where it spoke, who it answers, what it was asked (turns-origin.mjs).
  const go = continuing(rt, rt.s.sessions[sessionId], { kind: 'notice', text: 'Postbox resumed your turn on its own. Carry on where you left off.' });
  rt.deliver(sessionId, go.message, go.opts);
}

/** The person’s Resume, after Sign-in needed or Interrupted. @param {RemoteTurns} rts @param {string} sessionId */
export function resume(rts, sessionId) {
  const rt = rts.rt;
  const se = rt.session(sessionId);
  const r = se.remoteTurn;
  if (!r?.resume) return { ok: false, message: `@${se.handle} has no stopped turn on a host to resume.` };
  if (rt.turns.has(sessionId)) return { ok: false, message: `@${se.handle} is already at work.` };
  // A turn there that Postbox asked to stop may still run until the daemon confirms it: a new one would run beside it
  // on the same session (#872, #965). A stop on another host, one the agent moved off, doesn’t hold it.
  const hostId = hostOf(rt.personaFor(se));
  if (hostId && stopWaitsOn(r, hostId)) {
    const name = rt.s.hosts?.[hostId]?.name ?? 'its host';
    return { ok: false, message: `@${se.handle}’s last turn on ${name} hasn’t confirmed it stopped. Resume once it has.` };
  }
  updateRemote(rts, sessionId, { resume: { ...r.resume, auto: false }, autoResumes: 0 });
  const go = continuing(rt, rt.s.sessions[sessionId], { kind: 'notice', text: 'The person asked you to resume. Carry on where you left off.' });
  rt.deliver(sessionId, go.message, go.opts);
  return { ok: true };
}

/** @param {RemoteTurns} rts @param {string} sessionId */
export async function reattach(rts, sessionId) {
  const rt = rts.rt;
  const se = rt.s.sessions[sessionId];
  const r = se?.remoteTurn;
  if (!r || !rts.restoring.has(r.turn) || rts.live.has(sessionId) || rt.turns.has(sessionId)) return;
  let welcome;
  try {
    welcome = await rts.hosts?.ensureWelcome(r.hostId);
  } catch {
    return; // not now: onHostStatus tries again when the host is back
  }
  const now = rt.s.sessions[sessionId];
  if (!now || now.remoteTurn?.turn !== r.turn || !rts.restoring.has(r.turn) || rt.turns.has(sessionId)) return;
  const listed = (welcome?.turns ?? []).find((/** @type {any} */ t) => t.turn === r.turn);
  // An agent moved off the host since can’t be attached there, nor one whose backend isn’t registered here (#874,
  // #909): it waits for the person, and the host is asked to stop a turn still there.
  const persona = rt.personaFor(now);
  const moved = hostOf(persona) !== r.hostId;
  const unregistered = !rt.placement.registeredAdapter(persona);
  if (!listed || moved || unregistered) {
    rts.restoring.delete(r.turn);
    rts.early.delete(r.turn);
    // One the host lists as running, or interrupted with its process unkilled (#872), may still run there, moved or
    // not: the host is asked to stop it, and stays needed until the daemon confirms it (askStop). Asked before the
    // release, so the host’s link isn’t let go in between (#965).
    const stillThere = listed?.state === 'running' || listed?.unkilled === true;
    if (stillThere) askStop(rts, sessionId, r.hostId, r.turn);
    releaseHost(rts, r.hostId);
    // Resumed on its own once the backend is back, a second turn could run beside it on the same session, so it waits
    // for the person. One listed as ended, or interrupted and gone, can’t, and a moved one waits anyway (autoResume’s
    // hostOf check).
    const mayRun = stillThere && !moved;
    // Marked only when the missing backend is all that holds it, since the hint then promises it resumes on its own
    // (#965): one that may still run waits for the person, and so does a moved agent’s.
    const onlyBackend = unregistered && !mayRun && !moved;
    interrupted(rts, sessionId, whyNotAttached(now.handle, persona, { listed: Boolean(listed), moved }), { unkilled: mayRun, noBackend: onlyBackend });
    // Its cards, kept for the attach, can’t be answered now (#965).
    endOrphanCards(rts, [r.turn]);
    // What waited for the attach goes now, unless the turn may still run there and waits for the person (#1135).
    if (!mayRun) rt.drainQueues(sessionId, now.threadId);
    return;
  }
  // Running, ended or interrupted, it’s replayed from the start, so the reply is whole: what came before is replaced.
  for (const threadId of rt.conversationThreads(now.threadId))
    for (const it of rt.store.pending.items(threadId))
      if (it.kind === 'agent' && it.turnId && it.turnId === r.rtTurn && it.status !== 'replaced')
        rt.patchItem(threadId, it.id, { status: 'replaced', text: '' });
  rt.updateSession(sessionId, { state: 'think', currentStep: `Reconnecting to ${rt.s.hosts?.[r.hostId]?.name ?? 'the host'}` });
  const go = continuing(rt, now, { kind: 'notice', text: '', attach: r.turn });
  rt.deliver(sessionId, go.message, go.opts);
}

/**
 * Why a turn on a host can’t be attached again: the agent moved first, since it no longer runs there at all; then the
 * host having no record of it, which no backend changes; then a backend not registered here (#909).
 * @param {string} handle @param {any} persona @param {{ listed: boolean, moved: boolean }} o
 */
function whyNotAttached(handle, persona, { listed, moved }) {
  if (moved) return `@${handle} no longer runs there`;
  if (!listed) return 'the host has no record of it';
  return unregisteredWhy(persona);
}

/**
 * A turn that was on a host and is gone: Interrupted, and resumed once the host is back, unless `unkilled` says its
 * process there may still run, so it waits for the person (resume.unkilled, as turns-end.mjs keeps it for #872).
 * @param {RemoteTurns} rts @param {string} sessionId @param {string} why @param {{ unkilled?: boolean, noBackend?: boolean }} [o]
 */
export function interrupted(rts, sessionId, why, { unkilled = false, noBackend = false } = {}) {
  const rt = rts.rt;
  const se = rt.s.sessions[sessionId];
  if (!se?.remoteTurn) return;
  const name = rt.s.hosts?.[se.remoteTurn.hostId]?.name ?? 'its host';
  const message = `Interrupted on ${name}: ${why}.`;
  const it = rt.addItem(se.threadId, {
    kind: 'agent',
    sessionId,
    personaId: se.personaId,
    handle: se.handle,
    turnId: se.remoteTurn.rtTurn ?? null,
    text: '',
    status: 'failed',
    error: message,
    remote: { state: 'interrupted', hostId: se.remoteTurn.hostId },
  });
  /** @type {{ why: string, at: number, unkilled?: boolean, noBackend?: boolean }} */
  const resume = { why: 'interrupted', at: rts.now() };
  if (unkilled) resume.unkilled = true;
  // Its backend isn’t registered here, so it can’t resume until it is: the hint says so (#965, resumeHint).
  if (noBackend) resume.noBackend = true;
  updateRemote(rts, sessionId, { state: 'interrupted', at: rts.now(), resume });
  rt.updateSession(sessionId, {
    state: 'failed',
    needs: { kind: 'failed', itemId: it.id, text: message },
    // The interrupted turn is the last turn (card-needs.mjs turnsOf), when the host named it.
    ...(se.remoteTurn.rtTurn ? { lastTurnId: se.remoteTurn.rtTurn } : {}),
    currentStep: 'Interrupted',
    finishedAt: rts.now(),
  });
  whenBack(rts, se.remoteTurn.hostId);
}

/**
 * Whether a stop Postbox asked of hostId for this session’s turns there is still unconfirmed (remoteTurn.stopping,
 * askStop): until the daemon confirms it, that turn may still run there.
 * @param {any} r  the session’s remoteTurn @param {string} hostId
 */
function stopWaitsOn(r, hostId) {
  return (r?.stopping ?? []).some((/** @type {any} */ x) => x.hostId === hostId);
}
