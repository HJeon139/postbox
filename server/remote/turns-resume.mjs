// Hung remote turns, and the waits for a host (#120, server/remote/turns.mjs, the header; D2): a turn quiet for its
// host’s stallTimeout is stopped, one Interrupted resumes on its own once the host is back, one stopped with Sign-in
// needed only once the host’s signInCheck passes, and a turn Postbox restarted during is attached again once the
// host’s welcome lists it.

import { defaultHostSettings } from '../../shared/remote-settings.mjs';
import { releaseHost } from './turns-need.mjs';
import { continuing } from './turns-origin.mjs';
import { AUTO_RESUMES, clock, hostOf, isBack, ON_HOST, SIGN_IN_RECHECK_MS, updateRemote } from './turns-shared.mjs';

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
    const text = `Stopped: no output for ${Math.round(stall / 60_000)} min (the last at ${clock(live.lastEvent)})`;
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
  if (!r?.resume || se.archived || se.deleting || rt.turns.has(sessionId) || rt.exiting.has(sessionId) || rt.closing) return;
  // Only on the host it stopped on: an agent moved since waits for the person.
  if (hostOf(rt.personaFor(se)) !== r.hostId) return;
  // An interruption that keeps coming back waits for the person after a few resumes.
  if (r.resume.why === 'interrupted' && (r.autoResumes ?? 0) >= AUTO_RESUMES) return;
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
  // An agent moved off the host since can’t be attached there: its turn is left to end on its own.
  const moved = hostOf(rt.personaFor(now)) !== r.hostId;
  if (!listed || moved) {
    rts.restoring.delete(r.turn);
    rts.early.delete(r.turn);
    releaseHost(rts, r.hostId);
    interrupted(rts, sessionId, moved ? `@${now.handle} no longer runs there` : 'the host has no record of it');
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

/** A turn that was on a host and is gone: Interrupted, and resumed once the host is back. @param {RemoteTurns} rts @param {string} sessionId @param {string} why */
export function interrupted(rts, sessionId, why) {
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
  updateRemote(rts, sessionId, { state: 'interrupted', at: rts.now(), resume: { why: 'interrupted', at: rts.now() } });
  rt.updateSession(sessionId, {
    state: 'failed',
    needs: { kind: 'failed', itemId: it.id, text: message },
    currentStep: 'Interrupted',
    finishedAt: rts.now(),
  });
  whenBack(rts, se.remoteTurn.hostId);
}
