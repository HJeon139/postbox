// The asset store’s checks on a run’s own records (#722, #723, #725): an asset’s content stays in its blob file, no
// room index or asset outlives its conversation, and no turn of a deleted conversation runs on past its delete. They
// read the store the run left (facts.store: its log, its snapshot and its asset files, readStore in
// tools/uat/run-files.mjs), the state, the turns’ streams, and when the tester deleted a conversation
// (facts.probes.conversation). The page’s stream and /api/state are built from the store’s events, so the log, the
// snapshot and the state cover what the browser could see.

/** The shortest line of an asset’s text looked for: a shorter one, such as a heading of one word, is everywhere. */
export const MIN_TEXT = 24;
/** How many of an asset’s first bytes its hex, base64 and byte-array forms are made from. */
const HEAD_BYTES = 48;

/**
 * What an asset’s content looks like in each encoding a copy of it could take: its lines as text (each of at least
 * MIN_TEXT characters, so a cut copy is found too), and the hex, base64 and JSON byte array of its first bytes, which
 * begin any copy of the whole. A file shorter than MIN_TEXT bytes has none: it can’t be told from other text.
 * @param {Buffer} bytes
 */
export function needlesOf(bytes) {
  if (bytes.length < MIN_TEXT) return { text: [], encoded: [], head: [] };
  const head = bytes.subarray(0, HEAD_BYTES);
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const text = decoded.includes('�') ? [] : [...new Set(decoded.split('\n').map((l) => l.trim()))].filter((l) => l.length >= MIN_TEXT);
  // Base64 of a whole number of 3-byte groups is a prefix of the whole file’s base64.
  const b64 = head.subarray(0, head.length - (head.length % 3)).toString('base64');
  return { text, encoded: [head.toString('hex'), b64], head: [...head.subarray(0, MIN_TEXT)] };
}

/** Whether a value holds a form of the content itself (not counting what’s under it). */
function holds(value, needles) {
  if (typeof value === 'string') {
    if (needles.text.find((l) => value.includes(l))) return 'text';
    if (needles.encoded.find((x) => x && value.toLowerCase().includes(x.toLowerCase()))) return 'encoded';
    return null;
  }
  if (Array.isArray(value) && needles.head.length && value.length >= needles.head.length) return needles.head.every((b, i) => value[i] === b) ? 'bytes' : null;
  return null;
}

/** Every place under `root` that holds the content, as [path, form]: the deepest key that holds it whole. */
function placesIn(root, needles, path = []) {
  const form = holds(root, needles);
  if (form) return [[path.join('.'), form]];
  if (!root || typeof root !== 'object') return [];
  return Object.entries(root).flatMap(([k, v]) => placesIn(v, needles, [...path, k]));
}

/**
 * The fields of an item that someone wrote, by the item’s kind, where they may quote an asset or give the text an agent
 * then publishes: the person’s message, an agent’s reply and its narration, and a block with its answer. Everything
 * else in an item is Postbox’s own record, such as the steps it writes for each tool call.
 */
const AUTHORED = { user: new Set(['text']), agent: new Set(['text']), voice: new Set(['text']), block: new Set(['block', 'answer']) };
/** The steps that are an agent’s own words, not a tool call: its thinking, and a subagent’s narration (server/runtime.mjs). */
const WORD_STEPS = new Set(['thought', 'said']);
/**
 * A session’s keys that hold its agent’s own words: its last reply and the glimpse of it, and the messages it sent
 * other agents. A recorded run’s `lastMessage` quoted the line its agent had just published.
 */
const SESSION_OWN = new Set(['lastMessage', 'glimpse', 'agentMessages']);
const never = () => false;
/** Whether a path in a session, or a patch of one, is under a key that holds its agent’s words. */
const sessionOwn = (path) => path.split('.').some((k) => SESSION_OWN.has(k));

/** Whether a step is an agent’s own words: its thinking or a subagent’s narration. @param {any} step */
const wordStep = (step) => WORD_STEPS.has(step?.kind);

