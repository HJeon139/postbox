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
//   userMcpServers,  names of MCP servers in the person’s own Claude Code config
//   userRulesMarker, a line from the person’s global CLAUDE.md, to spot it leaking into agents
// }

import { freshInstall } from '../../server/seed.mjs';

const itemsOf = (facts) => facts.threads.flatMap((t) => (facts.state.items[t] ?? []).map((it) => ({ ...it, threadId: t })));
const clip = (s, n = 240) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
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
    id: 'settings-leak',
    issue: 57,
    run: (f) => {
      const out = [];
      const styles = new Set(
        f.streams.flatMap(({ events }) =>
          events.filter((e) => e.subtype === 'init' && e.output_style && e.output_style !== 'default').map((e) => e.output_style),
        ),
      );
      if (styles.size) out.push({ title: 'Agents run with the person’s own output style', evidence: `init output_style: ${[...styles].join(', ')}.` });
      const reminder = f.transcripts.find(({ lines }) => lines.some((l) => /output style is active/i.test(l)));
      if (reminder)
        out.push({
          title: 'The person’s output style is injected into agent turns',
          evidence: `“output style is active” in @${reminder.handle}’s transcript.`,
        });
      if (f.userRulesMarker) {
        const leak = f.transcripts.find(({ lines }) => lines.some((l) => l.includes(f.userRulesMarker)));
        if (leak)
          out.push({ title: 'The person’s global CLAUDE.md reaches agents', evidence: `“${clip(f.userRulesMarker, 60)}” in @${leak.handle}’s transcript.` });
      }
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
    id: 'prose-instead-of-block',
    issue: 63,
    run: (f) => {
      const items = itemsOf(f);
      const turns = new Map();
      for (const it of items) if (it.turnId && (it.kind === 'agent' || it.kind === 'block')) turns.set(it.turnId, [...(turns.get(it.turnId) ?? []), it]);
      const out = [];
      for (const list of turns.values()) {
        if (list.some((it) => it.kind === 'block' && it.valid && ['choice', 'form', 'review', 'confirm'].includes(it.block.type))) continue;
        const text = list
          .filter((it) => it.kind === 'agent')
          .map((it) => it.text ?? '')
          .join('\n');
        const tail = text.split('\n').slice(-14).join('\n');
        const numbered = (tail.match(/^\s*(?:\d+[.)]|[-*])\s+\S/gm) ?? []).length;
        const questions = (tail.match(/\?/g) ?? []).length;
        const draft = text.split('\n').length > 40;
        if ((numbered >= 2 && questions >= 1) || questions >= 3 || draft)
          out.push({
            key: list[0].id,
            title: draft ? 'A long draft was sent as prose, not a review block' : 'Questions or options were asked in prose, not a form or choice block',
            evidence: `@${list[0].handle}: “${clip(tail, 200)}”`,
          });
      }
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
      const hits = f.threads.flatMap((t) =>
        Object.values(f.state.glossary?.[t] ?? {})
          .filter((g) => said.includes(String(g.term).toLowerCase()))
          .map((g) => g.term),
      );
      const lintReplies = items.filter((it) => it.lintReply).length;
      return hits.length && lintReplies
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
            /^\s*\|.*\|\s*\n\s*\|\s*:?-{3,}/m.test(it.block.content ?? ''),
        )
        .map((it) => ({
          key: it.id,
          title: 'A review block’s Markdown table shows as raw pipes',
          evidence: `“${it.block.title ?? 'review'}” has a table, and review blocks render line by line.`,
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
      return c.run(facts).map((x) => ({ check: c.id, issue: c.issue, key: x.key ?? c.id, title: x.title, evidence: x.evidence }));
    } catch (e) {
      return [{ check: c.id, issue: null, key: `${c.id}-error`, title: `The ${c.id} check failed`, evidence: e.message }];
    }
  });
}
