// A standup round in a run’s records, and what each agent’s last turn did before the room went quiet after it (#1746:
// the owner saw the stall when the coordinator ran a standup). Read from the event history alone, on any backend:
//   work.add      each turn, with its agent and when it started, and each call it made (a command, a read, an edit)
//   entry.add     what reached an agent’s inbox: a mention by name, a reply that came back (bounce), the person’s
//                 message, a scheduled wake; entry.patch says which turn took it
//   item.add      each reply, with its turn; item.text its words; item.patch a reaction on it, and whom it went back to
// A standup is all words, and the reply rules treat a turn that only writes specially (server/reply-back.mjs): a
// reply that names no one goes back to whoever woke the turn, an exchange ends at an agent’s second write-only reply
// in a row to the same agent (#1591), and a reaction to what woke a turn ends the exchange with its sender. So what
// tells “the rules ended the exchange” from “nobody assigned the next step” is, per agent, what woke its last turn,
// whether it did any work, whether it reacted, and whom its reply reached.

/** The words that make a coordinator’s message a standup. */
export const STANDUP = /\bstand[- ]?up\b/i;

/**
 * @typedef {{ id: string, handle: string, sessionId: string, startedAt: number, calls: number,
 *   woke: { source: string, from: string|null, bounce: boolean, itemId: string|null }[],
 *   replies: { id: string, at: number, text: string, wentBack: string[], named: string[] }[], reacted: boolean }} Turn
 */

/** A turn’s record, made the first time anything of the turn is seen. @param {Map<string, Turn>} turns @param {string} id */
function turnOf(turns, id) {
  let t = turns.get(id);
  if (!t) {
    t = { id, handle: '', sessionId: '', startedAt: 0, calls: 0, woke: [], replies: [], reacted: false };
    turns.set(id, t);
  }
  return t;
}

/**
 * Every turn in the history, in the order it started: what woke it, how many calls it made, whether it reacted to
 * what woke it, and each reply with whom it reached (went back to, or woke by name).
 * @param {{ events?: any[] }} f  @returns {Turn[]}
 */
export function turnsIn(f) {
  /** @type {Map<string, Turn>} */
  const turns = new Map();
  /** @type {Map<string, string>} */
  const handles = new Map();
  /** @type {Map<string, any>} each inbox entry, by its id */
  const entries = new Map();
  /** @type {Map<string, Turn['replies'][number]>} */
  const replies = new Map();
  /** @type {Map<string, Turn>} each session’s newest turn so far: the one a reaction of its agent belongs to */
  const running = new Map();
  for (const e of f.events ?? []) {
    const d = e?.data;
    if (e?.type === 'session' && d?.id && typeof d.handle === 'string') handles.set(d.id, d.handle);
    else if (e?.type === 'work.add' && d?.entry?.turnId) workAdded(turns, running, d.entry);
    else if (e?.type === 'entry.add' && d?.entry) entryAdded(entries, replies, handles, d);
    else if (e?.type === 'entry.patch' && d?.patch?.takenBy && entries.has(d.id)) turnOf(turns, d.patch.takenBy).woke.push(entries.get(d.id));
    else if (e?.type === 'item.add' && d?.item?.kind === 'agent' && d.item.turnId) {
      const reply = { id: d.item.id, at: d.item.at, text: d.item.text ?? '', wentBack: [], named: [] };
      replies.set(reply.id, reply);
      turnOf(turns, d.item.turnId).replies.push(reply);
    } else if (e?.type === 'item.text' && replies.has(d?.id)) /** @type {any} */ (replies.get(d.id)).text += d.text ?? '';
    else if (e?.type === 'item.patch' && d?.patch?.wentBack && replies.has(d.id)) /** @type {any} */ (replies.get(d.id)).wentBack = d.patch.wentBack;
    else if (e?.type === 'item.patch' && d?.reaction?.on) {
      const t = running.get(d.reaction.by);
      if (t?.woke.some((w) => w.itemId === d.id)) t.reacted = true;
    }
  }
  return [...turns.values()].filter((t) => t.handle).sort((a, b) => a.startedAt - b.startedAt);
}

/** A line of the work ledger: the turn itself, or a call it made. @param {Map<string, Turn>} turns @param {Map<string, Turn>} running @param {any} entry */
function workAdded(turns, running, entry) {
  const t = turnOf(turns, entry.turnId);
  if (entry.kind !== 'turn') t.calls++;
  else running.set(entry.sessionId, Object.assign(t, { handle: entry.handle, sessionId: entry.sessionId, startedAt: entry.startedAt }));
}

