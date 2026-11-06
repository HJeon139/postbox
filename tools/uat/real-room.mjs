// A room the shape of a real one (#508, #305): the switch bench’s second seed, beside the uniform big-room seed
// (big-room.mjs). Its mix of item kinds and their sizes follows the one measured room on record, sprint 2’s burndown
// room (#305, the comment of 5 Nov 2026): 1,210 items over 26 hours, 3.35 MB, a median of 1.5 KB and a largest of
// 87 KB, an agent reply with its steps. Only counts and sizes came from that room; every word here is generated, and
// the same seed gives the same room.

import { Store } from '../../server/store.mjs';
import { buildEvent } from '../../shared/events.mjs';

/** The measured room’s items by kind, per 1,210, and the mean bytes of one (#305: each kind’s bytes over its count). */
export const PROFILE = [
  { kind: 'agent', per: 657, bytes: 3745 },
  { kind: 'voice', per: 214, bytes: 150 },
  { kind: 'permission', per: 97, bytes: 3300 },
  { kind: 'review', per: 56, bytes: 5860 },
  { kind: 'user', per: 48, bytes: 230 },
  { kind: 'choice', per: 36, bytes: 1670 },
  { kind: 'progress', per: 25, bytes: 1560 },
  { kind: 'confirm', per: 24, bytes: 2580 },
  // System lines, plus the moved items, hops, denials and proposal the measured room had (50 in all), as system lines.
  { kind: 'system', per: 53, bytes: 470 },
];
const MEASURED = 1210;

/**
 * The rooms a seed can take the shape of: each one’s measured size, its items by kind per that size with the mean
 * bytes of one, and the steps of its largest agent reply.
 * - real: #305’s burndown room, as above;
 * - this-room: sprint 4’s room as researcher counted it on 6 Nov 2026 (880 items, 11% blocks, the largest reply
 *   19.7 K characters), with #305’s bytes for the kinds it gave no size for.
 */
export const PROFILES = {
  real: { measured: MEASURED, kinds: PROFILE, largestSteps: 270 },
  'this-room': {
    measured: 880,
    kinds: [
      { kind: 'agent', per: 588, bytes: 3745 },
      { kind: 'voice', per: 80, bytes: 150 },
      { kind: 'permission', per: 59, bytes: 3300 },
      { kind: 'review', per: 29, bytes: 7000, max: 16700 },
      { kind: 'confirm', per: 27, bytes: 870, max: 1600 },
      { kind: 'progress', per: 16, bytes: 600, max: 1200 },
      { kind: 'choice', per: 15, bytes: 660, max: 1100 },
      { kind: 'form', per: 9, bytes: 1230, max: 2100 },
      { kind: 'table', per: 1, bytes: 600 },
      { kind: 'user', per: 19, bytes: 230 },
      // max: the largest of a kind the room had, where researcher measured it.
      // Wake lines, agents added, proposals, other answers and the one app, as system lines.
      { kind: 'system', per: 37, bytes: 300 },
    ],
    largestSteps: 57,
  },
};

/** A profile by its name, or an error that names the ones there are. @param {string} name */
function profileOf(name) {
  const p = PROFILES[name];
  if (!p) throw new Error(`No room profile “${name}”: ${Object.keys(PROFILES).join(' or ')}.`);
  return p;
}
/** About what one step of an agent reply takes in the store (#305: 1.56 MB over 4,608 steps). */
const STEP_BYTES = 340;
const WORDS = ['release', 'changelog', 'runner', 'gate', 'branch', 'review', 'fixture', 'spec', 'migration', 'note', 'host', 'merge'];

/** mulberry32, as big-room.mjs uses. @param {number} seed */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generated words, about n characters of them. @param {() => number} rnd @param {number} n */
function words(rnd, n) {
  const out = [];
  let len = 0;
  while (len < n) {
    const w = WORDS[Math.floor(rnd() * WORDS.length)];
    out.push(w);
    len += w.length + 1;
  }
  return out.join(' ');
}

