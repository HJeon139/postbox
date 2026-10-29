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

/**
 * Every delivery the room owes an agent: a message that @-mentions it (not its own), and each wake a card settled
 * by Allow or by retiring, its own and those held on it. `from` is when it could first reach the agent, and `due`
 * when it had to: its agent’s turns count from then.
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
  return [...one.values()];
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

/** The not-checkable records for a check, from a count of unread deliveries per agent. @param {Map<string, number>} unread */
export const notCheckableAll = (f, check, unread) => [...unread].map(([handle, n]) => notCheckable(f, check, handle, n));

/** Whether an input holds this delivery: its item’s id, or the start of its text. */
export const holds = (input, a) => (!!a.itemId && input.text.includes(a.itemId)) || (!!headOf(a.text) && input.key.includes(plain(a.text).slice(0, HOLD)));

/** A turn produced output once its model wrote something: an assistant message, or a streamed piece of one. */
export const hasOutput = (events) =>
  (events ?? []).some((e) => e?.type === 'assistant' || (e?.type === 'stream_event' && e.event?.type === 'content_block_delta'));

/**
 * An agent’s turns, oldest first, from their raw streams.
 * @param {any} f  @param {string} handle
 * @returns {{ started: number, ended: number, output: boolean }[]}
 */
export const turnsOf = (f, handle) =>
  (f.streams ?? [])
    .filter((s) => s.handle === handle && Number.isFinite(s.started))
    .map((s) => ({ started: s.started, ended: Number.isFinite(s.ended) ? s.ended : s.started, output: hasOutput(s.events) }))
    .sort((a, b) => a.started - b.started);
