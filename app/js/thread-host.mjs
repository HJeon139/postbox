// A conversation’s turns on a remote host (#120), for the transcript (app/js/thread.mjs): how a reply’s turn there
// ended (Sign-in needed and Interrupted with Resume, or Lost), a stop the host hasn’t confirmed, a Kiro CLI turn’s
// warning as a notice, a background job that stops only with its turn, and a `!` command that ran on this computer.
// What the composer says of a host is in app/js/composer-host.mjs.

import { api, busy, client, itemsOf, sessionsOf } from './client.mjs';
import { h, icon, syncList } from './dom.mjs';
import { hostOf, ranOnHost, resumeHint } from './remote.mjs';
import { say, toast } from './ui.mjs';

const S = () => client.state;

// ── The transcript ──────────────────────────────────────────────────────────────────────

/** “@coder · Stopping on host.example.com: Postbox asked it to stop, and waits for the host to confirm.” @param {any} se */
function hostTurnRow(se) {
  const name = S().hosts?.[se.remoteTurn?.hostId]?.name ?? 'its host';
  return h(
    'div.host-turn.small',
    h('span.g.g-running', { 'aria-hidden': 'true' }),
    h('b', `@${se.handle}`),
    ` · Stopping on ${name}: Postbox asked it to stop, and waits for the host to confirm. It may still run there until then.`,
  );
}

/**
 * The rows under the transcript for turns on a host Postbox asked to stop that the host hasn’t confirmed stopped: they
 * may run on there meanwhile, so each says so until the daemon confirms it. @param {string} threadId
 */
export function hostTurnsList(threadId) {
  const el = h('div.host-turns.col', { role: 'status' });
  const paint = () => {
    const stopping = sessionsOf(threadId).filter((se) => se.remoteTurn?.state === 'stopping');
    el.hidden = !stopping.length;
    syncList(
      el,
      stopping,
      (se) => se.id,
      (se) => hostTurnRow(se),
      (row, se) => row.replaceChildren(...hostTurnRow(se).childNodes),
    );
  };
  return { el, paint };
}

/**
 * The replies whose look on a host changed since they were drawn (remoteSig), of one session or of all.
 * @param {string} threadId @param {Map<string, HTMLElement>} nodes  the transcript’s, by item @param {string | null} [sessionId]
 */
export const remoteStale = (threadId, nodes, sessionId = null) =>
  itemsOf(threadId)
    .filter((it) => it.kind === 'agent' && (!sessionId || it.sessionId === sessionId) && (nodes.get(it.id)?.dataset.remoteSig ?? '') !== remoteSig(it))
    .map((it) => it.id);

/** The step a Kiro CLI turn on a host shows (server/adapters/kiro-cli.mjs, REMOTE_ARGV_NOTE), drawn as a notice. */
const KIRO_ARGV_STEP = 'kiro-remote-argv';

/**
 * How a failed reply’s turn on a host ended, when that’s one the design names (#120, “Turn states”): Sign-in needed
 * and Interrupted (the runtime marks the reply with remote.state), or Lost, when Postbox’s link gave up with the turn
 * still there. canResume: it’s the agent’s latest turn there, and waits for Resume. Null for any other failure.
 * @param {any} it
 */
function remoteFailure(it) {
  const se = S().sessions[it.sessionId];
  const r = se?.remoteTurn;
  const latest = ranOnHost(se, it.turnId);
  const state = it.remote?.state ?? (r?.state === 'lost' && latest ? 'lost' : null);
  if (state !== 'signin' && state !== 'interrupted' && state !== 'lost') return null;
  const name = S().hosts?.[it.remote?.hostId ?? r?.hostId]?.name ?? 'its host';
  const canResume = state !== 'lost' && latest && r?.state === state && !!r.resume && !busy(se) && se.state !== 'stopping';
  return { state, name, se, canResume };
}
/** What a reply’s look depends on besides the reply itself: its turn on a host, for a session change to redraw it. */
export const remoteSig = (it) => {
  if (it.kind !== 'agent' || !it.sessionId) return '';
  const f = it.status === 'failed' ? remoteFailure(it) : null;
  if (f) return [f.state, f.name, f.canResume, f.canResume ? resumeHint(f.se) : ''].join('|');
  return ranOnHost(S().sessions[it.sessionId], it.turnId) ? 'host' : '';
};

