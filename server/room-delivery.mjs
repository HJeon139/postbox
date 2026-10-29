// What the delivery checks and triggers read (#508, designs/508/testing-strategy.md, “Triggers, checks and seeds to
// add”): what was addressed to each agent, what reached it, and its turns. Every one reads only what `main` already
// records, so it can catch a defect there before the step that fixes it:
//   addressed   items that @-mention an agent, allowed wake cards, and the wakes held on a card (#439)
//   inputs      each agent’s prompts and tool results, from its Claude Code transcript (facts.transcripts)
//   turns       each agent turn’s raw stream (facts.streams), and whether it produced any output
// An item “reached” an agent when an input of its holds the item’s id, or the start of its text, letters and digits
// only: a catch-up line or a held note reformats the text around it, never the words.

import { parseMentions } from '../shared/text.mjs';

/** Letters and digits only, lowercase: the form texts are matched in. */
export const plain = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
/** How much of a text’s start identifies it, and the least that’s worth matching. */
const HEAD = 60;
const MIN_HEAD = 16;
/** The start of a text that identifies it, or null for one too short to tell from others. */
export const headOf = (text) => {
  const p = plain(text);
  return p.length >= MIN_HEAD ? p.slice(0, HEAD) : null;
};

/**
 * What says a delivery is a repeat (decision 8.2), what points back to one rather than giving it again (#484), and
 * what gives a topic thread’s starting message on purpose (server/runtime.mjs’s topicRootLine, envelope item 2).
 */
export const RESEND_LABEL = /\b(resent|resend|sent (?:it |this )?again|a repeat of|check what ran|gave you in full|this thread started from)\b/i;

/** Whether a prompt labels the message it repeats: the label comes in the 400 characters before the message. */
export function labeled(prompt, text) {
  const at = prompt.indexOf(String(text).trim().slice(0, 30));
  return at >= 0 && RESEND_LABEL.test(prompt.slice(Math.max(0, at - 400), at));
}

const itemsOf = (f) => (f.threads ?? []).flatMap((t) => (f.state?.items?.[t] ?? []).map((it) => ({ ...it, threadId: t })));
const handlesIn = (f, threadId) =>
  (f.state?.threads?.[threadId]?.members ?? []).map((id) => f.state.sessions?.[id]?.handle).filter((h) => typeof h === 'string');

/** When the event after seq added an item: the closest record of when a patch, which carries no time, happened. */
export function timeAfter(events, seq) {
  for (const e of events ?? []) if (e.seq > seq && e.type === 'item.add' && Number.isFinite(e.data?.item?.at)) return e.data.item.at;
  return null;
}

/** A wake held on a card, as cardHistory keys it: from whom, to whom, and the start of its text. */
export const heldKey = (w) => `${w.fromSessionId ?? w.from}:${w.to}:${headOf(w.text) ?? w.text}`;

/** How close to a card’s retiring the wakes it sent on are raised again, or held on another card. */
const MOVE_MS = 1000;
/** A card’s own wake, in the shape of a held one, for heldKey. */
const ownOf = (card) => ({ fromSessionId: card.fromSessionId, from: card.from, to: card.to, text: card.text ?? card.reason, itemId: card.itemId, at: card.at });

/**
 * Each card’s history from the events: the card as added, the statuses it went through, when it was settled (null
 * while open), and every wake held on it, with whether a later patch took it off while the card was still open.
 * Retiring a card sends its own wake and those held on it on (server/wake-cards.mjs’s retireStale), and one that
 * still needs a card raises the next card, or is held on it: movedTo names the card that took a wake over, and
 * movedFrom the card it came from, its own wake’s (own) as a held one’s.
 * @param {any[]} events
 */
