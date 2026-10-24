// Agents whose turns run on a host (#120): the host an agent is on, its connection in words, when Postbox last heard
// from it, and how its turn there stands, for the ring’s label, the agents list, the agent’s panel and the transcript.
// The words for each state are the design’s (architecture.md, “Remote hosts”, “Turn states”) and #120’s Proposal 7
// (G3): Connected, Reconnecting, Disconnected (working) when a turn runs there while Postbox can’t reach it, and
// Disconnected (idle). Each is said in words, never by color alone.
//
// What it reads: the persona’s placement (persona.remote.hostId), the session’s remote turn (se.remoteTurn, kept by
// server/remote/turns.mjs: its state, host, and whether it waits to be resumed), the hosts (state.hosts) and their
// status (state.hostStatus, from the runtime’s hostStatus: state, failure, lastHeard).

import { busy, client } from './client.mjs';
import { ago } from './dom.mjs';

const S = () => client.state;
/** Remote-turn states in which the turn is still on its host as far as Postbox knows (server/remote/turns.mjs, ON_HOST, and stopping). */
const ON_HOST = new Set(['running', 'waiting', 'lost', 'stopping']);

/**
 * The host a session’s agent runs on: where its turn is while one is on a host, else where its persona is placed.
 * Null for an agent on this computer.
 * @param {any} se @returns {{ id: string, name: string, status: any, settings: any } | null}
 */
export function hostOf(se) {
  if (!se) return null;
  const r = se.remoteTurn;
  const placed = S().personas?.[se.personaId]?.remote?.hostId ?? null;
  const id = (r && ON_HOST.has(r.state) ? r.hostId : null) ?? placed;
  if (!id) return null;
  const h = S().hosts?.[id];
  return { id, name: h?.name ?? 'a removed host', status: S().hostStatus?.[id] ?? null, settings: h?.settings ?? {} };
}

/** Whether a turn of the session runs on its host, or may: one at work here, or one Postbox hasn’t heard the end of. @param {any} se */
export const workingOnHost = (se) => busy(se) || se?.state === 'stopping' || ON_HOST.has(se?.remoteTurn?.state);

/**
 * The connection to an agent’s host in words (G3): Connected, Reconnecting, Disconnected (working) or Disconnected
 * (idle). A host Postbox can’t reach for a reason only you can fix (a sign-in, a host key, not installed) is
 * disconnected too; the host’s settings say why.
 * @param {any} se @param {ReturnType<typeof hostOf>} [host]
 */
export function connectionOf(se, host = hostOf(se)) {
  const st = host?.status?.state;
  if (st === 'connected') return 'Connected';
  if (st === 'reconnecting') return 'Reconnecting';
  return workingOnHost(se) ? 'Disconnected (working)' : 'Disconnected (idle)';
}

/** “last heard from 2 min ago”, or null before Postbox has heard from the host. @param {ReturnType<typeof hostOf>} host */
export const heardOf = (host) => (host?.status?.lastHeard ? `last heard from ${ago(host.status.lastHeard)}` : null);

/** “On host.example.com · Connected · last heard from 2 min ago”, or null for an agent on this computer. @param {any} se */
export function hostLine(se) {
  const host = hostOf(se);
  if (!host) return null;
  return [`On ${host.name}`, connectionOf(se, host), heardOf(host)].filter(Boolean).join(' · ');
}

/** The ring’s words for where it runs: “on host.example.com, disconnected (working), last heard from 2 min ago”. @param {any} se */
export function ringWhere(se) {
  const host = hostOf(se);
  if (!host) return '';
  return [`on ${host.name}`, connectionOf(se, host).toLowerCase(), heardOf(host)].filter(Boolean).join(', ');
}

/**
 * How the session’s turn on its host stands, when that needs saying beside its name: stopping there, lost, or
 * stopped and waiting to be resumed. Null otherwise (running and waiting show as the ring does).
 * @param {any} se @returns {string | null}
 */
export function turnLine(se) {
  const r = se?.remoteTurn;
  if (!r) return null;
  const name = S().hosts?.[r.hostId]?.name ?? 'its host';
  if (r.state === 'stopping') return `Stopping on ${name}: Postbox waits for the host to confirm`;
  if (r.state === 'lost') return `Lost: Postbox can’t reach ${name}, and the turn may still run there`;
  if (busy(se)) return null;
  if (r.state === 'signin' && r.resume) return `Sign-in needed on ${name}`;
  if (r.state === 'interrupted' && r.resume) return `Interrupted on ${name}`;
  return null;
}

/** Whether a reply’s turn ran on a host: its session’s remote turn is that turn. @param {any} se @param {string | null | undefined} turnId */
export const ranOnHost = (se, turnId) => Boolean(turnId && se?.remoteTurn?.rtTurn === turnId);

/** The background jobs still running for a session. @param {any} se */
const runningJobs = (se) => (se?.jobs ?? []).filter((/** @type {any} */ j) => j.state === 'running' && !j.kept);

/**
 * What Stop says before you press it, for an agent at work on a host with background jobs running: they stop with
 * the turn, since a remote turn’s Stop is always a plain stop (#120, #164). Null otherwise.
 * @param {any} se
 */
export function stopNote(se) {
  const host = hostOf(se);
  if (!host || !busy(se)) return null;
  const n = runningJobs(se).length;
  if (!n) return null;
  return `Stop also stops @${se.handle}’s ${n === 1 ? 'background job' : `${n} background jobs`} on ${host.name}: a job on a host stops with its turn.`;
}

/**
 * The sentence that follows “Interrupted on <host>” or “Sign-in needed on <host>”: whether Postbox resumes it on its
 * own (D2: after Interrupted once the host is back, a few times; after Sign-in needed only when the host’s sign-in
 * check passes), or waits for you.
 * @param {any} se
 */
export function resumeHint(se) {
  const r = se?.remoteTurn;
  if (!r?.resume) return '';
  const h = S().hosts?.[r.hostId];
  const name = h?.name ?? 'the host';
  if (r.state === 'signin')
    return Array.isArray(h?.settings?.signInCheck) && h.settings.signInCheck.length
      ? `Postbox resumes it on its own once ${name}’s sign-in check passes.`
      : 'Resume it once you’ve signed in.';
  // AUTO_RESUMES in server/remote/turns.mjs.
  return (r.autoResumes ?? 0) < 3
    ? `Postbox resumes it on its own once ${name} is back, or you can now.`
    : 'It was interrupted again after Postbox resumed it, so it waits for you.';
}

// Rings say where their agent runs, which changes with the host’s status, not only with the session.
client.on((ch) => {
  if (ch.type !== 'host.status' && ch.type !== 'host') return;
  for (const el of document.querySelectorAll('pb-ring[data-session]')) {
    const se = S().sessions[/** @type {HTMLElement} */ (el).dataset.session ?? ''];
    if (se) el.setAttribute('where', ringWhere(se));
  }
});
