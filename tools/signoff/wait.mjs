// Every wait in tools/signoff.mjs talks: a command that runs past PROGRESS_MS prints a line
// saying what it waits on and for how long, and again each PROGRESS_MS after. A sign-off that printed nothing for 15
// minutes had its turn stopped as hung (#845).

/** Under a minute, so a timer that fires a little late still prints at least once a minute. */
export const PROGRESS_MS = 50_000;

/**
 * Awaits work, printing a line every PROGRESS_MS while it runs.
 * @template T
 * @param {Pick<import('./deps.mjs').Deps, 'now' | 'every' | 'log'>} d @param {string} label @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function loud(d, label, work) {
  const start = d.now();
  const stop = d.every(PROGRESS_MS, () => d.log(`… still waiting on ${label}, ${Math.round((d.now() - start) / 1000)} s so far`));
  try {
    return await work();
  } finally {
    stop();
  }
}

/**
 * Runs argv through d.run, printing while it waits. With o.stop (./stop.mjs), a signal passes on to it while it runs,
 * and once one has arrived it runs nothing and throws.
 * @param {import('./deps.mjs').Deps} d @param {string[]} argv @param {import('./deps.mjs').RunOptions} [o]
 */
export async function exec(d, argv, o = {}) {
  const { stop, ...rest } = o;
  if (!stop) return loud(d, argv.join(' '), () => d.run(argv, rest));
  if (stop.signal) throw new Error(`stopped by ${stop.signal} before ${argv.join(' ')}`);
  const started = (/** @type {(signal: string) => void} */ kill) => {
    stop.kill = kill;
  };
  try {
    return await loud(d, argv.join(' '), () => d.run(argv, { ...rest, started }));
  } finally {
    stop.kill = undefined;
  }
}

/**
 * The trimmed output of a command that must succeed; throws naming it and its exit code when it doesn’t.
 * @param {import('./deps.mjs').Deps} d @param {string[]} argv @param {import('./deps.mjs').RunOptions} [o]
 */
export async function must(d, argv, o = {}) {
  const r = await exec(d, argv, o);
  if (r.code !== 0) throw new Error(`${argv.join(' ')} exited ${r.code}: ${firstLine(r.out)}`);
  return r.out.trim();
}

/** A line without Biome’s rule of ━ after a file’s name. @param {string} l */
const plain = (l) => l.replace(/\s*━+$/, '').trim();

/** The first non-empty line of a command’s output, for a one-line reason. @param {string} out */
export const firstLine = (out) => out.split('\n').map(plain).find(Boolean) ?? '(no output)';

/** The last non-empty line of a command’s output: where a run of several lints names the one that failed. @param {string} out */
export const lastLine = (out) => out.split('\n').map(plain).findLast(Boolean) ?? '(no output)';