export function cardHistory(events) {
  /** @typedef {{ w: any, removedOpen: boolean, movedTo: string|null, movedFrom: string|null }} Wake */
  /** @type {Map<string, { card: any, statuses: string[], settled: number|null, own: Wake, held: Map<string, Wake> }>} */
  const cards = new Map();
  /** The wakes of retired cards not yet taken over, by heldKey: each with its card and when it was retired. */
  /** @type {Map<string, { h: Wake, cardId: string, at: number }>} */
  const pending = new Map();
  /** A wake raised again, or held, at `at`: the retired card’s that it is, if one was sent on just then. */
  const takeOver = (k, at, cardId, h) => {
    const p = pending.get(k);
    if (!p || p.cardId === cardId || !Number.isFinite(at) || Math.abs(at - p.at) > MOVE_MS) return;
    pending.delete(k);
    p.h.movedTo = cardId;
    h.movedFrom = p.cardId;
  };
  for (const e of events ?? []) {
    if (e.type === 'item.add' && e.data?.item?.kind === 'hop') {
      const card = e.data.item;
      const own = { w: ownOf(card), removedOpen: false, movedTo: null, movedFrom: null };
      cards.set(card.id, { card, statuses: [card.status], settled: null, own, held: new Map() });
      takeOver(heldKey(own.w), card.at, card.id, own);
    }
    const c = e.type === 'item.patch' ? cards.get(e.data?.id) : null;
    if (!c) continue;
    const p = e.data.patch ?? {};
    if (typeof p.status === 'string') c.statuses.push(p.status);
    // A patch carries no time: a retired card’s says when; otherwise the next item added is the closest record.
    if (typeof p.status === 'string' && p.status !== 'open' && c.settled === null)
      c.settled = Number.isFinite(p.retiredAt) ? p.retiredAt : timeAfter(events, e.seq);
    if (p.status === 'retired' && Number.isFinite(p.retiredAt))
      for (const h of [c.own, ...c.held.values()]) pending.set(heldKey(h.w), { h, cardId: c.card.id, at: p.retiredAt });
    if (!Array.isArray(p.held)) continue;
    const now = new Set(p.held.map(heldKey));
    for (const w of p.held)
      if (!c.held.has(heldKey(w))) {
        const h = { w, removedOpen: false, movedTo: null, movedFrom: null };
        c.held.set(heldKey(w), h);
        takeOver(heldKey(w), w.at, c.card.id, h);
      }
    const open = c.statuses.at(-1) === 'open';
    for (const [k, h] of c.held) if (!now.has(k) && open) h.removedOpen = true;
  }
  return cards;
}

/**
 * Every delivery the room owes an agent: a message that @-mentions it (not its own), and each wake a card settled
 * by Allow or by retiring, its own and those held on it. `from` is when it could first reach the agent, and `due`
 * when it had to: its agent’s turns count from then. A message held on a card is due once the card settles, and not
 * while it’s open (heldUntil).
 * @param {any} f
 * @returns {{ to: string, itemId: string|null, text: string, from: number, due: number, how: 'mention'|'wake'|'held', cardId: string|null }[]}
 */