/** A size near mean, spread as a log-normal is (most below the mean, a few well above). @param {() => number} rnd */
function spread(rnd, mean, max = mean * 8) {
  const z = Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const sigma = 1;
  // Capped at the kind’s largest (8 times its mean unless the profile measured it), so the room’s largest item is the agent reply placed as the measured room’s was.
  return Math.max(40, Math.min(max, Math.round(mean * Math.exp(sigma * z - (sigma * sigma) / 2))));
}

/** The kinds of n items, in the profile’s proportions, shuffled by rnd so the mix is even through the room. */
function kindsFor(n, rnd, profile) {
  const kinds = profile.kinds.flatMap(({ kind, per }) => Array(Math.round((per * n) / profile.measured)).fill(kind));
  while (kinds.length < n) kinds.push('agent');
  kinds.length = n;
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
  }
  return kinds;
}

/** Item i’s id, padded as big-room.mjs pads, so ids sort in room order. */
export const realIdOf = (i, count) => `it_real${String(i).padStart(Math.max(4, String(count - 1).length), '0')}`;

/** A block’s item, answered as the person answered it: approved, the first option, confirmed. */
function blockItem(base, block, action, values) {
  if (!action) return { ...base, kind: 'block', valid: true, block };
  const r = buildEvent(block, action, values, { revision: 1 });
  if (!r.ok) throw new Error(`A seeded ${block.type} couldn’t be answered: ${r.error}`);
  const answer = { action, values: r.event.values, voice: r.voice, at: base.at, revision: 1, read: true };
  return { ...base, kind: 'block', valid: true, block, answered: true, answer };
}

/** One item of a kind, about bytes in size. */
function itemOf(kind, base, bytes, rnd, i, steps) {
  const text = (n) => words(rnd, Math.max(20, n));
  if (kind === 'agent') {
    const own = steps ?? Math.max(1, Math.round((bytes * 0.6) / STEP_BYTES));
    const list = Array.from({ length: own }, (_, k) => ({
      id: `st_${i}_${k}`,
      kind: k % 3 === 1 ? 'thought' : 'tool',
      label: text(STEP_BYTES - 90),
      state: 'done',
      ...(k % 3 === 1 ? {} : { ms: 20 + Math.floor(rnd() * 2000) }),
    }));
    return { ...base, kind: 'agent', text: text(Math.max(40, bytes * 0.4)), status: 'done', activity: { steps: list } };
  }
  if (kind === 'voice' || kind === 'user') return { ...base, kind, text: text(bytes - 60) };
  if (kind === 'system') return { ...base, kind: 'system', text: text(bytes - 60) };
  if (kind === 'permission')
    return { ...base, kind: 'permission', tool: 'Bash', summary: text(80), detail: text(Math.min(3900, bytes - 200)), status: 'allowed' };
  const id = `b${i}`;
  const head = { id, version: 1, title: text(30), fallback: text(60) };
  if (kind === 'review')
    return blockItem(base, { ...head, type: 'review', format: 'markdown', content: `# ${text(30)}\n\n${text(bytes - 200)}\n` }, 'submit', {
      verdict: 'approve',
      comments: [],
    });
  if (kind === 'choice') {
    const options = Array.from({ length: 4 }, (_, k) => ({ id: `o${k}`, label: text(30), description: text(Math.min(190, bytes / 6)) }));
    return blockItem(base, { ...head, type: 'choice', prompt: text(Math.min(1900, bytes / 3)), options }, 'choose', { selected: ['o0'] });
  }
  if (kind === 'progress') {
    const n = Math.max(2, Math.min(40, Math.round(bytes / 120)));
    const list = Array.from({ length: n }, (_, k) => ({ id: `s${k}`, label: text(40), state: 'done', detail: text(40) }));
    return blockItem(base, { ...head, type: 'progress', steps: list }, null, null);
  }
  if (kind === 'form') {
    const fields = Array.from({ length: 4 }, (_, k) => ({ id: `f${k}`, label: text(30), kind: 'text', help: text(Math.min(190, bytes / 6)) }));
    const values = Object.fromEntries(fields.map((f) => [f.id, text(20)]));
    return blockItem(base, { ...head, type: 'form', prompt: text(Math.min(1900, bytes / 4)), fields }, 'submit', values);
  }
  if (kind === 'table') {
    const columns = [
      { id: 'a', label: 'Item' },
      { id: 'b', label: 'Note' },
    ];
    const rows = Array.from({ length: 8 }, (_, k) => ({ id: `r${k}`, cells: { a: text(12), b: text(Math.max(20, bytes / 16)) } }));
    return blockItem(base, { ...head, type: 'table', columns, rows }, null, null);
  }
  return blockItem(base, { ...head, type: 'confirm', statement: text(Math.min(1900, bytes - 200)), confirmLabel: 'Go ahead' }, 'confirm', {});
}

