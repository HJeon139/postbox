// The demo’s showcase story (tools/demo.mjs --story showcase): five rooms that replay real sessions recorded with real
// agents, @builder on Claude Code and @critic on Codex, from tools/demo/showcase/ (its README says how each was made).
// In each, the person asks one hard question; @builder answers with an app and asks @critic to review it; @critic pins
// comments to the app’s parts; @builder ships v2. The mock plays the recorded words, apps and comments
// (server/adapters/mock-showcase.mjs), so it costs nothing.

import { readFileSync } from 'node:fs';
import { client } from './demo-client.mjs';

/** The recordings, in the order the story plays them. */
export const SHOWCASE = ['raft', 'elements', 'capacity', 'review', 'deps'];

/** A recording’s story.json. @param {string} key */
export const story = (key) => JSON.parse(readFileSync(new URL(`./demo/showcase/${key}/story.json`, import.meta.url), 'utf8'));

/** The room title a replay gets, which says it’s one. @param {any} s */
export const replayTitle = (s) => `${s.title} (replay)`;

/**
 * Makes @builder for the replays, once: a mock agent whose description says whose recorded turns it plays. @critic is
 * the demo’s own, and plays the recorded Codex critic’s turns in these rooms.
 * @param {ReturnType<typeof client>} c
 */
async function builder(c) {
  const s = await c.state();
  const have = Object.values(s.personas).find((p) => p.handle === 'builder');
  if (have) return have;
  const { agents } = story(SHOWCASE[0]);
  return c.call('/api/personas', {
    handle: 'builder',
    backend: 'mock',
    description: `Replays recorded sessions of a ${agents.builder.harness} agent on ${agents.builder.model}, reviewed by a ${agents.critic.harness} agent on ${agents.critic.model}.`,
    tools: [],
  });
}

/**
 * Opens one replay room and plays it to the end: its app at v2, with every one of @critic’s comments resolved.
 * @param {ReturnType<typeof client>} c @param {string} key
 * @returns {Promise<{ thread: any, story: any }>}
 */
export async function replay(c, key, { view = async (/** @type {string} */ _hash) => {} } = {}) {
  const s0 = await c.state();
  const b = await builder(c);
  const critic = Object.values(s0.personas).find((p) => p.handle === 'critic');
  const projectId = Object.values(s0.projects)[0].id;
  const st = story(key);
  const thread = await c.call('/api/threads', { projectId, title: replayTitle(st), personaIds: [b.id, critic.id] });
  await view(`#/t/${thread.id}`);
  await c.call(`/api/threads/${thread.id}/messages`, { text: st.ask });
  await c.until(
    (s) => {
      const review = c.items(s, s.threads[thread.id]).find((i) => i.block?.id === st.turns.critique.blockId);
      const resolved = review?.block.threads?.length && review.block.threads.every((t) => t.status === 'resolved');
      // The room reads idle as each turn ends, but the turn’s work, with its cost, is recorded after that, once the
      // ledger has read the files the turn changed (server/ledger.mjs endTurn): the end waits for both (#1309).
      const recorded = (s.work?.[thread.id] ?? []).every((e) => e.kind !== 'turn' || e.status !== 'running');
      return s.apps[st.turns.build.app.id]?.current === 2 && resolved && c.idle(s, s.threads[thread.id]) && recorded;
    },
    { label: `the ${key} replay’s v2`, timeout: 120000 },
  );
  return { thread, story: st };
}

/**
 * Plays every replay, each in its own room, then shot(name) once it’s done.
 * @param {{ origin: string, view?: (hash: string) => Promise<void>, shot?: (name: string) => Promise<void>, log?: (m: string) => void, speed?: number }} options
 */
export async function playShowcase({ origin, view = async () => {}, shot = async () => {}, log = console.log, speed = 0.35 }) {
  const c = client(origin);
  await c.call('/api/demo/speed', { speed });
  for (const key of SHOWCASE) {
    const { story: st } = await replay(c, key, { view });
    log(
      `${st.title}: @builder (${st.agents.builder.harness}, ${st.agents.builder.model}) and @critic (${st.agents.critic.harness}, ${st.agents.critic.model}), replayed.`,
    );
    await shot(`showcase-${key}`);
  }
}