export function addressed(f) {
  const out = [];
  const items = itemsOf(f);
  for (const it of items) {
    if ((it.kind !== 'user' && it.kind !== 'agent') || typeof it.text !== 'string' || !Number.isFinite(it.at)) continue;
    for (const to of parseMentions(it.text, handlesIn(f, it.threadId)))
      if (to !== it.handle) out.push({ to, itemId: it.id, text: it.text, from: it.at, how: 'mention', cardId: null });
  }
  for (const card of items.filter((it) => it.kind === 'hop' && (it.status === 'allowed' || it.status === 'retired'))) {
    const settled = card.retiredAt ?? settledAt(f, card.id) ?? card.at;
    const own = { to: card.to, itemId: card.itemId ?? null, text: card.text ?? card.reason ?? '', from: settled, how: 'wake', cardId: card.id };
    const held = (card.held ?? []).map((w) => ({ to: w.to, itemId: w.itemId ?? null, text: w.text ?? '', from: settled, how: 'held', cardId: card.id }));
    if (card.status === 'allowed' || !card.join) out.push(own, ...held);
  }
  // A wake for a mention is the mention’s delivery: one record each. It may reach the agent from the earlier of the
  // two (a catch-up can give it while its card waits), and its turns count from the later (when its card let it go).
  /** @type {Map<string, (typeof out)[number] & { due: number }>} */
  const one = new Map();
  for (const a of out) {
    // Keyed by the item it delivers: two messages to one agent that begin alike stay two. Only a card with no item of
    // its own is matched by its text.
    const k = a.itemId ? `${a.to}:item:${a.itemId}` : `${a.to}:text:${headOf(a.text) ?? a.cardId}`;
    const had = one.get(k);
    if (!had) one.set(k, { ...a, due: a.from });
    else one.set(k, { ...had, itemId: had.itemId ?? a.itemId, from: Math.min(had.from, a.from), due: Math.max(had.due, a.from) });
  }
  // A message whose wake waits on a card isn’t due until the card settles, and isn’t due at all while it’s still open:
  // its agent’s turns meanwhile came while Postbox held it.
  const held = heldUntil(f, items);
  const due = [];
  for (const a of one.values()) {
    const until = a.itemId ? held.get(`${a.to}:${a.itemId}`) : undefined;
    if (until === null) continue;
    due.push(until === undefined ? a : { ...a, due: Math.max(a.due, until) });
  }
  return due;
}

/**
 * When each message whose wake waited on a card stopped waiting, by its agent and item: when the last card it waited
 * on settled, or null while one is still open. Read from the history, where a card’s held list shows every wake that
 * waited on it, and from the state, for a run whose history is cut. A wake taken off a card while it still waited
 * stopped waiting on it then, at a time the history doesn’t give: that card doesn’t count.
 * @param {any} f  @param {any[]} items
 * @returns {Map<string, number|null>}
 */
function heldUntil(f, items) {
  /** @type {Map<string, number|null>} */
  const until = new Map();
  /** @param {any} w  @param {number|null} settled */
  const note = (w, settled) => {
    if (typeof w?.itemId !== 'string' || typeof w.to !== 'string') return;
    const k = `${w.to}:${w.itemId}`;
    const had = until.get(k);
    until.set(k, had === null || settled === null ? null : Math.max(had ?? settled, settled));
  };
  for (const c of cardHistory(f.events).values()) {
    const open = c.statuses.at(-1) === 'open';
    // Settled with nothing added since, so the history can’t say when: the state’s card says, as below.
    if (!open && c.settled === null) continue;
    for (const h of [c.own, ...c.held.values()]) if (!h.removedOpen) note(h.w, open ? null : c.settled);
  }
  for (const card of items.filter((it) => it.kind === 'hop')) {
    const settled = card.status === 'open' ? null : (card.retiredAt ?? settledAt(f, card.id) ?? card.at);
    for (const w of [card, ...(card.held ?? [])]) note(w, settled);
  }
  return until;
}

/** When the person settled a card, from the history: the item added after its status patch. */
export function settledAt(f, cardId) {
  const p = (f.events ?? []).find(
    (e) => e.type === 'item.patch' && e.data?.id === cardId && typeof e.data?.patch?.status === 'string' && e.data.patch.status !== 'open',
  );
  return p ? timeAfter(f.events, p.seq) : null;
}

const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((c) => (typeof c?.text === 'string' ? c.text : typeof c?.content === 'string' ? c.content : Array.isArray(c?.content) ? textOf(c.content) : ''))
          .join('\n')
      : '';

/**
 * What reached an agent, in order: each prompt its turns began with, and each tool result, read from its Claude Code
 * transcripts. Null when this run has no transcript of it, so a check can’t tell what it got.
 * @param {any} f  @param {string} handle
 * @returns {{ at: number, kind: 'prompt'|'result', text: string, key: string }[] | null}
 */