/** Where the n largest agent replies go: the first agent reply at or after each of n even marks through the room. */
function largestAt(kinds, n) {
  const at = new Set();
  for (let k = 0; k < n; k++) {
    const from = Math.floor(((k + 0.5) * kinds.length) / n);
    const i = kinds.findIndex((kind, j) => j >= from && kind === 'agent' && !at.has(j));
    if (i >= 0) at.add(i);
  }
  return at;
}

/**
 * The room’s items, oldest first: count items in the measured room’s mix of kinds and sizes, the agents’ among
 * handles, over 26 hours scaled by count, with one 87 KB agent reply per 1,210 items.
 * @param {{ count?: number, start?: number, seed?: number, handles?: string[] }} [opts]
 */
export function realRoomItems({
  count = MEASURED,
  start = Date.UTC(2026, 8, 1, 9),
  seed = 305,
  handles = ['researcher', 'critic', 'developer'],
  profile: name = 'real',
} = {}) {
  const profile = profileOf(name);
  const rnd = random(seed);
  const kinds = kindsFor(count, rnd, profile);
  const step = Math.floor((26 * 3600 * 1000) / profile.measured);
  const largest = largestAt(kinds, Math.max(1, Math.round(count / profile.measured)));
  const mean = Object.fromEntries(profile.kinds.map((p) => [p.kind, p.bytes]));
  const max = Object.fromEntries(profile.kinds.map((p) => [p.kind, p.max]));
  return kinds.map((kind, i) => {
    const base = { id: realIdOf(i, count), at: start + i * step, handle: kind === 'user' || kind === 'system' ? undefined : handles[i % handles.length] };
    const big = kind === 'agent' && largest.has(i);
    return itemOf(kind, base, spread(rnd, mean[kind], max[kind]), rnd, i, big ? profile.largestSteps : undefined);
  });
}

/**
 * Seeds the room into a conversation of a data folder while its Postbox is down, with each agent’s item in its session
 * there, as seedBigRoomData does. Returns the last item’s id.
 * @param {string} data  @param {string} threadId  @param {string[]} agents  @param {{ count?: number }} [opts]
 */
export async function seedRealRoomData(data, threadId, agents, { count = MEASURED, profile = 'real' } = {}) {
  const store = await new Store(data).load();
  const sessions = {};
  for (const se of Object.values(store.state.sessions ?? {}))
    if (se?.threadId === threadId && !se.archived && !sessions[se.handle]) sessions[se.handle] = { sessionId: se.id, personaId: se.personaId };
  const items = realRoomItems({ count, handles: agents, profile });
  for (const item of items) {
    const se = item.handle ? sessions[item.handle] : null;
    const { handle, ...rest } = item;
    const own = handle ? { handle, ...(se ? { sessionId: se.sessionId, personaId: se.personaId } : {}) } : {};
    store.emit('item.add', { threadId, item: { ...rest, ...own } });
  }
  await store.close();
  return items[items.length - 1].id;
}