/**
 * Whether a path in an item of this kind is someone’s own words: a field its author wrote, or one of an agent’s steps
 * that’s its thinking. @param {string|undefined} kind @param {any} item @param {string[]} keys  the path in the item
 */
function itemOwn(kind, item, keys) {
  if (AUTHORED[kind]?.has(keys[0])) return true;
  return kind === 'agent' && keys[0] === 'activity' && keys[1] === 'steps' && wordStep(item?.activity?.steps?.[keys[2]]);
}

/**
 * Which paths of a logged item event are someone’s own words: the item an item.add carries, an item.patch’s or
 * item.move’s patch, one step an item.patch adds, and an item.text’s streamed reply.
 * @param {any} e @param {string|undefined} kind  the item’s kind, from its item.add
 */
function itemEventOwn(e, kind) {
  return (path) => {
    const [head, ...keys] = path.split('.');
    if (head === 'item') return itemOwn(kind, e.data.item, keys);
    if (head === 'patch') return itemOwn(kind, e.data.patch, keys);
    if (head === 'activityStep') return kind === 'agent' && wordStep(e.data.activityStep);
    return e.type === 'item.text' && head === 'text' && AUTHORED[kind]?.has('text') === true;
  };
}

/** Each logged event as where it was, its type, its data, and which of its paths are someone’s own words. */
function logPlaces(log) {
  const kinds = new Map();
  return log.map((e) => {
    const item = e.data?.item;
    if (item?.id) kinds.set(item.id, item.kind);
    const where = `log #${e.seq}`;
    if (e.type.startsWith('item.')) return { where, type: e.type, data: e.data, own: itemEventOwn(e, kinds.get(item?.id ?? e.data?.id)) };
    return { where, type: e.type, data: e.data, own: e.type.startsWith('session') ? sessionOwn : never };
  });
}

/** The state’s parts, each with which of its paths are someone’s own words: its items, its sessions, and the rest. */
function stateParts(state, where) {
  if (!state) return [];
  const items = Object.entries(state.items ?? {}).flatMap(([threadId, list]) =>
    (list ?? []).map((it) => ({ where, type: `items.${threadId}`, data: it, own: (path) => itemOwn(it.kind, it, path.split('.')) })),
  );
  const rest = Object.entries(state)
    .filter(([k]) => k !== 'items')
    .map(([k, v]) => ({ where, type: k, data: v, own: k === 'sessions' ? sessionOwn : never }));
  return [...items, ...rest];
}

/**
 * Every copy of an asset’s content in the run’s records outside its blob file: the log, the snapshot and the final
 * state. Each says which file, where, under which key, in which form, and whether it’s someone’s own words.
 * @param {any} facts
 */
export function contentCopies(facts) {
  const parts = [...logPlaces(facts.store?.log ?? []), ...stateParts(facts.store?.snapshot, 'snapshot'), ...stateParts(facts.state, 'state')];
  return (facts.store?.files ?? []).flatMap(({ sha, bytes }) => {
    const needles = needlesOf(bytes);
    if (!needles.text.length && !needles.encoded.length) return [];
    return parts.flatMap((p) => placesIn(p.data, needles).map(([path, form]) => ({ sha, where: p.where, type: p.type, path, form, own: p.own(path) })));
  });
}

/** The keys an asset and an asset version carry (shared/state-assets.mjs), and nothing else. */
const ASSET_KEYS = new Set(['id', 'room', 'name', 'created', 'head', 'versions']);
const VERSION_KEYS = new Set(['v', 'sha256', 'size', 'type', 'isText', 'author', 'at', 'base', 'op', 'pruned']);

