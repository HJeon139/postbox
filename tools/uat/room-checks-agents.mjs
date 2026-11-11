// What agents were set up with, and what they were refused: a fresh install’s agents, the tools and settings that reach
// a turn, failed turns, and refusals without a card. Part of tools/uat/room-checks.mjs’s CHECKS, kept apart for size.

import { contentBlocks } from '../../server/adapters/claude-content.mjs';
import { deniedTools, isPublishingTool, PUBLISHING_TOOLS } from '../../server/adapters/setup.mjs';
import { freshInstall } from '../../server/seed.mjs';
import { clip } from '../../shared/text.mjs';
import { keptStreams } from './room-checks-work.mjs';
import { itemsOf } from './room-items.mjs';

/** How many refusal cards each agent has in the conversations: one pass over their items. */
function countDenialCardsByHandle(items) {
  const counts = new Map();
  for (const it of items) {
    if (it.kind !== 'denial') continue;
    counts.set(it.handle, (counts.get(it.handle) ?? 0) + 1);
  }
  return counts;
}

/** Whether a tool result is the person declining a call in Postbox, which a card already answered. */
const isDeclinedResult = (b) =>
  b.type === 'tool_result' && /The person didn’t allow/.test(typeof b.content === 'string' ? b.content : JSON.stringify(b.content));

/** Each agent’s refused calls (a result’s `permission_denials`) the person didn’t decline: one pass over the streams. */
function uncardedRefusalsByHandle(streams) {
  const byHandle = new Map();
  for (const { handle, events } of streams) {
    const declined = new Set(
      events
        .filter((e) => e.type === 'user')
        .flatMap((e) => contentBlocks(e.message?.content))
        .filter(isDeclinedResult)
        .map((b) => b.tool_use_id),
    );
    const listed = events.filter((e) => e.type === 'result').flatMap((e) => e.permission_denials ?? []);
    const refusals = listed.filter((d) => !declined.has(d.tool_use_id));
    if (!refusals.length) continue;
    if (!byHandle.has(handle)) byHandle.set(handle, []);
    byHandle.get(handle).push(...refusals);
  }
  return byHandle;
}

