// `- seed: big-room` (#508, designs/508/testing-strategy.md, “Seeds and runner changes”): a generated room of about
// 1,000 items (PF-1’s key-to-frame tool asks for 4,000 and 10,000 too), so catch-up has to leave things out and the page holds only a window of it. It’s generated, not copied
// from a real room, so no project’s content reaches the tester model, and the same seed gives the same room. It holds
// three landmarks the scenarios name: a mention of @researcher as its oldest addressed item (delivery.md, phase 2), a
// review block from @researcher near its start (bigroom.md, phase 3), and a decision whose id the run links to
// (bigroom.md, phase 2). Its first day uses a word no later day does, for the search phase (bigroom.md, phase 4), and
// its last item is a landmark too, for paging back to the start (bigroom.md, phase 1).

import { Store } from '../../server/store.mjs';
import { buildEvent } from '../../shared/events.mjs';
import { roomWork } from './big-room-work.mjs';

/** The word only the first day uses. */
export const FIRST_DAY_WORD = 'zephyrine';
const TOPICS = ['packaging', 'the changelog', 'CI on the oldest runtime', 'the migration guide', 'deprecation warnings', 'the security scan', 'release notes'];
const VERBS = ['checked', 'drafted', 'reviewed', 'reran', 'tidied', 'measured', 'listed'];
const DAY_MS = 24 * 60 * 60 * 1000;

/** A small seeded generator (mulberry32), so a room is the same every run. @param {number} seed */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One filler message: the person’s or an agent’s, about a release topic, naming no one. */
function filler(rnd, i, at, handles, firstDay, count) {
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const by = rnd() < 0.3 ? null : pick(handles);
  const said = `${pick(VERBS)} ${pick(TOPICS)}${firstDay ? ` for the ${FIRST_DAY_WORD} milestone` : ''}; item ${i} of the release log.`;
  return by
    ? { id: idOf(i, count), at, kind: 'agent', handle: by, text: `I ${said} Nothing here needs anyone yet.` }
    : { id: idOf(i, count), at, kind: 'user', text: `Note: ${said}` };
}

/**
 * The person’s approval of a review, as server/blocks.mjs (act) records it: answered, with the answer on the item, and
 * the voice line it adds after it. read: the agent has had it in a turn, so it can revise the block (update_block
 * refuses to reopen a block over an answer it hasn’t read), and nothing is left asking: an unanswered review in a room
 * nobody has touched is an ask whose agent doesn’t need you, which needs-mismatch reports.
 * @param {any} block  @param {number} at
 */
function approvedOnce(block, at) {
  const r = buildEvent(block, 'submit', { verdict: 'approve', comments: [] }, { revision: 1 });
  if (!r.ok) throw new Error(`The seeded review couldn’t be answered: ${r.error}`);
  return { item: { answered: true, answer: { action: 'submit', values: r.event.values, voice: r.voice, at, revision: 1, read: true } }, voice: r.voice };
}

/**
 * Item i’s id, padded to the digits the room’s last index needs, and never fewer than four, so ids sort in the order of
 * their items in a room of any size and a 1,000-item room’s ids stay the ones the scenarios and tests name.
 * @param {number} i  @param {number} count
 */
function idOf(i, count) {
  const width = Math.max(4, String(count - 1).length);
  return `it_big${String(i).padStart(width, '0')}`;
}

/**
 * The room’s items, oldest first, and its landmarks’ ids. handles: the agents in it; the mention is of the first.
 * diagrams: how many agent replies, spread evenly through the room, end in a Mermaid diagram (#701’s UAT trigger,
 * `- seed-diagrams:`). None by default, so the rooms the key-press tool measures don’t change.
 * @param {{ count?: number, start?: number, seed?: number, handles?: string[], diagrams?: number }} [opts]
 */