/** Each asset and version in the final state with a key it shouldn’t have. @param {any} state */
export function strayKeys(state) {
  return Object.values(state?.assets ?? {}).flatMap((a) => [
    ...Object.keys(a)
      .filter((k) => !ASSET_KEYS.has(k))
      .map((k) => ({ id: a.id, key: k, v: null })),
    ...(a.versions ?? []).flatMap((x) =>
      Object.keys(x)
        .filter((k) => !VERSION_KEYS.has(k))
        .map((k) => ({ id: a.id, key: k, v: x.v })),
    ),
  ]);
}

/**
 * Rooms and assets that outlive their conversation: an `assetRooms` key or an asset whose room has no thread in the
 * state (#723).
 * @param {any} state
 */
export function orphanRooms(state) {
  const gone = (room) => !state?.threads?.[room];
  const rooms = Object.keys(state?.assetRooms ?? {}).filter(gone);
  const indexed = new Set(rooms);
  const assets = Object.values(state?.assets ?? {}).filter((a) => gone(a.room) && !indexed.has(a.room));
  return [...rooms.map((room) => ({ room, what: 'its room index' })), ...assets.map((a) => ({ room: a.room, what: `asset ${a.id}` }))];
}

/** Clocks and file times differ by a few milliseconds, and a stopped turn’s last write follows its Stop. */
const SLACK_MS = 2000;

/**
 * Turns of a deleted conversation’s agents that ran on past its delete (#725): a delete stops every turn in it at once
 * (#1224), so a stream that started before the delete and still wrote well after it wasn’t stopped. A turn that started
 * after the delete is left out: its agent’s handle may run in another conversation. @param {any} facts
 */
export function turnsAfterDeletes(facts) {
  const deletes = (facts.probes?.conversation ?? []).filter((x) => x.do === 'delete' && Number.isFinite(x.at));
  return deletes.flatMap((del) => {
    const handles = new Set(del.handles ?? []);
    return (facts.streams ?? [])
      .filter((s) => handles.has(s.handle) && s.started < del.at && s.ended > del.at + SLACK_MS)
      .map((s) => ({ ...del, handle: s.handle, started: s.started, ended: s.ended }));
  });
}

const shortSha = (sha) => String(sha).slice(0, 12);

export const ASSET_STORE_CHECKS = [
  {
    id: 'asset-content-in-store',
    inputs: ['store', 'state'],
    issue: 722,
    run: (facts) => [
      ...contentCopies(facts)
        .filter((c) => !c.own)
        .map((c) => ({
          key: `${c.sha}:${c.where}:${c.type}:${c.path}`,
          title: 'An asset’s content is stored outside its file',
          evidence: `Asset file ${shortSha(c.sha)}’s content, as ${c.form}, is in the ${c.where} under ${c.type}${c.path ? `.${c.path}` : ''}.`,
        })),
      ...strayKeys(facts.state).map((x) => ({
        key: `${x.id}:${x.v ?? 'asset'}:${x.key}`,
        title: 'An asset record carries a key it shouldn’t',
        evidence: `${x.v ? `Version ${x.v} of asset ${x.id}` : `Asset ${x.id}`} has the key “${x.key}”, which no asset record has.`,
      })),
    ],
  },
  {
    id: 'asset-room-orphan',
    inputs: ['state'],
    issue: 723,
    run: (facts) =>
      orphanRooms(facts.state).map((o) => ({
        key: `${o.room}:${o.what}`,
        title: 'An asset room outlives its conversation',
        evidence: `Room ${o.room} has no conversation, but the state keeps ${o.what}.`,
      })),
  },
  {
    id: 'turn-after-delete',
    inputs: ['probes', 'streams'],
    issue: 725,
    run: (facts) =>
      turnsAfterDeletes(facts).map((t) => ({
        key: `${t.threadId}:${t.at}:${t.handle}:${t.started}`,
        title: 'A turn ran on after its conversation was deleted',
        evidence: `@${t.handle}’s turn ran ${((t.ended - t.at) / 1000).toFixed(1)} s past the delete of “${t.title ?? t.threadId}” at ${new Date(t.at).toISOString()}: it started at ${new Date(t.started).toISOString()}.`,
      })),
  },
];