/** An inbox entry: kept for the turn that takes it, and, when a reply made it, whom that reply reached. @param {Map<string, any>} entries @param {Map<string, any>} replies @param {Map<string, string>} handles @param {any} d */
function entryAdded(entries, replies, handles, d) {
  const en = d.entry;
  entries.set(en.id, { source: en.source, from: en.from ?? null, bounce: en.bounce === true, itemId: en.itemId ?? null });
  const to = handles.get(d.sessionId);
  const reply = replies.get(en.itemId);
  if (reply && to && en.source === 'mention' && en.bounce !== true) reply.named.push(to);
}

/** Whether a turn’s reply had words. @param {Turn} t */
const wrote = (t) => t.replies.some((r) => r.text.trim());

/** Whether a turn’s reply reached an agent: went back to it, or named it. @param {Turn} t @param {string} handle */
const answered = (t, handle) => t.replies.some((r) => r.wentBack.includes(handle) || r.named.includes(handle));

/**
 * Each round, by its shape: one agent’s turn, and the turn every other agent in the run took on what it wrote, whether
 * named in it or reached by it going back, with whether that turn wrote an answer. The word is only a hint, since an
 * agent may hold a standup without it: `says` keeps the rounds whose asking turn used it, and null keeps them all,
 * each marked with whether it said “standup”.
 * With `toAsker`, each of those turns must have written an answer that reached the asking agent, by going back to it
 * or by naming it: a status round converges on whoever asked, where a kickoff’s answers go on to the next agent.
 * @param {{ events?: any[] }} f  @param {{ says?: RegExp|null, toAsker?: boolean }} [opts]
 * @returns {{ by: string, at: number, endedAt: number, said: boolean, answers: { handle: string, wrote: boolean, at: number }[] }[]}
 */
export function standupRounds(f, { says = STANDUP, toAsker = false } = {}) {
  const turns = turnsIn(f);
  const agents = [...new Set(turns.map((t) => t.handle))];
  const out = [];
  for (const t of turns) {
    if (says && !t.replies.some((r) => says.test(r.text))) continue;
    // A turn may ask in more than one message: all of its replies count once one of them says it.
    const ids = new Set(t.replies.map((r) => r.id));
    const others = agents.filter((h) => h !== t.handle);
    const took = others.map((h) =>
      turns.find((x) => x.handle === h && x.woke.some((w) => w.itemId !== null && ids.has(w.itemId)) && (!toAsker || answered(x, t.handle))),
    );
    if (!others.length || took.includes(undefined)) continue;
    const answers = /** @type {Turn[]} */ (took).map((x) => ({ handle: x.handle, wrote: wrote(x), at: x.startedAt }));
    const said = t.replies.some((r) => STANDUP.test(r.text));
    out.push({ by: t.handle, at: Math.min(...t.replies.map((r) => r.at)), endedAt: Math.max(...answers.map((a) => a.at)), said, answers });
  }
  return out;
}

const WOKE = { person: 'the person’s message', answer: 'the person’s answer', scheduled: 'its scheduled wake', check: 'Postbox’s check of its reply' };

/** What woke a turn, in words. @param {Turn} t */
function wokeBy(t) {
  const each = t.woke
    .filter((w) => w.source !== 'notice')
    .map((w) => {
      if (w.source !== 'mention') return WOKE[/** @type {keyof typeof WOKE} */ (w.source)] ?? `a ${w.source} entry`;
      return w.bounce ? `@${w.from}’s reply that came back` : `@${w.from}’s mention`;
    });
  return [...new Set(each)].join(' and ') || 'nothing the run recorded';
}

/** Whom a turn’s replies reached, in words. @param {Turn} t */
function reached(t) {
  if (!wrote(t)) return 'it wrote nothing';
  const named = [...new Set(t.replies.flatMap((r) => r.named))];
  const back = [...new Set(t.replies.flatMap((r) => r.wentBack))];
  const parts = [
    named.length ? `woke ${named.map((h) => `@${h}`).join(', ')} by name` : '',
    back.length ? `went back to ${back.map((h) => `@${h}`).join(', ')}` : '',
  ];
  return `its reply ${parts.filter(Boolean).join(' and ') || 'reached no agent'}`;
}

/**
 * Each agent’s last turn that started before a moment, as a line: what woke it, whether it did work or only wrote,
 * whether it reacted to what woke it, and whom its reply reached.
 * @param {{ events?: any[] }} f  @param {number} before
 * @returns {{ handle: string, at: number, line: string }[]}
 */
export function lastTurns(f, before) {
  /** @type {Map<string, Turn>} */
  const last = new Map();
  for (const t of turnsIn(f)) if (t.startedAt < before) last.set(t.handle, t);
  return [...last.values()].map((t) => ({
    handle: t.handle,
    at: t.startedAt,
    line: `@${t.handle}’s last turn was woken by ${wokeBy(t)}; it ${t.calls ? `made ${t.calls} ${t.calls === 1 ? 'call' : 'calls'}` : 'only wrote'}${t.reacted ? ', reacted to what woke it' : ''}; ${reached(t)}.`,
  }));
}