export const AGENT_CHECKS = [
  {
    id: 'fresh-install-agents',
    inputs: ['freshInstall'],
    issue: 43,
    // What server/seed.mjs gives a fresh install, not the run's agents, which the scenario seeds through
    // agents.json. f.freshInstall replaces it in tests. Generic roles (a researcher, a developer, a critic) are
    // fine; an agent for one use case, such as the demo's book corpus, or a sample project isn't.
    run: (f) => {
      const { personas, projects } = f.freshInstall ?? freshInstall();
      const specific = personas.filter((p) => /corpus|book|gutenberg|index/i.test(`${p.description} ${p.instructions}`));
      if (!specific.length && !projects.length) return [];
      const seeded = [`${personas.length === 1 ? 'one agent' : `${personas.length} agents`} (${personas.map((p) => `@${p.handle}`).join(', ')})`];
      if (projects.length) seeded.push(`${projects.length === 1 ? 'a sample project' : `${projects.length} sample projects`}`);
      return [
        {
          title: 'A fresh install comes with use-case agents',
          evidence: `Seeded: ${seeded.join(' and ')}.${specific.length ? ` Use-case: ${specific.map((p) => `@${p.handle}`).join(', ')}.` : ''}`,
        },
      ];
    },
  },
  {
    // A real agent’s init holding a tool its persona doesn’t allow: an unticked tool, or one that acts outside
    // Postbox’s record (SendMessage, CronCreate…), which wave 1’s UAT saw on every agent. The publishing tools are
    // settings-leak’s. A stream whose persona isn’t in the run’s state is skipped: its ticks aren’t known.
    id: 'tool-not-allowed',
    inputs: ['state', 'streams'],
    issue: 5,
    run: (f) => {
      const personas = Object.values(f.state.personas ?? {});
      const hits = f.streams.flatMap(({ handle, events }) => {
        const persona = personas.find((p) => p.handle === handle);
        if (!persona) return [];
        const denied = new Set(deniedTools(persona).filter((r) => !PUBLISHING_TOOLS.includes(r)));
        const tools = events.filter((e) => e.subtype === 'init').flatMap((e) => (Array.isArray(e.tools) ? e.tools : []));
        return [...new Set(tools.filter((x) => denied.has(x)))].map((tool) => ({ handle, tool }));
      });
      return hits.length
        ? [
            {
              title: 'Agents carry tools their persona doesn’t allow',
              evidence: `${[...new Set(hits.map(({ handle }) => `@${handle}`))].join(', ')} had ${[...new Set(hits.map(({ tool }) => tool))].slice(0, 8).join(', ')}.`,
            },
          ]
        : [];
    },
  },
  {
    id: 'hidden-turn-error',
    inputs: ['state', 'threads'],
    issue: 61,
    run: (f) =>
      itemsOf(f)
        .filter((it) => it.kind === 'agent' && it.status === 'failed' && /hit an error while running the turn\.?$/.test(it.error ?? ''))
        .map((it) => ({
          key: it.id,
          title: 'A turn failed with no reason given',
          evidence: `@${it.handle} in “${f.state.threads[it.threadId]?.title}”: “${clip(it.error)}”${f.state.threads[it.threadId]?.kind === 'topic' ? ' (a topic thread)' : ''}.`,
        })),
  },
  {
    id: 'failed-turn',
    inputs: ['state', 'threads'],
    issue: null,
    run: (f) =>
      itemsOf(f)
        .filter((it) => it.kind === 'agent' && it.status === 'failed' && !/hit an error while running the turn\.?$/.test(it.error ?? ''))
        .map((it) => ({ key: it.id, title: 'A turn failed', evidence: `@${it.handle}: “${clip(it.error)}”.` })),
  },
  {
    id: 'refusal-without-card',
    inputs: ['state', 'threads', 'streams'],
    issue: 65,
    run: (f) => {
      // Per agent: a removed agent’s cards stay in its conversation while its streams are left out (#729), and one
      // agent’s cards never stand for another’s refusals.
      const cardsByHandle = countDenialCardsByHandle(itemsOf(f));
      const refusalsByHandle = uncardedRefusalsByHandle(keptStreams(f));
      const cardsOf = (handle) => cardsByHandle.get(handle) ?? 0;
      const isShort = ([handle, refusals]) => refusals.length > cardsOf(handle);
      const short = [...refusalsByHandle].filter(isShort).map(([handle]) => handle);
      const refused = short.flatMap((handle) => refusalsByHandle.get(handle).map((d) => ({ handle, d })));
      const cards = short.reduce((n, handle) => n + cardsOf(handle), 0);
      return short.length
        ? [
            {
              title: 'Claude Code refused calls, and Postbox showed no card',
              evidence: `${refused.length} refused, ${cards} cards. ${refused
                .slice(0, 3)
                .map(({ handle, d }) => `@${handle}: ${d.tool_name} ${clip(d.tool_input?.command ?? d.tool_input?.url ?? '', 80)}`)
                .join('; ')}.`,
            },
          ]
        : [];
    },
  },
  {
    // Agents load the person’s Claude Code setup by default (#57), so their global CLAUDE.md reaching agents is
    // intended. What must not leak: their output style, and tools that publish outside Postbox for a persona that
    // doesn’t allow them.
    id: 'settings-leak',
    inputs: ['state', 'streams', 'transcripts'],
    issue: 57,
    run: (f) => {
      const out = [];
      const inits = f.streams.flatMap(({ handle, events }) => events.filter((e) => e.subtype === 'init').map((e) => ({ handle, e })));
      const styles = new Set(inits.filter(({ e }) => e.output_style && String(e.output_style).toLowerCase() !== 'default').map(({ e }) => e.output_style));
      if (styles.size) out.push({ title: 'Agents run with the person’s own output style', evidence: `init output_style: ${[...styles].join(', ')}.` });
      const reminder = f.transcripts.find(({ lines }) => lines.some((l) => /output style is active/i.test(l)));
      if (reminder)
        out.push({
          title: 'The person’s output style is injected into agent turns',
          evidence: `“output style is active” in @${reminder.handle}’s transcript.`,
        });
      const allows = (handle) => Object.values(f.state.personas ?? {}).some((p) => p.handle === handle && p.canPublish === true);
      const publishing = inits.flatMap(({ handle, e }) => (allows(handle) ? [] : (e.tools ?? []).filter(isPublishingTool).map((t) => ({ handle, t }))));
      if (publishing.length)
        out.push({
          title: 'Agents can publish outside Postbox without being allowed to',
          evidence: `${[...new Set(publishing.map(({ handle }) => `@${handle}`))].join(', ')} had ${[...new Set(publishing.map(({ t }) => t))]
            .slice(0, 6)
            .join(', ')}.`,
        });
      return out.length ? [{ title: out.map((o) => o.title).join('; '), evidence: out.map((o) => o.evidence).join(' ') }] : [];
    },
  },
  {
    id: 'mcp-servers-missing',
    inputs: ['userMcpServers', 'streams'],
    issue: 59,
    run: (f) => {
      if (!f.userMcpServers?.length) return [];
      const seen = new Set(
        f.streams.flatMap(({ events }) => events.filter((e) => e.subtype === 'init').flatMap((e) => (e.mcp_servers ?? []).map((s) => s.name))),
      );
      const missing = f.userMcpServers.filter((n) => !seen.has(n));
      return seen.size && missing.length
        ? [
            {
              title: 'Agents can’t use the person’s own MCP servers',
              evidence: `Configured: ${f.userMcpServers.join(', ')}. Agents had: ${[...seen].join(', ')}.`,
            },
          ]
        : [];
    },
  },
  {
    id: 'mcp-side-channel',
    inputs: ['streams'],
    issue: 54,
    run: (f) => {
      const posts = f.streams.flatMap(({ handle, events }) =>
        events
          .filter((e) => e.type === 'assistant')
          .flatMap((e) => contentBlocks(e.message?.content))
          .filter((b) => b.type === 'tool_use' && b.name === 'Bash' && /\/mcp\?session=/.test(b.input?.command ?? ''))
          .map(() => handle),
      );
      return posts.length
        ? [{ title: 'An agent posted to /mcp directly from a script', evidence: `${posts.length} raw POSTs, by @${[...new Set(posts)].join(', @')}.` }]
        : [];
    },
  },
];
