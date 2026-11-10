// The snapshot as lines (#1180). V8 caps a string at 536,870,888 characters, and a snapshot written as one JSON value
// had to be built, and read back, as one string: past that size it failed to save, and once its log segment grew past
// it too, Postbox couldn’t start. Format 2 writes a header line, then one JSON value per line, each small: a map’s
// entries one by one, and a conversation’s items one by one. A snapshot written before it, one JSON value on one line,
// still loads. Read by the store (server/store-recover.mjs) and by the tools that read a data folder.

/** The first line of a format-2 snapshot. */
export const SNAPSHOT_HEADER = Object.freeze({ postbox: 'snapshot', format: 2 });

/**
 * The state as format-2 lines, without their newlines: the header, then for each key of the state one line for a plain
 * value, or a map’s start and a line per entry, an entry that’s a list as its start and a line per element.
 * @param {Record<string, any>} state
 * @returns {Generator<string>}
 */
export function* snapshotLines(state) {
  yield JSON.stringify(SNAPSHOT_HEADER);
  for (const [key, value] of Object.entries(state)) {
    if (Array.isArray(value)) {
      yield JSON.stringify(['A', key]);
      for (const el of value) yield JSON.stringify(['I', key, el]);
    } else if (value && typeof value === 'object') {
      yield JSON.stringify(['m', key]);
      for (const [k, v] of Object.entries(value)) {
        if (!Array.isArray(v)) {
          yield JSON.stringify(['e', key, k, v]);
          continue;
        }
        yield JSON.stringify(['a', key, k]);
        for (const el of v) yield JSON.stringify(['i', key, k, el]);
      }
    } else yield JSON.stringify(['v', key, value]);
  }
}

/** A first line’s value, or undefined when it isn’t a JSON value on its own, as an old snapshot’s first line may not be. */
function firstValue(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Whether a first line’s value is format 2’s header. @param {unknown} value */
const isHeader = (value) =>
  Boolean(value) && typeof value === 'object' && /** @type {any} */ (value).postbox === SNAPSHOT_HEADER.postbox && /** @type {any} */ (value).format === 2;

/**
 * Reads a snapshot back into a state, line by line, so no line is longer than its largest entry. A snapshot of the
 * old format, one JSON value, is that value. Throws on a line it can’t place, naming it; ENOENT passes through.
 * @param {{ open: typeof import('node:fs/promises').open, readFile: typeof import('node:fs/promises').readFile }} io @param {string} path
 * @returns {Promise<Record<string, any>>}
 */
export async function readSnapshotFile(io, path) {
  const fh = await io.open(path, 'r');
  try {
    /** @type {Record<string, any> | null} */
    let state = null;
    let n = 0;
    for await (const line of fh.readLines({ autoClose: false })) {
      n++;
      if (n === 1) {
        // Not the header: the old format, one JSON value, read whole as before (#1180). That includes one written
        // across lines, as a hand-made fixture can be; a snapshot Postbox wrote in it was under the string limit.
        if (!isHeader(firstValue(line))) return JSON.parse(await io.readFile(path, 'utf8'));
        state = Object.create(null);
        continue;
      }
      if (line) place(/** @type {Record<string, any>} */ (state), JSON.parse(line), n);
    }
    if (!state) throw new Error('the snapshot is empty');
    return state;
  } finally {
    await fh.close();
  }
}

/**
 * A snapshot’s text, of either format, as a state: for the tools that read a data folder’s snapshot.json whole
 * (tools/bench-snapshot-stall.mjs, tools/measure-archive-policies.mjs). The store reads it line by line instead.
 * @param {string} text @returns {Record<string, any>}
 */
export function parseSnapshotText(text) {
  const lines = text.split('\n');
  if (!isHeader(firstValue(lines[0]))) return JSON.parse(text); // the old format, one JSON value
  const state = Object.create(null);
  for (let n = 1; n < lines.length; n++) if (lines[n]) place(state, JSON.parse(lines[n]), n + 1);
  return state;
}

/** The bytes a snapshot of this state takes on disk. @param {Record<string, any>} state */
export function snapshotBytes(state) {
  let bytes = 0;
  for (const line of snapshotLines(state)) bytes += Buffer.byteLength(line) + 1;
  return bytes;
}

/** Puts one format-2 line into the state. Maps are made without a prototype, so no key reaches Object’s. */
function place(state, entry, n) {
  if (!Array.isArray(entry)) throw new Error(`line ${n} of the snapshot isn’t a snapshot line`);
  const [op, key, ...rest] = entry;
  if (op === 'v') state[key] = rest[0];
  else if (op === 'm') state[key] = Object.create(null);
  else if (op === 'A') state[key] = [];
  else if (op === 'I') state[key].push(rest[0]);
  else if (op === 'e') state[key][rest[0]] = rest[1];
  else if (op === 'a') state[key][rest[0]] = [];
  else if (op === 'i') state[key][rest[0]].push(rest[1]);
  else throw new Error(`line ${n} of the snapshot has an unknown kind, ${JSON.stringify(op)}`);
}