export function bigRoomItems({
  count = 1000,
  start = Date.UTC(2026, 8, 1, 9),
  seed = 508,
  handles = ['researcher', 'critic', 'developer'],
  diagrams = 0,
} = {}) {
  const rnd = random(seed);
  const step = Math.floor((5 * DAY_MS) / count);
  const at = (i) => start + i * step;
  const landmarks = { mention: idOf(0, count), review: idOf(2, count), decision: idOf(5, count) };
  const review = {
    id: landmarks.review,
    at: at(2),
    kind: 'block',
    handle: handles[0],
    valid: true,
    block: {
      id: 'release-plan',
      type: 'review',
      version: 1,
      title: 'release-plan.md',
      fallback: 'The release plan',
      format: 'markdown',
      content: '# Release plan\n\n1. Freeze.\n2. Tag.\n3. Announce.\n',
    },
  };
  const answered = approvedOnce(review.block, at(3));
  const items = [
    {
      id: landmarks.mention,
      at: at(0),
      kind: 'user',
      text: `@${handles[0]} what did the 1.9 retro decide about the release train, and who owns the ${FIRST_DAY_WORD} checklist?`,
    },
    filler(rnd, 1, at(1), handles, true, count),
    { ...review, ...answered.item },
    { id: idOf(3, count), at: at(3), kind: 'voice', text: answered.voice, blockItemId: landmarks.review },
    filler(rnd, 4, at(4), handles, true, count),
    { id: landmarks.decision, at: at(5), kind: 'user', text: 'Decision: 2.0 ships on the release train, not on a fixed date.' },
  ];
  const others = handles.length > 1 ? handles.slice(1) : handles;
  for (let i = items.length; i < count; i++) items.push(filler(rnd, i, at(i), others, at(i) < start + DAY_MS, count));
  addDiagrams(items, diagrams);
  // The first day's last item, for bigroom.md phase 1's window-paged-back (#531): reading at it or above, you paged
  // back to the room's start.
  landmarks.firstDayLast = items.findLast((it) => it.at < start + DAY_MS).id;
  return { items, landmarks };
}

/** @type {Set<string> | null} */
let firstDay = null;
/**
 * Whether an item is one of the first day's, in the room `- seed: big-room` seeds (the defaults: diagrams don't change
 * ids or times). @param {string} id
 */
export function onBigRoomFirstDay(id) {
  if (!firstDay) {
    const { items, landmarks } = bigRoomItems();
    firstDay = new Set(items.slice(0, items.findIndex((it) => it.id === landmarks.firstDayLast) + 1).map((it) => it.id));
  }
  return firstDay.has(id);
}

/**
 * Ends `n` agent replies in a Mermaid diagram, one each: the first agent reply not yet given one at or after each of n
 * even steps through the filler. It draws no random numbers, so the room is otherwise the one without diagrams. A room
 * with fewer agent replies than n after its landmarks is refused. @param {any[]} items @param {number} n
 */
function addDiagrams(items, n) {
  const first = 6; // after the landmarks
  const stride = Math.floor((items.length - first) / Math.max(n, 1));
  let last = first - 1;
  for (let k = 0; k < n; k++) {
    const from = Math.max(last + 1, first + k * stride);
    const at = items.findIndex((it, i) => i >= from && it.kind === 'agent');
    if (at < 0) throw new Error(`The big room has too few agent replies for ${n} diagrams.`);
    items[at] = { ...items[at], text: `${items[at].text}\n\n\`\`\`mermaid\nflowchart TD\n  D${k}a[Plan] --> D${k}b[Ship]\n\`\`\`\n` };
    last = at;
  }
}

/** The seed of the work’s own random stream, apart from the items’, so the items are the same with work or without. */
const WORK_SEED = 305;

/**
 * Writes the room’s items into a conversation of a loaded store, as `item.add` events, before Postbox serves it.
 * sessions: each agent’s session in that conversation, so its items are its own and it can revise its review block.
 * work: each agent reply is the last of a turn of its agent, with the turn’s work entries written before it and its
 * steps on it (tools/uat/big-room-work.mjs, #305). Off by default, so the scenarios’ and benches’ rooms don’t change.
 * @param {{ emit: (type: string, data: any) => any }} store  @param {string} threadId
 * @param {Parameters<typeof bigRoomItems>[0] & { work?: boolean }} [opts]
 * @param {Record<string, { sessionId: string, personaId?: string }>} [sessions]
 */
