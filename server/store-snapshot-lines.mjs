// The snapshot as lines (#1180). V8 caps a string at 536,870,888 characters, and a snapshot written as one JSON value
// had to be built, and read back, as one string: past that size it failed to save, and once its log segment grew past
// it too, Postbox couldn’t start. Format 2 writes a header line, then one JSON value per line, each small: a map’s
// entries one by one, and a conversation’s items one by one, then an end line that counts them, so a file cut short at
// a line boundary is refused rather than loaded as a smaller state. Lines split on the newline byte alone: readline also
// ends a line at U+2028 and U+2029, which JSON.stringify leaves as they are (critic, on #1194). A snapshot of one JSON
// value, as Postbox wrote before #1180 and tools/snapshot-for-older.mjs writes, still loads. Read by the store (server/store-recover.mjs) and by the tools that read a data folder.

/** The first line of a format-2 snapshot. */
export const SNAPSHOT_HEADER = Object.freeze({ postbox: 'snapshot', format: 2 });

/**
 * The state as format-2 lines, without their newlines: the header, then for each key of the state one line for a plain
 * value, or a map’s start and a line per entry, an entry that’s a list as its start and a line per element; last, the
 * end line, ["end", the count of lines between it and the header].
 * @param {Record<string, any>} state
 * @returns {Generator<string>}
 */
export function* snapshotLines(state) {
  yield JSON.stringify(SNAPSHOT_HEADER);
  let count = 0;
  for (const line of bodyLines(state)) {
    count++;
    yield line;
  }
  yield JSON.stringify(['end', count]);
}

/** The lines between the header and the end line. @param {Record<string, any>} state @returns {Generator<string>} */
function* bodyLines(state) {
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

/**
 * Reads a snapshot back into a state, line by line, so no line is longer than its largest entry. A snapshot of the
 * old format, one JSON value, is that value. Throws on a line it can’t place, naming it; ENOENT passes through.
 * @param {{ open: typeof import('node:fs/promises').open, readFile: typeof import('node:fs/promises').readFile }} io @param {string} path
 * @returns {Promise<Record<string, any>>}
 */
export async function readSnapshotFile(io, path) {
  // Not format 2’s header and its newline: one JSON value, read whole as before. Postbox writes that while the state
  // fits the string limit (C5 on #1155), and before #1180 always did; a hand-made one may run across lines.
  const fh = await io.open(path, 'r');
  let lines;
  try {
    lines = await startsWithHeader(fh);
  } finally {
    await fh.close();
  }
  if (!lines) return JSON.parse(await io.readFile(path, 'utf8'));
  const reader = lineReader();
  let n = 0;
  for await (const { line, terminated } of fileLines(io, path)) {
    if (++n === 1) continue;
    if (!terminated) throw new Error(`line ${n} of the snapshot has no newline: the file was cut short`);
    reader.take(line, n);
  }
  return reader.done();
}

const HEADER_LINE = Buffer.from(`${JSON.stringify(SNAPSHOT_HEADER)}\n`);

/** Whether the file opens with format 2’s header line, read from its first bytes alone. */
async function startsWithHeader(fh) {
  const buf = Buffer.alloc(HEADER_LINE.length);
  const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
  return bytesRead === buf.length && buf.equals(HEADER_LINE);
}

/** How much of a file fileLines reads at a time. */
const CHUNK = 1 << 20;

/**
 * A file’s lines, read a chunk at a time rather than as one string (#1180), each with whether a newline ended it. Split
 * on the newline byte alone, so a line is decoded whole, a character is never cut, and U+2028 and U+2029 stay in their
 * line. The log’s replay (server/store-replay.mjs) and the snapshot both read through it.
 * @param {{ open: typeof import('node:fs/promises').open }} io @param {string} path
 * @returns {AsyncGenerator<{ line: string, terminated: boolean }>}
 */
export async function* fileLines(io, path) {
  const fh = await io.open(path, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    let carry = Buffer.alloc(0);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, null);
      if (!bytesRead) break;
      const chunk = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
      let start = 0;
      for (let nl = chunk.indexOf(10, start); nl !== -1; nl = chunk.indexOf(10, start)) {
        yield { line: chunk.toString('utf8', start, nl), terminated: true };
        start = nl + 1;
      }
      carry = chunk.subarray(start);
    }
    if (carry.length) yield { line: carry.toString('utf8'), terminated: false };
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
  if (!text.startsWith(HEADER_LINE.toString())) return JSON.parse(text); // one JSON value
  const lines = text.split('\n');
  if (lines.at(-1) !== '') throw new Error(`line ${lines.length} of the snapshot has no newline: the file was cut short`);
  const reader = lineReader();
  for (let n = 1; n < lines.length - 1; n++) reader.take(lines[n], n + 1);
  return reader.done();
}

/** Builds a state from format-2 lines after the header, and refuses one that ends before its end line, or runs past it. */
function lineReader() {
  const state = Object.create(null);
  let count = 0;
  let ended = false;
  return {
    /** @param {string} line @param {number} n */
    take(line, n) {
      if (ended) throw new Error(`line ${n} of the snapshot comes after its end line`);
      const entry = JSON.parse(line);
      if (!Array.isArray(entry) || entry[0] !== 'end') {
        place(state, entry, n);
        count++;
        return;
      }
      if (entry[1] !== count) throw new Error(`the snapshot’s end line counts ${entry[1]} lines, and ${count} came before it`);
      ended = true;
    },
    done() {
      if (!ended) throw new Error('the snapshot ends before its end line: the file was cut short');
      return state;
    },
  };
}

/**
 * The state as one JSON value, or null past V8’s string limit, where only lines can hold it: what
 * tools/snapshot-for-older.mjs writes for a Postbox from before #1180. @param {any} state
 */
export function oneValue(state) {
  try {
    return JSON.stringify(state);
  } catch (e) {
    if (e instanceof RangeError) return null;
    throw e;
  }
}

/** The bytes a snapshot of this state takes on disk, as writeSnapshot writes it. @param {any} state */
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
