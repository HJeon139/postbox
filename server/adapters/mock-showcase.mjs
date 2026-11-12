// The showcase replays (tools/demo/showcase/README.md): real sessions, recorded once with real agents, played back by
// the mock so the demo and the README’s GIF can show them for free. Each recording is one room where a person asked
// @builder (Claude Code) one hard question, @builder answered with an app and asked @critic (Codex) to review it,
// @critic pinned comments to the app’s parts, and @builder shipped v2. The replay says the agents’ recorded words,
// shows their recorded apps and comments, and reports each turn’s recorded cost, in three turns: the build, the review
// and the revision. The recordings live in the repository, not the package, so an installed Postbox has none.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const DIR = new URL('../../tools/demo/showcase/', import.meta.url);

/** @type {Promise<Map<string, any>> | null} the recordings, by the person’s question */
let loaded = null;

/** Reads every recording once, with its two app versions. None, where tools/ isn’t there. */
function stories() {
  loaded ??= (async () => {
    const byAsk = new Map();
    const dirs = await readdir(DIR, { withFileTypes: true }).catch(() => []);
    for (const d of dirs.filter((e) => e.isDirectory())) {
      const story = JSON.parse(await readFile(new URL(`${d.name}/story.json`, DIR), 'utf8'));
      byAsk.set(story.ask.trim(), story);
    }
    return byAsk;
  })();
  return loaded;
}

/** Which recording each room replays, by its thread: set by the person’s question, read by the turns after it. */
const rooms = new Map();

/**
 * Plays the recorded turn this message starts, when its room is a showcase replay. Returns whether it did, so the
 * mock’s own scripts answer everything else.
 * @param {any} message  @param {any} a  the mock’s kit  @param {any} session  @param {any} ctx  the turn’s context
 */
export async function replayShowcase(message, a, session, ctx) {
  if (message.kind === 'user') {
    const story = (await stories()).get(String(message.text ?? '').trim());
    if (!story) return false;
    rooms.set(session.threadId, { story, done: new Set() });
  }
  const room = rooms.get(session.threadId);
  if (!room) return false;
  const phase = phaseOf(message, session.handle);
  // A showcase room answers only its three recorded turns, once each: an app check, a lint or a second mention is
  // the replay’s own, and gets no reply.
  if (phase && !room.done.has(phase)) {
    room.done.add(phase);
    await PHASES[phase](room.story, a);
    ctx.usage?.({ costUsd: room.story.turns[phase].costUsd ?? null, tokens: room.story.turns[phase].tokens ?? null });
  }
  return true;
}

/** The recorded turn a message starts: the build, the review or the revision. @param {any} m @param {string} handle */
function phaseOf(m, handle) {
  if (handle === 'builder' && m.kind === 'user') return 'build';
  if (handle === 'critic' && m.kind === 'agent' && String(m.from).replace('@', '') === 'builder') return 'critique';
  if (handle === 'builder' && m.kind === 'event' && m.event?.from === 'critic') return 'revise';
  return null;
}

/** A turn’s recorded steps, shown as it works, each a moment long. @param {any} a @param {string[]} steps */
async function work(a, steps = []) {
  for (const label of steps) await a.tool(label, 900);
}

/**
 * Writes the app’s file in the room’s project folder, as @builder wrote it in its own, so the Work view shows the
 * file and its diff from v1 to v2. A room with no folder gets none.
 * @param {any} a @param {any} story @param {string} code
 */
async function writeApp(a, story, code) {
  if (a.folder) await a.write(join(a.folder, story.turns.build.app.file), code);
}

const PHASES = {
  async build(story, a) {
    const t = story.turns.build;
    await a.think(900);
    await a.say(t.say[0]);
    await work(a, t.steps);
    await writeApp(a, story, t.app.code);
    a.t.show_app({ id: t.app.id, title: t.app.title, intent: t.app.intent, code: t.app.code, permissions: [] });
    a.block({ ...t.review, version: 1 });
    for (const text of t.say.slice(1)) await a.say(`\n\n${text}`);
  },
  async critique(story, a) {
    const t = story.turns.critique;
    await a.think(900);
    await work(a, t.steps);
    a.t.review_block({ blockId: t.blockId, comments: t.comments, verdict: t.verdict });
    await a.say(t.say);
  },
  async revise(story, a) {
    const t = story.turns.revise;
    await a.think(900);
    await work(a, t.steps);
    await writeApp(a, story, t.app.code);
    a.t.update_app({ id: story.turns.build.app.id, code: t.app.code, summary: t.summary });
    a.update({ ...t.review, version: 1 });
    await a.say(t.say);
  },
};
