// Deterministic checks the UAT runs alongside the tester. Each looks for one kind of defect in what the run
// collected and names the GitHub issue it reproduces, so a run’s report says which known issues it caught.
// They’re pure functions over `facts` (gathered by tools/uat-run.mjs), so tests can feed them fixtures.
//
// facts = {
//   state,           Postbox’s /api/state at the time
//   threads,         ids of the conversations and topic threads under test
//   startPersonas,   the personas a fresh install had
//   streams,         [{ handle, events }]: each real turn’s raw stream (POSTBOX_CLAUDE_RECORD)
//   transcripts,     [{ handle, lines }]: each agent’s Claude Code transcript, as text lines
//   console,         the page’s console errors and exceptions
//   apps,            { [itemId]: { text, marks, tinyMarks, svgText, tinyText, fonts } } read from inside each app
//   probes,          { fullScreen: [{ key, before, after, viewport }], attachments: [{ key, images, attachments }] }
//   samples,         [{ busy: [handles thinking or calling tools], rows: number }]: the working row while agents worked
//   ui,              { headerText, reviewRawRows: { [itemId]: rows of a review block shown as raw “| … |” text } }
//   userMcpServers,  names of MCP servers in the person’s own Claude Code config
//   userRulesMarker, a line from the person’s global CLAUDE.md. Since #57, agents load the person’s setup on
//                    purpose, so it reaching them isn’t a finding; no check uses it now.
// }

import { deniedTools, isPublishingTool, PUBLISHING_TOOLS } from '../../server/adapters/setup.mjs';
import { freshInstall } from '../../server/seed.mjs';

const itemsOf = (facts) => facts.threads.flatMap((t) => (facts.state.items[t] ?? []).map((it) => ({ ...it, threadId: t })));
const clip = (s, n = 240) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// ── M1’s exit check: did a reply that called for a block use the right one? (#64) ──────────────────────
// What a turn calls for, from what the person asked and what the agent did, as the agent guide maps them:
// - a long job → progress: the turn showed a progress block, or did a job of several steps (10 or more tool calls,
//   or 2 minutes or more with 3 or more). Writing alone isn’t a job: a 2-minute turn that only writes a doc isn’t one.
// - a draft → review: the turn showed a review block, or the prose itself holds a draft (8 or more lines that don’t
//   just point at a block) when the person asked for something to approve, or the agent asks them to approve it. A
//   report, an explanation or a result isn’t a draft, however long.
// - options → choice: two or more list items with a question asking the person to pick (which, choose, prefer…)
//   that isn’t itself a list item.
// - questions → form or choice: three or more questions to the person.
// Practice questions (inside <details>, or under a Practice or Exercise heading) ask nothing of the person, and a
// reply to Postbox’s own lint message isn’t a reply to the person. A turn is right only if everything it called for
// has one of its expected blocks. Tuned on the first wave 2 runs (uat-runs/2026-10-22T19-07-51-*): a long job with a
// progress block and a table had read as a missed draft.
const BLOCK_USE = {
  options: { blocks: ['choice'], words: 'options' },
  questions: { blocks: ['form', 'choice'], words: 'questions' },
  draft: { blocks: ['review'], words: 'a draft' },
  long: { blocks: ['progress'], words: 'a long job' },
  decision: { blocks: ['confirm'], words: 'a decision' },
};
/** @type {Record<string, keyof typeof BLOCK_USE>} */
const SERVES = { choice: 'options', form: 'questions', review: 'draft', progress: 'long', confirm: 'decision' };
export const LONG_TURN_MS = 120_000;
export const LONG_TURN_TOOLS = 10;
const LONG_TURN_MIN_TOOLS = 3;
const DRAFT_LINES = 8;
// What the person asked for, or what the agent asks of them, when a reply is something to approve. The person
// saying “approved” is an answer, not a request.
const ASKS_FOR_DRAFT =
  /\b(draft|(for|to) (my |your )?(approv\w*|sign[- ]?off|review)|announcement|newsletter|e-?mail|letter|proposal|press release|release notes|blog post|write[- ]?up)\b/i;