export function seedBigRoom(store, threadId, opts, sessions = {}) {
  const room = bigRoomItems(opts);
  const work = opts?.work ? roomWork(room.items, { threadId, sessions, rnd: random(WORK_SEED + (opts.seed ?? 0)) }) : null;
  for (const item of work?.items ?? room.items) {
    for (const [type, data] of work?.before.get(item.id) ?? []) store.emit(type, data);
    const se = item.handle ? sessions[item.handle] : null;
    store.emit('item.add', { threadId, item: se ? { ...item, sessionId: se.sessionId, ...(se.personaId ? { personaId: se.personaId } : {}) } : item });
  }
  return room.landmarks;
}

/** How the note names the room’s size: “about 1,000” for the scenarios’ room, else its count. @param {number} count */
function roomSize(count) {
  if (count === 1000) return 'about 1,000';
  return count.toLocaleString('en-US');
}

/**
 * Seeds the room into a conversation in a run’s data folder while its Postbox is down, with the agents’ sessions the
 * page made there, and says where its decision is, for the tester (bigroom.md’s phase 2: “the run gives it to you”).
 * @param {string} data  @param {string} threadId  @param {string[]} agents  the scenario’s; the mention is of the first
 * @param {{ count?: number, diagrams?: number, work?: boolean }} [opts]  count: how many items, 1,000 unless a measurement
 *   asks for more; diagrams: as bigRoomItems takes it; work: as seedBigRoom takes it
 */
export async function seedBigRoomData(data, threadId, agents, { count = 1000, diagrams = 0, work = false } = {}) {
  const store = await new Store(data).load();
  /** @type {Record<string, { sessionId: string, personaId?: string }>} */
  const sessions = {};
  for (const se of Object.values(store.state.sessions ?? {}))
    if (se?.threadId === threadId && !se.archived && !sessions[se.handle]) sessions[se.handle] = { sessionId: se.id, personaId: se.personaId };
  const landmarks = seedBigRoom(store, threadId, { count, handles: agents, diagrams, work }, sessions);
  await store.close(); // and release the folder for the Postbox that starts next
  return {
    landmarks,
    /** @param {string} origin */
    note: (origin) =>
      `The room was seeded with ${roomSize(count)} generated items before you arrived. Its first decision is at ${origin}/#/t/${threadId}?at=${landmarks.decision}.`,
  };
}

/**
 * `- seed: big-room` in a run (tools/uat-run.mjs): once the page has started the conversation, stops Postbox, seeds the
 * room into its store, starts it again on the same data, and opens the room. Returns the note for the tester. The
 * scenario gives the room its agents and, with `- seed-diagrams:`, its diagrams (#701).
 * @param {{ postbox: { origin: string, restart: (o?: { whileDown?: () => Promise<void> }) => Promise<number> }, data: string,
 *   threadId: string, scenario: { agents: string[], seedDiagrams?: number }, page: { goto: (url: string) => Promise<any> },
 *   log: (line: string) => void, count?: number }} o  count: how many items, as seedBigRoomData takes it
 */
export async function openBigRoom({ postbox, data, threadId, scenario, page, log, count }) {
  const { agents, seedDiagrams: diagrams = 0 } = scenario;
  /** @type {Awaited<ReturnType<typeof seedBigRoomData>> | null} */
  let seeded = null;
  await postbox.restart({
    whileDown: async () => {
      seeded = await seedBigRoomData(data, threadId, agents, { count, diagrams });
    },
  });
  if (!seeded) throw new Error('Postbox restarted without seeding the big room.');
  await page.goto(`${postbox.origin}/#/t/${threadId}`);
  log(`Seeded the big room into ${threadId}: ${JSON.stringify(/** @type {any} */ (seeded).landmarks)}.`);
  return /** @type {any} */ (seeded).note(postbox.origin);
}