/**
 * “Sign-in needed on host.example.com”, “Interrupted on host.example.com”, each with Resume while it waits for it, or
 * “Lost: Postbox can’t reach host.example.com”, which has nothing to resume: the turn may still run there, and
 * Postbox attaches to it again when the host is back. Retry isn’t offered: it would start over, not resume.
 * @param {any} it @param {NonNullable<ReturnType<typeof remoteFailure>>} f
 */
function remoteCallout(it, f) {
  const title =
    f.state === 'signin' ? `Sign-in needed on ${f.name}` : f.state === 'interrupted' ? `Interrupted on ${f.name}` : `Lost: Postbox can’t reach ${f.name}`;
  const msg = String(it.error ?? '');
  // The runtime’s message starts with the same words (server/remote/turns.mjs); the rest says why and what to do.
  let rest = msg.startsWith(title) ? msg.slice(title.length).replace(/^[.:]\s*/, '') : msg;
  if (f.state === 'lost') rest = `${rest ? `${rest} ` : ''}The turn may still be running there. Postbox attaches to it again once the host is back.`;
  rest = rest ? `${rest[0].toUpperCase()}${rest.slice(1)}` : '';
  const resume = (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    api(`/api/sessions/${f.se.id}/resume`, {})
      .then(() => say(`Resuming @${f.se.handle} on ${f.name}.`))
      .catch((err) => {
        b.disabled = false;
        toast({ title: `Couldn’t resume @${f.se.handle}`, text: err.message, level: 'blocking' });
      });
  };
  return h(
    'div.callout.host-callout',
    { role: 'alert', dataset: { remote: f.state } },
    h('span.g.g-failed', { 'aria-hidden': 'true' }),
    h('div.grow', h('b', title), rest ? ` · ${rest}` : '', f.canResume ? ` ${resumeHint(f.se)}` : ''),
    f.canResume
      ? h('button.btn.sm', { type: 'button', 'aria-label': `Resume @${f.se.handle} on ${f.name}`, onclick: resume }, icon('retry', 'i-sm'), 'Resume')
      : null,
  );
}

/** A failed reply’s callout when its turn on a host ended in a state the design names, else null. @param {any} it */
export function failedOnHost(it) {
  const f = remoteFailure(it);
  return f ? remoteCallout(it, f) : null;
}

/** A reply’s steps without the Kiro CLI notice, and the notice’s step. @param {any} it @returns {[any, any[]]} */
export function argvStep(it) {
  const all = it.activity?.steps ?? [];
  const argv = all.find((s) => s.id === KIRO_ARGV_STEP);
  return [argv, argv ? all.filter((s) => s !== argv) : all];
}

/** Kiro CLI on a host takes its message as an argument others there can read: a notice, not a folded step. @param {any} argv */
export const kiroNotice = (argv) =>
  argv
    ? h('div.callout.host-notice', { role: 'note', 'aria-label': argv.label }, icon('warn', 'i-sm'), h('div.grow', h('b', argv.label), ' ', argv.detail ?? ''))
    : null;

/** In place of a background job’s Stop, for a turn on a host: the daemon stops the turn as a whole. Null otherwise. @param {any} it */
export function jobHostNote(it) {
  const se = S().sessions[it.sessionId];
  const host = ranOnHost(se, it.turnId) ? hostOf(se) : null;
  return host ? h('span.small.dim.job-host', `A job on a host stops with its turn. Stop @${se.handle} to stop it.`) : null;
}

/**
 * A `!` command run here while the agent works on a host: the line that says so, and its output without the line the
 * runtime put first for the agents. @param {any} it @returns {{ where: string, text: string }}
 */
export function ranHere(it) {
  const where = it.notOn ? `! commands run on this computer, not on ${it.notOn}.` : '';
  return { where, text: where && String(it.text ?? '').startsWith(`${where}\n`) ? it.text.slice(where.length + 1) : it.text };
}