export function inputsOf(f, handle) {
  const mine = (f.transcripts ?? []).filter((t) => t.handle === handle);
  if (!mine.length) return null;
  const out = [];
  for (const t of mine)
    for (const line of t.lines ?? []) {
      let e;
      try {
        e = typeof line === 'string' ? JSON.parse(line) : line;
      } catch {
        continue; // a transcript’s last line can be half written
      }
      // A compaction’s summary and a meta line (a caveat, a reminder) are user lines Claude Code writes itself: neither
      // is a prompt, so neither repeats a message nor delivers one.
      if (e?.type !== 'user' || e.isSidechain || e.isCompactSummary || e.isMeta || !e.message) continue;
      const at = Date.parse(e.timestamp);
      const c = e.message.content;
      const results = Array.isArray(c) ? c.filter((b) => b?.type === 'tool_result') : [];
      if (results.length) for (const r of results) out.push({ at, kind: 'result', text: textOf(r.content) });
      else out.push({ at, kind: 'prompt', text: textOf(c) });
    }
  return out.filter((x) => Number.isFinite(x.at) && x.text).map((x) => ({ ...x, key: plain(x.text) }));
}

/**
 * How much of a text’s start an input must hold to hold it: enough to tell apart two messages that begin alike. A
 * catch-up line or a pointer that cuts a message shorter than this gives its item’s id (server/runtime.mjs’s
 * clipItem, server/catch-up.mjs), which holds matches instead.
 */
const HOLD = 200;
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

/**
 * Whether an agent’s transcript holds a line of this turn: Claude Code writes the prompt a turn begins with as it
 * starts, so a turn with none was stopped before it did, or its transcript wasn’t recorded. A turn still running isn’t
 * judged: it may not have written its prompt yet, so it counts as recorded.
 * @param {{ at: number }[]} inputs  from inputsOf  @param {{ started: number, ended: number, running?: boolean }} turn
 */
export const recorded = (inputs, turn) => !!turn.running || inputs.some((x) => x.at >= turn.started - 1000 && x.at <= turn.ended);

/** Whether an input holds this delivery: its item’s id, or the start of its text. */
export const holds = (input, a) => (!!a.itemId && input.text.includes(a.itemId)) || (!!headOf(a.text) && input.key.includes(plain(a.text).slice(0, HOLD)));

/** A turn produced output once its model wrote something: an assistant message, or a streamed piece of one. */
export const hasOutput = (events) =>
  (events ?? []).some((e) => e?.type === 'assistant' || (e?.type === 'stream_event' && e.event?.type === 'content_block_delta'));

/** A session is in a turn while it works, or waits on the person mid-turn (finishedAt null: the turn hasn’t ended). */
const BUSY = new Set(['think', 'tool', 'gen']);
const inTurn = (se) => (se.finishedAt === undefined ? BUSY.has(se.state) : se.finishedAt === null && se.state !== 'idle');

/**
 * An agent’s turns, oldest first, from their raw streams. A turn is running when its stream has no end, or when it
 * is the agent’s newest, its stream has no result line yet and the agent’s session is in a turn: a live check reads
 * the stream’s file mid-turn, whose last write isn’t its end. A running turn’s `ended` is Infinity, so what a check
 * judges at a turn’s end (its output, what it carried) waits until it ends.
 * @param {any} f  @param {string} handle
 * @returns {{ started: number, ended: number, output: boolean, running: boolean }[]}
 */
export const turnsOf = (f, handle) => {
  const streams = (f.streams ?? []).filter((s) => s.handle === handle && Number.isFinite(s.started)).sort((a, b) => a.started - b.started);
  const busy = Object.values(f.state?.sessions ?? {}).some((se) => se?.handle === handle && inTurn(se));
  return streams.map((s, i) => {
    const running = !Number.isFinite(s.ended) || (busy && i === streams.length - 1 && !(s.events ?? []).some((e) => e?.type === 'result'));
    return { started: s.started, ended: running ? Infinity : s.ended, output: hasOutput(s.events), running };
  });
};
