// `- seed: big-room` (#508, designs/508/testing-strategy.md, “Seeds and runner changes”): a generated room of about
// 1,000 items, so catch-up has to leave things out and the page holds only a window of it. It’s generated, not copied
// from a real room, so no project’s content reaches the tester model, and the same seed gives the same room. It holds
// three landmarks the scenarios name: a mention of @researcher as its oldest addressed item (delivery.md, phase 2), a
// review block from @researcher near its start (bigroom.md, phase 3), and a decision whose id the run links to
// (bigroom.md, phase 2). Its first day uses a word no later day does, for the search phase (bigroom.md, phase 4).

import { Store } from '../../server/store.mjs';
import { buildEvent } from '../../shared/events.mjs';

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
function filler(rnd, i, at, handles, firstDay) {
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];
  const by = rnd() < 0.3 ? null : pick(handles);
  const said = `${pick(VERBS)} ${pick(TOPICS)}${firstDay ? ` for the ${FIRST_DAY_WORD} milestone` : ''}; item ${i} of the release log.`;
  return by
    ? { id: idOf(i), at, kind: 'agent', handle: by, text: `I ${said} Nothing here needs anyone yet.` }
    : { id: idOf(i), at, kind: 'user', text: `Note: ${said}` };
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

const idOf = (i) => `it_big${String(i).padStart(4, '0')}`;

/**
 * The room’s items, oldest first, and its landmarks’ ids. handles: the agents in it; the mention is of the first.
 * @param {{ count?: number, start?: number, seed?: number, handles?: string[] }} [opts]
 */
export function bigRoomItems({ count = 1000, start = Date.UTC(2026, 8, 1, 9), seed = 508, handles = ['researcher', 'critic', 'developer'] } = {}) {
  const rnd = random(seed);
  const step = Math.floor((5 * DAY_MS) / count);
  const at = (i) => start + i * step;
  const landmarks = { mention: idOf(0), review: idOf(2), decision: idOf(5) };
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
    filler(rnd, 1, at(1), handles, true),
    { ...review, ...answered.item },
    { id: idOf(3), at: at(3), kind: 'voice', text: answered.voice, blockItemId: landmarks.review },
    filler(rnd, 4, at(4), handles, true),
    { id: landmarks.decision, at: at(5), kind: 'user', text: 'Decision: 2.0 ships on the release train, not on a fixed date.' },
  ];
  for (let i = items.length; i < count; i++) items.push(filler(rnd, i, at(i), handles.slice(1).length ? handles.slice(1) : handles, at(i) < start + DAY_MS));
  return { items, landmarks };
}

/**
 * Writes the room’s items into a conversation of a loaded store, as `item.add` events, before Postbox serves it.
 * sessions: each agent’s session in that conversation, so its items are its own and it can revise its review block.
 * @param {{ emit: (type: string, data: any) => any }} store  @param {string} threadId
 * @param {Parameters<typeof bigRoomItems>[0]} [opts]
 * @param {Record<string, { sessionId: string, personaId?: string }>} [sessions]
 */
export function seedBigRoom(store, threadId, opts, sessions = {}) {
  const room = bigRoomItems(opts);
  for (const item of room.items) {
    const se = item.handle ? sessions[item.handle] : null;
    store.emit('item.add', { threadId, item: se ? { ...item, sessionId: se.sessionId, ...(se.personaId ? { personaId: se.personaId } : {}) } : item });
  }
  return room.landmarks;
}

/**
 * Seeds the room into a conversation in a run’s data folder while its Postbox is down, with the agents’ sessions the
 * page made there, and says where its decision is, for the tester (bigroom.md’s phase 2: “the run gives it to you”).
 * @param {string} data  @param {string} threadId  @param {string[]} agents  the scenario’s; the mention is of the first
 */
export async function seedBigRoomData(data, threadId, agents) {
  const store = await new Store(data).load();
  /** @type {Record<string, { sessionId: string, personaId?: string }>} */
  const sessions = {};
  for (const se of Object.values(store.state.sessions ?? {}))
    if (se?.threadId === threadId && !se.archived && !sessions[se.handle]) sessions[se.handle] = { sessionId: se.id, personaId: se.personaId };
  const landmarks = seedBigRoom(store, threadId, { handles: agents }, sessions);
  // close writes what waits and stops the store's Redis (#508): left running, it would hold the data folder, and the
  // Postbox started next on it would refuse to start.
  await store.close();
  return {
    landmarks,
    /** @param {string} origin */
    note: (origin) =>
      `The room was seeded with about 1,000 generated items before you arrived. Its first decision is at ${origin}/#/t/${threadId}?at=${landmarks.decision}.`,
  };
}

/**
 * `- seed: big-room` in a run (tools/uat-run.mjs): once the page has started the conversation, stops Postbox, seeds the
 * room into its store, starts it again on the same data, and opens the room. Returns the note for the tester.
 * @param {{ postbox: { origin: string, restart: (o?: { whileDown?: () => Promise<void> }) => Promise<number> }, data: string,
 *   threadId: string, agents: string[], page: { goto: (url: string) => Promise<any> }, log: (line: string) => void }} o
 */
export async function openBigRoom({ postbox, data, threadId, agents, page, log }) {
  /** @type {Awaited<ReturnType<typeof seedBigRoomData>> | null} */
  let seeded = null;
  await postbox.restart({
    whileDown: async () => {
      seeded = await seedBigRoomData(data, threadId, agents);
    },
  });
  if (!seeded) throw new Error('Postbox restarted without seeding the big room.');
  await page.goto(`${postbox.origin}/#/t/${threadId}`);
  log(`Seeded the big room into ${threadId}: ${JSON.stringify(/** @type {any} */ (seeded).landmarks)}.`);
  return /** @type {any} */ (seeded).note(postbox.origin);
}
