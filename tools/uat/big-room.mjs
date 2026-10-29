// `- seed: big-room` (#508, designs/508/testing-strategy.md, “Seeds and runner changes”): a generated room of about
// 1,000 items, so catch-up has to leave things out and the page holds only a window of it. It’s generated, not copied
// from a real room, so no project’s content reaches the tester model, and the same seed gives the same room. It holds
// three landmarks the scenarios name: a mention of @researcher as its oldest addressed item (delivery.md, phase 2), a
// review block from @researcher near its start (bigroom.md, phase 3), and a decision whose id the run links to
// (bigroom.md, phase 2). Its first day uses a word no later day does, for the search phase (bigroom.md, phase 4).

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
  const items = [
    {
      id: landmarks.mention,
      at: at(0),
      kind: 'user',
      text: `@${handles[0]} what did the 1.9 retro decide about the release train, and who owns the ${FIRST_DAY_WORD} checklist?`,
    },
    filler(rnd, 1, at(1), handles, true),
    {
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
    },
    filler(rnd, 3, at(3), handles, true),
    filler(rnd, 4, at(4), handles, true),
    { id: landmarks.decision, at: at(5), kind: 'user', text: 'Decision: 2.0 ships on the release train, not on a fixed date.' },
  ];
  for (let i = items.length; i < count; i++) items.push(filler(rnd, i, at(i), handles.slice(1).length ? handles.slice(1) : handles, at(i) < start + DAY_MS));
  return { items, landmarks };
}

/**
 * Writes the room’s items into a conversation of a loaded store, as `item.add` events, before Postbox serves it.
 * @param {{ emit: (type: string, data: any) => any }} store  @param {string} threadId
 * @param {Parameters<typeof bigRoomItems>[0]} [opts]
 */
export function seedBigRoom(store, threadId, opts) {
  const room = bigRoomItems(opts);
  for (const item of room.items) store.emit('item.add', { threadId, item });
  return room.landmarks;
}
