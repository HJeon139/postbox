// What the live-progress measurement replays (tools/measure-progress.mjs): each backend’s recorded streams in
// tests/fixtures/, each through its adapter’s own mapper, and a synthetic long turn. A recording that streams no words
// and no step, such as Codex’s model list or a run that failed before any output, isn’t a turn, and is counted apart.

import { readdirSync, readFileSync } from 'node:fs';
import { createAgyMapper } from '../../server/adapters/antigravity-cli.mjs';
import { createStreamMapper } from '../../server/adapters/claude-stream.mjs';
import { createCodexMapper } from '../../server/adapters/codex.mjs';
import { createKiroMapper } from '../../server/adapters/kiro-cli.mjs';

const FIXTURES = new URL('../../tests/fixtures/', import.meta.url);

/**
 * Each backend’s mapper, on the process’s clock (the virtual one while measuring). Codex reads a file it was told of
 * through io.read: here that’s nothing, so the replay never reads the disk.
 * @type {Record<string, (c: any) => { push: (e: any) => void, end?: () => void }>}
 */
export const MAPPERS = {
  'claude-code': (c) => createStreamMapper(c, { now: () => Date.now() }),
  'codex-app-server': (c) => createCodexMapper(c, { read: () => '' }),
  'kiro-cli': (c) => createKiroMapper(c, { now: () => Date.now() }),
  'antigravity-cli': (c) => createAgyMapper(c, { now: () => Date.now() }),
};

/** A recording’s events; a line that isn’t JSON is an error in the fixture, so it throws. @param {string} path */
const eventsOf = (path) =>
  readFileSync(new URL(path, FIXTURES), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

/**
 * Whether a recording is a turn: fed to its mapper, it reports words or a step. A context that answers every call
 * stands in for the runtime’s. @param {import('./drive.mjs').Recording} rec
 */
export function isTurn(rec) {
  let said = 0;
  /** @type {any} */
  const ctx = new Proxy(
    { state: {}, persona: { permissionMode: 'auto' }, signal: new AbortController().signal },
    {
      get(target, key) {
        if (key === 'text' || key === 'activity') return () => said++;
        return Object.hasOwn(target, key) ? target[/** @type {string} */ (key)] : () => {};
      },
    },
  );
  const m = rec.mapper(ctx);
  for (const e of rec.events) {
    try {
      m.push(e);
    } catch {}
  }
  return said > 0;
}

/** Every recording of a backend, as a turn or not. @param {string} backend */
export function recordings(backend) {
  return readdirSync(new URL(`${backend}/`, FIXTURES))
    .filter((n) => n.endsWith('.jsonl'))
    .sort()
    .map((name) => {
      const rec = { name: `${backend}/${name}`, events: eventsOf(`${backend}/${name}`), mapper: MAPPERS[backend] };
      return { ...rec, turn: isTurn(rec) };
    });
}

/** Every backend’s recordings that are turns, in a fixed order, for a crowd to stream. */
export const turnsOfAll = () => Object.keys(MAPPERS).flatMap((b) => recordings(b).filter((r) => r.turn));

/**
 * A turn of `n` steps, words before each, as a long run of reading and editing reports them: a command with its input,
 * the end of its output and a line of detail, and every third step an edit with its diff.
 * @param {number} n @returns {import('./drive.mjs').Recording}
 */
export function longTurn(n) {
  /** @type {any[]} */
  const events = [];
  const output = (i) => `${Array.from({ length: 8 }, (_, k) => `line ${k} of the output of step ${i}: a path, a count, a status`).join('\n')}`;
  for (let i = 0; i < n; i++) {
    const edit = i % 3 === 2;
    const label = edit ? `Edited src/module-${i}.mjs` : `Ran grep -rn "pattern ${i}" src/`;
    events.push({ text: `Step ${i} looks at the next part of the work and says what it found. ` });
    events.push({ step: { id: `s${i}`, label, state: 'running', input: edit ? `src/module-${i}.mjs` : `grep -rn "pattern ${i}" src/` } });
    events.push({
      step: {
        id: `s${i}`,
        label,
        state: 'done',
        ms: 40 + (i % 7),
        output: output(i),
        detail: `Found ${i % 11} matches in ${i % 5} files.`,
        ...(edit ? { added: 3, deleted: 1, diff: `-const a = ${i};\n+const a = ${i + 1};\n+const b = a * 2;\n+export { b };` } : {}),
      },
    });
  }
  events.push({ text: 'Done.' });
  return {
    name: `long ${n}`,
    events,
    mapper: (c) => ({ push: (e) => (e.text ? c.text(e.text) : c.activity(e.step)) }),
  };
}