const ASKS_TO_APPROVE =
  /\b(approv\w*|sign[- ]?off|ready to (send|post|publish|go out)|before (it goes out|you send|sending|posting|publishing)|look(s)? good to you)\b/i;
// A reply that points at a block rather than holding the draft itself.
const POINTS_AT_BLOCK = /\b(review block|in the review|up for (your )?review|ready for (you to|your) review|shows what changed|in the block|above)\b/i;
const PICK = /\b(which|pick|choose|prefer|rather|would you like|want me to|should (i|we)|go with)\b/i;
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*])\s+\S/;

/** The lines of a reply the person is asked to act on: no practice questions, no hidden answers. */
function askingLines(text) {
  const out = [];
  let practice = false;
  for (const line of String(text ?? '')
    .replace(/<details>[\s\S]*?<\/details>/gi, '')
    .split('\n')) {
    if (/^\s*(#+\s*|\*\*)?(practice|exercise|try (it|this)|quiz)\b/i.test(line)) practice = true;
    else if (/^\s*#+\s/.test(line)) practice = false;
    if (!practice) out.push(line);
  }
  return out;
}

/** What a turn’s reply calls for, by the rules above. */
export function callsFor({ text = '', types = [], person = '', ms = 0, tools = 0, lint = false }) {
  /** @type {Set<keyof typeof BLOCK_USE>} */
  const calls = new Set(types.flatMap((t) => (SERVES[t] ? [SERVES[t]] : [])));
  if (lint) return calls;
  const lines = askingLines(text);
  const tail = lines.slice(-14);
  const prose = lines.filter((l) => l.trim());
  const questions =
    tail
      .filter((l) => !LIST_ITEM.test(l))
      .join('\n')
      .match(/\?/g)?.length ?? 0;
  const items = tail.filter((l) => LIST_ITEM.test(l)).length;
  if (questions >= 3) calls.add('questions');
  else if (items >= 2 && tail.some((l) => !LIST_ITEM.test(l) && l.includes('?') && PICK.test(l))) calls.add('options');
  const approval = ASKS_FOR_DRAFT.test(person) || ASKS_TO_APPROVE.test(tail.join('\n'));
  if (approval && prose.length >= DRAFT_LINES && !POINTS_AT_BLOCK.test(text)) calls.add('draft');
  if (tools >= LONG_TURN_TOOLS || (ms >= LONG_TURN_MS && tools >= LONG_TURN_MIN_TOOLS)) calls.add('long');
  return calls;
}

function blockUseTally() {
  let right = 0;
  let wrong = 0;
  /** @type {Record<string, number>} */
  const used = {};
  /** @type {Record<string, number>} */
  const missed = {};
  const count = (o, k) => {
    o[k] = (o[k] ?? 0) + 1;
  };
  const list = (o) =>
    Object.entries(o)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
  return {
    /** @param {any[]} items  the turn’s items  @param {string[]} types  its valid blocks  @param {string} person  what the person last wrote */
    add(items, types, person) {
      const text = items
        .filter((it) => it.kind === 'agent')
        .map((it) => it.text ?? '')
        .join('\n');
      // How long it ran: from its first item to its last, or its tool steps’ own times, whichever is longer. A turn
      // that writes only at the end has one reply item, made at its first step, so the items alone can read as 0.
      const at = items.map((it) => it.at).filter((n) => typeof n === 'number');
      const steps = items.flatMap((it) => it.activity?.steps ?? []).filter((st) => st.kind !== 'thought');
      const ms = Math.max(
        at.length ? Math.max(...at) - Math.min(...at) : 0,
        steps.reduce((a, st) => a + (Number(st.ms) || 0), 0),
      );
      const calls = callsFor({ text, types, person, ms, tools: steps.length, lint: items.some((it) => it.lintReply) });
      if (!calls.size) return;
      const lacking = [...calls].filter((c) => !BLOCK_USE[c].blocks.some((b) => types.includes(b)));
      if (lacking.length) {
        wrong++;
        for (const c of lacking) count(missed, BLOCK_USE[c].words);
      } else {
        right++;
        for (const t of new Set(types)) if (SERVES[t]) count(used, t);
      }
    },
    /**
     * The run’s counts, as information rather than a defect: no issue, so “Known issues caught again” doesn’t list
     * it, and a verdict of its own, so the runner neither verifies nor files it. Its key carries the counts, so a
     * live run logs each new total, and the last is the run’s.
     */
    finding() {
      const called = right + wrong;
      if (!called) return null;
      return {
        key: `block-use:${right}-of-${called}`,
        issue: null,
        title: `M1 exit check: ${right} of ${called} replies that called for a block used the right one`,
        evidence: `${right} right${right ? ` (${list(used)})` : ''}; ${wrong} without the block they called for${wrong ? ` (${list(missed)})` : ''}.`,
        verdict: 'measurement',
        note: 'Not a defect: the block counts for M1’s exit check (#64).',
        counts: { right, wrong, byType: used, missed },
      };
    },
  };
}

export const CHECKS = [
  {
    id: 'fresh-install-agents',
    issue: 43,
    // What server/seed.mjs gives a fresh install, not the run's agents, which the scenario seeds through
    // agents.json. f.freshInstall replaces it in tests.
    run: (f) => {
      const { personas, projects } = f.freshInstall ?? freshInstall();
      const specific = personas.filter((p) => /corpus|book|gutenberg|index/i.test(`${p.description} ${p.instructions}`));
      if (!specific.length && personas.length <= 1 && !projects.length) return [];
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
    issue: null,
    run: (f) =>
      itemsOf(f)
        .filter((it) => it.kind === 'agent' && it.status === 'failed' && !/hit an error while running the turn\.?$/.test(it.error ?? ''))
        .map((it) => ({ key: it.id, title: 'A turn failed', evidence: `@${it.handle}: “${clip(it.error)}”.` })),
  },
  {
    id: 'refusal-without-card',
    issue: 65,
    run: (f) => {
      const cards = itemsOf(f).filter((it) => it.kind === 'denial').length;
      const refused = f.streams.flatMap(({ handle, events }) => {
        const listed = events.filter((e) => e.type === 'result').flatMap((e) => e.permission_denials ?? []);
        const declined = new Set(
          events
            .filter((e) => e.type === 'user')
            .flatMap((e) => e.message?.content ?? [])
            .filter((b) => b.type === 'tool_result' && /The person didn’t allow/.test(typeof b.content === 'string' ? b.content : JSON.stringify(b.content)))
            .map((b) => b.tool_use_id),
        );
        return listed.filter((d) => !declined.has(d.tool_use_id)).map((d) => ({ handle, d }));
      });
      return refused.length > cards
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
    issue: 54,
    run: (f) => {
      const posts = f.streams.flatMap(({ handle, events }) =>
        events
          .filter((e) => e.type === 'assistant')
          .flatMap((e) => e.message?.content ?? [])
          .filter((b) => b.type === 'tool_use' && b.name === 'Bash' && /\/mcp\?session=/.test(b.input?.command ?? ''))
          .map(() => handle),
      );
      return posts.length
        ? [{ title: 'An agent posted to /mcp directly from a script', evidence: `${posts.length} raw POSTs, by @${[...new Set(posts)].join(', @')}.` }]
        : [];
    },
  },
  {
    // Besides a finding per reply that should have been a block, it counts M1’s exit check (#64) over the run: the
    // replies that called for a block, and the ones that used the right one. See BLOCK_USE above.
    id: 'prose-instead-of-block',
    issue: 63,
    run: (f) => {
      const items = itemsOf(f);
      const turns = new Map();
      /** @type {Map<string, string>} */
      const person = new Map(); // a turn → what the person last wrote before it, in its conversation
      /** @type {Map<string, string>} */
      const said = new Map();
      for (const it of items) {
        if (it.kind === 'user') said.set(it.threadId, it.text ?? '');
        if (!it.turnId || (it.kind !== 'agent' && it.kind !== 'block')) continue;
        if (!turns.has(it.turnId)) person.set(it.turnId, said.get(it.threadId) ?? '');
        turns.set(it.turnId, [...(turns.get(it.turnId) ?? []), it]);
      }
      const out = [];
      const tally = blockUseTally();
      for (const [turnId, list] of turns) {
        const types = list.filter((it) => it.kind === 'block' && it.valid).map((it) => it.block.type);
        const text = list
          .filter((it) => it.kind === 'agent')
          .map((it) => it.text ?? '')
          .join('\n');
        const tail = text.split('\n').slice(-14).join('\n');
        const numbered = (tail.match(/^\s*(?:\d+[.)]|[-*])\s+\S/gm) ?? []).length;
        const questions = (tail.match(/\?/g) ?? []).length;
        const draft = text.split('\n').length > 40;
        tally.add(list, types, person.get(turnId) ?? '');
        if (types.some((t) => ['choice', 'form', 'review', 'confirm'].includes(t))) continue;
        if ((numbered >= 2 && questions >= 1) || questions >= 3 || draft)
          out.push({
            key: list[0].id,
            title: draft ? 'A long draft was sent as prose, not a review block' : 'Questions or options were asked in prose, not a form or choice block',
            evidence: `@${list[0].handle}: “${clip(tail, 200)}”`,
          });
      }
      const counts = tally.finding();
      if (counts) out.push(counts);
      return out;
    },
  },
  {
    id: 'lint-on-person-term',
    issue: 55,
    run: (f) => {
      const items = itemsOf(f);
      const said = items
        .filter((it) => it.kind === 'user')
        .map((it) => it.text ?? '')
        .join('\n')
        .toLowerCase();
      // A term counts only when its agent defined it during a lint turn: agents define terms on their own too.
      const inLintTurn = (t, g) => {
        const mine = items.filter((it) => it.threadId === t && it.kind === 'agent' && it.handle === g.by && it.at <= g.at);
        return mine.at(-1)?.lintReply === true;
      };
      const hits = f.threads.flatMap((t) =>
        Object.values(f.state.glossary?.[t] ?? {})
          .filter((g) => said.includes(String(g.term).toLowerCase()) && inLintTurn(t, g))
          .map((g) => g.term),
      );
      return hits.length
        ? [{ title: 'The term lint made an agent define a term the person introduced', evidence: `Defined after a lint turn: ${hits.join(', ')}.` }]
        : [];
    },
  },
  {
    id: 'topic-relints-parent-term',
    issue: 56,
    run: (f) => {
      const out = [];
      for (const t of f.threads) {
        const th = f.state.threads[t];
        if (th?.kind !== 'topic') continue;
        const parent = new Set(Object.keys(f.state.glossary?.[th.parentId] ?? {}));
        const again = Object.values(f.state.glossary?.[t] ?? {}).filter((g) => parent.has(g.key));
        if (again.length)
          out.push({ key: t, title: 'A topic thread re-defined terms its conversation already had', evidence: again.map((g) => g.term).join(', ') });
      }
      return out;
    },
  },
  {
    id: 'diagram-error-not-fed-back',
    issue: 46,
    run: (f) => {
      const errors = (f.console ?? []).filter((l) => /Diagram: /.test(l));
      return errors.length ? [{ title: 'A diagram failed to draw, and the agent wasn’t told', evidence: clip(errors[0], 200) }] : [];
    },
  },
  {
    id: 'app-shows-missing-data',
    issue: 47,
    run: (f) =>
      Object.entries(f.apps ?? {})
        .filter(([, a]) => /isn[’']t loaded|not loaded|restart postbox|failed to load|no data (?:yet|found)|couldn[’']t load/i.test(a?.text ?? ''))
        .map(([key, a]) => ({ key, title: 'An app that passed its check shows only a missing-data message', evidence: `“${clip(a.text, 160)}”` })),
  },
  {
    id: 'unreadable-app-marks',
    issue: 53,
    run: (f) =>
      Object.entries(f.apps ?? {})
        .filter(
          ([, a]) => a && ((a.tinyMarks >= 50 && a.tinyMarks / Math.max(1, a.marks) > 0.3) || (a.tinyText >= 5 && a.tinyText / Math.max(1, a.svgText) > 0.3)),
        )
        .map(([key, a]) => ({
          key,
          title: 'An app draws marks or text too small to read, and passed its check',
          evidence: `${a.tinyMarks} of ${a.marks} SVG marks under 4 px; ${a.tinyText} of ${a.svgText} SVG labels under 9 px.`,
        })),
  },
  {
    id: 'mixed-font-stacks',
    issue: 44,
    run: (f) =>
      Object.entries(f.apps ?? {})
        .filter(([, a]) => (a?.fonts ?? []).filter((x) => !/mono/i.test(x)).length > 1)
        .map(([key, a]) => ({
          key,
          title: 'An app mixes font stacks, so its text renders in different families where the stacks resolve differently (Firefox)',
          evidence: a.fonts.filter((x) => !/mono/i.test(x)).join(' | '),
        })),
  },
  {
    id: 'status-colors-for-categories',
    issue: 52,
    run: (f) =>
      Object.values(f.state.apps ?? {})
        .filter((app) => f.threads.includes(app.threadId))
        .filter((app) => {
          const code = app.versions?.[app.current - 1]?.code ?? '';
          return /var\(--(?:good|alert|warn)\)/.test(code) && !/--s[1-8]\b/.test(code);
        })
        .map((app) => ({
          key: app.id,
          title: 'An app colors categories with status colors',
          evidence: `“${app.title}” uses --good/--alert and none of --s1…--s8.`,
        })),
  },
  {
    id: 'updated-app-far-up',
    issue: 49,
    run: (f) =>
      Object.values(f.state.apps ?? {})
        .filter((app) => f.threads.includes(app.threadId) && app.versions?.length > 1)
        .filter((app) => {
          const list = f.state.items[app.threadId] ?? [];
          const at = list.findIndex((it) => it.id === app.itemId);
          return at >= 0 && list.length - at > 6;
        })
        .map((app) => ({
          key: app.id,
          title: 'An updated app stays where it was first shown, far above the conversation',
          evidence: `“${app.title}” is v${app.versions.length}, ${(f.state.items[app.threadId] ?? []).length - (f.state.items[app.threadId] ?? []).findIndex((it) => it.id === app.itemId) - 1} messages up.`,
        })),
  },
  {
    id: 'version-menu-overflow',
    issue: 36,
    run: (f) =>
      Object.values(f.state.apps ?? {})
        .filter((app) => f.threads.includes(app.threadId) && app.versions?.length >= 15)
        .map((app) => ({
          key: app.id,
          title: 'An app has enough versions to overflow its version menu',
          evidence: `“${app.title}” has ${app.versions.length} versions.`,
        })),
  },
  {
    id: 'check-starved',
    issue: 37,
    run: (f) =>
      Object.values(f.state.apps ?? {})
        .filter((app) => f.threads.includes(app.threadId) && (app.check?.problems ?? []).some((p) => p.code === 'no-answer'))
        .map((app) => ({
          key: app.id,
          title: 'An app’s check timed out and is stored as “shown with problems”',
          evidence: `“${app.title}”: ${clip(app.check.problems[0].message)}`,
        })),
  },
  {
    id: 'full-screen-noop',
    issue: 45,
    run: (f) =>
      (f.probes?.fullScreen ?? [])
        // Full screen fills the window; a frame that only grows taller in the column isn’t that.
        .filter((p) => p.before && p.after && (p.after.w < p.viewport.w * 0.9 || p.after.h < p.viewport.h * 0.8))
        .map((p) => ({
          key: p.key,
          title: 'An app’s Expand button doesn’t show it full screen',
          evidence: `The frame went from ${p.before.w}×${p.before.h} to ${p.after.w}×${p.after.h} in a ${p.viewport.w}×${p.viewport.h} window.`,
        })),
  },
  {
    id: 'image-not-shown',
    issue: 48,
    run: (f) =>
      (f.probes?.attachments ?? [])
        .filter((a) => a.attachments > 0 && a.images === 0)
        .map((a) => ({
          key: a.key,
          title: 'An attached image shows as a file chip, not the image',
          evidence: `${a.attachments} attachment, 0 images rendered.`,
        })),
  },
  {
    id: 'review-table-raw',
    issue: 62,
    run: (f) =>
      itemsOf(f)
        .filter(
          (it) =>
            it.kind === 'block' &&
            it.valid &&
            it.block.type === 'review' &&
            it.block.format === 'markdown' &&
            /^\s*\|.*\|\s*\n\s*\|\s*:?-{3,}/m.test(it.block.content ?? '') &&
            // What’s on screen decides: since #62, a table renders as a table. Without a reading, assume it did.
            (f.ui?.reviewRawRows?.[it.id] ?? 0) > 0,
        )
        .map((it) => ({
          key: it.id,
          title: 'A review block’s Markdown table shows as raw pipes',
          evidence: `“${it.block.title ?? 'review'}” has a table, and ${f.ui.reviewRawRows[it.id]} of its rows show as raw pipes on screen.`,
        })),
  },
  {
    id: 'stale-progress',
    issue: 58,
    run: (f) =>
      itemsOf(f)
        .filter((it) => it.kind === 'block' && it.valid && it.block.type === 'progress' && (it.block.steps ?? []).some((s) => s.state === 'running'))
        .filter((it) => {
          const se = f.state.sessions[it.sessionId];
          return se && !['think', 'gen', 'tool'].includes(se.state);
        })
        .map((it) => ({
          key: it.id,
          title: 'A progress block still says “running” after its agent stopped',
          evidence: `“${it.block.title ?? 'progress'}”: ${(it.block.steps ?? [])
            .filter((s) => s.state === 'running')
            .map((s) => s.label)
            .join(', ')}.`,
        })),
  },
  {
    id: 'silent-while-working',
    issue: 68,
    run: (f) => {
      const silent = (f.samples ?? []).filter((s) => s.busy.length && s.rows === 0).length;
      const busy = (f.samples ?? []).filter((s) => s.busy.length).length;
      return busy >= 4 && silent / busy > 0.8
        ? [
            {
              title: 'While agents think or call tools, nothing on screen says what they’re doing',
              evidence: `In ${silent} of ${busy} samples taken while an agent worked, there was no working row or glimpse.`,
            },
          ]
        : [];
    },
  },
  {
    id: 'model-not-shown',
    issue: 60,
    run: (f) =>
      f.ui?.headerText && !/opus|sonnet|haiku|fable/i.test(f.ui.headerText)
        ? [{ title: 'The UI doesn’t show which model an agent runs', evidence: `Top bar: “${clip(f.ui.headerText, 120)}”.` }]
        : [],
  },
  {
    id: 'page-errors',
    issue: null,
    run: (f) => {
      const errs = (f.console ?? []).filter((l) => !/Diagram: |Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(l));
      return errs.length
        ? [
            {
              title: 'The page logged errors',
              evidence: errs
                .slice(0, 3)
                .map((l) => clip(l, 160))
                .join(' | '),
            },
          ]
        : [];
    },
  },
];

/** Runs every check; each finding carries its check id and issue number. */
export function runChecks(facts) {
  return CHECKS.flatMap((c) => {
    try {
      // A finding can set its own issue (null for information), and carry a verdict, a note and counts for the
      // report: the block counts for M1’s exit check do.
      return c.run(facts).map((x) => ({
        check: c.id,
        issue: x.issue === undefined ? c.issue : x.issue,
        key: x.key ?? c.id,
        title: x.title,
        evidence: x.evidence,
        ...(x.verdict ? { verdict: x.verdict, note: x.note } : {}),
        ...(x.counts ? { counts: x.counts } : {}),
      }));
    } catch (e) {
      return [{ check: c.id, issue: null, key: `${c.id}-error`, title: `The ${c.id} check failed`, evidence: e.message }];
    }
  });
}
