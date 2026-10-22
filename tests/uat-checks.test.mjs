import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { runChecks } from '../tools/uat/checks.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';

const stream = (name) =>
  readFileSync(new URL(`fixtures/claude-code/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const base = (over = {}) => ({
  state: {
    threads: { t1: { id: 't1', title: 'T', kind: 'thread', members: ['s1'] } },
    items: { t1: [] },
    sessions: { s1: { id: 's1', handle: 'researcher', state: 'idle' } },
    apps: {},
    glossary: {},
  },
  threads: ['t1'],
  startPersonas: [],
  streams: [],
  transcripts: [],
  console: [],
  apps: {},
  probes: { fullScreen: [], attachments: [] },
  samples: [],
  ui: {},
  userMcpServers: [],
  userRulesMarker: null,
  ...over,
});
const issuesOf = (facts) => runChecks(facts).map((f) => f.issue);

test('fresh-install-agents reads what a fresh install seeds, not the run’s agents', () => {
  // The run seeds its scenario's agents through agents.json; those aren't a fresh install's.
  assert.ok(!issuesOf(base({ startPersonas: [{ handle: 'librarian', description: 'Explores your books.' }] })).includes(43));
  const found = runChecks(
    base({
      freshInstall: {
        personas: [
          { handle: 'librarian', description: 'Explores your books.', instructions: '' },
          { handle: 'assistant', description: 'General.', instructions: '' },
        ],
        projects: [{ name: 'Book corpus' }],
      },
    }),
  ).find((f) => f.issue === 43);
  assert.equal(found?.evidence, 'Seeded: 2 agents (@librarian, @assistant) and a sample project. Use-case: @librarian.');
});

test('a clean run has no findings', () => {
  assert.deepEqual(runChecks(base()), []);
});

test('refusals in a recorded stream with no cards in the conversation reproduce #65', () => {
  const found = runChecks(base({ streams: [{ handle: 'researcher', events: stream('denials') }] }));
  const f = found.find((x) => x.issue === 65);
  assert.ok(f, JSON.stringify(found));
  assert.match(f.evidence, /4 refused, 0 cards/);
  // A call the person declined on a permission card isn’t a refusal.
  assert.ok(!issuesOf(base({ streams: [{ handle: 'researcher', events: stream('permission-deny') }] })).includes(65));
});

test('a failed turn with no reason is #61; one with a reason is a new finding', () => {
  const items = (error) => ({ t1: [{ id: 'i1', kind: 'agent', handle: 'researcher', status: 'failed', error }] });
  const hidden = base();
  hidden.state.items = items('Claude Code hit an error while running the turn.');
  assert.deepEqual(issuesOf(hidden), [61]);
  const said = base();
  said.state.items = items('Claude Code hit an error while running the turn: No message found with message.uuid of: x');
  assert.deepEqual(issuesOf(said), [null]);
});

test('options asked in prose, without a block in the turn, are #63', () => {
  const f = base();
  f.state.items.t1 = [
    { id: 'a', kind: 'agent', turnId: 'u1', handle: 'researcher', text: 'Which should we do first?\n\n1. Load the corpus\n2. Load the claims\n3. Both' },
  ];
  // The other finding is the run’s block counts (below), information with no issue.
  assert.deepEqual(issuesOf(f), [63, null]);
  f.state.items.t1.push({ id: 'b', kind: 'block', turnId: 'u1', valid: true, block: { type: 'choice' } });
  assert.deepEqual(issuesOf(f), [null]);
});

describe('M1’s exit check: the replies that called for a block, and the ones that used the right one (#64)', () => {
  const asked = (text) => ({ id: `u-${text.length}`, kind: 'user', text, at: 0 });
  const reply = (turn, text, extra = {}) => ({ id: `a-${turn}`, kind: 'agent', turnId: turn, handle: 'researcher', text, at: 0, ...extra });
  const block = (turn, type, at = 0) => ({ id: `b-${turn}-${type}`, kind: 'block', turnId: turn, handle: 'researcher', valid: true, block: { type }, at });
  const steps = (n, ms = 1000) => ({ activity: { steps: Array.from({ length: n }, (_, i) => ({ id: `s${i}`, label: `Read ${i}`, state: 'done', ms })) } });
  const run = (items) => {
    const f = base();
    f.state.items.t1 = items;
    const found = runChecks(f).filter((x) => x.check === 'prose-instead-of-block');
    return { prose: found.filter((x) => x.issue === 63).length, counts: found.find((x) => x.key.startsWith('block-use:')) };
  };
  const options = 'Which should we do first?\n\n1. Load the corpus\n2. Load the claims\n3. Both';
  const questions = 'Before I start:\nWho reads it?\nHow long should it be?\nWhen is it due?';
  const draft = Array.from({ length: 45 }, (_, i) => `Line ${i + 1} of the announcement.`).join('\n');

  test('options in a choice block count as right; options in prose count as should-have, with their #63 finding', () => {
    let r = run([reply('u1', 'Here are the ways forward.'), block('u1', 'choice')]);
    assert.equal(r.prose, 0);
    assert.equal(r.counts.title, 'M1 exit check: 1 of 1 replies that called for a block used the right one');
    assert.deepEqual(r.counts.counts, { right: 1, wrong: 0, byType: { choice: 1 }, missed: {} });
    r = run([reply('u1', options)]);
    assert.equal(r.prose, 1);
    assert.equal(r.counts.evidence, '0 right; 1 without the block they called for (options 1).');
  });

  test('a draft in a review block counts as right; in prose it doesn’t', () => {
    const r = run([
      asked('Can you draft an announcement for the company email?'),
      reply('u1', 'The draft is ready for your review.'),
      block('u1', 'review'),
      asked('Write another version for the newsletter.'),
      reply('u2', draft),
    ]);
    assert.equal(r.counts.title, 'M1 exit check: 1 of 2 replies that called for a block used the right one');
    assert.equal(r.counts.evidence, '1 right (review 1); 1 without the block they called for (a draft 1).');
    assert.equal(r.counts.key, 'block-use:1-of-2');
  });

  test('only the right block counts: a choice doesn’t cover a draft, a form doesn’t cover options, and questions take a form or a choice', () => {
    assert.equal(run([asked('Draft the launch email, please.'), reply('u1', draft), block('u1', 'choice')]).counts.counts.wrong, 1);
    assert.equal(run([reply('u1', options), block('u1', 'form')]).counts.counts.wrong, 1);
    assert.equal(run([reply('u1', questions), block('u1', 'form')]).counts.counts.right, 1);
    assert.equal(run([reply('u1', questions), block('u1', 'choice')]).counts.counts.right, 1);
    assert.equal(run([reply('u1', questions), block('u1', 'review')]).counts.counts.wrong, 1);
  });

  test('a long job calls for a progress block: 10 or more tool calls, or 2 minutes or more with 3 or more', () => {
    // The review’s case: minutes of work, then a reply in prose, with no progress block. It was “0 of 0” before.
    let r = run([reply('u1', 'Here is the survey of twelve papers.', steps(6, 30_000))]);
    assert.equal(r.counts.evidence, '0 right; 1 without the block they called for (a long job 1).');
    // The same by the items’ own times: a block shown 3 minutes after the reply began, with a few tool calls.
    assert.equal(run([reply('u1', 'Started.', steps(3, 100)), block('u1', 'card', 180_000)]).counts.counts.wrong, 1);
    // Writing alone isn’t a job: minutes spent writing, with no tool calls, calls for nothing.
    assert.equal(run([reply('u1', 'Started.'), block('u1', 'card', 180_000)]).counts, undefined);
    // Many quick steps.
    assert.equal(run([reply('u1', 'Done.', steps(12, 100))]).counts.counts.wrong, 1);
    // With a progress block, it’s right.
    r = run([reply('u1', 'Done.', steps(12, 30_000)), block('u1', 'progress')]);
    assert.deepEqual(r.counts.counts, { right: 1, wrong: 0, byType: { progress: 1 }, missed: {} });
    // A short turn with a few steps calls for nothing; nor does a reply to a lint message.
    assert.equal(run([reply('u1', 'Done.', steps(3, 2000))]).counts, undefined);
    assert.equal(run([reply('u1', 'Fixed.', { ...steps(12, 30_000), lintReply: true })]).counts, undefined);
    // Thoughts aren’t tool calls.
    const thoughts = {
      activity: { steps: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, label: 'Thinking', state: 'done', kind: 'thought', ms: 10 })) },
    };
    assert.equal(run([reply('u1', 'Done.', thoughts)]).counts, undefined);
  });

  test('a report, an explanation or a result isn’t a draft, however long; a draft is something to approve', () => {
    const report = Array.from({ length: 60 }, (_, i) => `${i + 1}. Paper ${i + 1}: method, benchmark and finding.`).join('\n');
    assert.equal(run([asked('Can you survey twelve papers on agent memory?'), reply('u1', report)]).counts, undefined);
    // The person saying “approved” is an answer, not a request for something to approve.
    assert.equal(run([asked('Spec looks good, approved. What do I build first?'), reply('u1', report)]).counts, undefined);
    // The agent asking for approval of prose it wrote makes it a draft.
    const asking = `${draft}\n\nDoes this look good to you before it goes out?`;
    assert.equal(run([asked('Tell me about the launch.'), reply('u1', asking)]).counts.evidence, '0 right; 1 without the block they called for (a draft 1).');
    // A reply that points at the review block holds no draft of its own.
    assert.equal(run([asked('Draft the email.'), reply('u1', `${draft}\nThe review block shows what changed.`)]).counts, undefined);
  });

  test('options are alternatives the person is asked to pick from, not practice questions', () => {
    const practice = '## Practice\n1. Which query is slower?\n2. Which index helps?\n\n<details><summary>Answer</summary>Query 2.</details>';
    assert.equal(run([reply('u1', practice)]).counts, undefined);
    assert.equal(run([reply('u1', 'Here are three ways:\n1. Keyword\n2. Embeddings\n3. Both\n\nWhich would you like?')]).counts.counts.wrong, 1);
  });

  test('real turns from wave 2’s UAT runs read the way a person judges them', () => {
    const turns = JSON.parse(readFileSync(new URL('fixtures/uat/m1-turns.json', import.meta.url), 'utf8'));
    const of = (run) => turns.find((x) => x.run === run).items;
    // papersurvey: a progress block over a long job, then a table. It read as a missed draft before.
    assert.deepEqual(run(of('2026-10-22T19-07-51-papersurvey')).counts.counts, { right: 1, wrong: 0, byType: { progress: 1 }, missed: {} });
    // wikisearch: “approved”, then a plan in prose, calls for nothing.
    assert.equal(run(of('2026-10-22T18-59-03-wikisearch')).counts, undefined);
    // wikisearch: a 69-line explanation calls for nothing, and two minutes spent writing a doc into a review block is
    // a draft shown right, not a long job missed.
    assert.deepEqual(run(of('2026-10-22T19-07-51-wikisearch')).counts.counts, { right: 1, wrong: 0, byType: { review: 1 }, missed: {} });
  });

  test('the counts are information, not a defect: no issue, and a verdict the runner neither verifies nor files', () => {
    const { counts } = run([reply('u1', options)]);
    assert.equal(counts.issue, null);
    assert.equal(counts.verdict, 'measurement');
    assert.equal(counts.note, 'Not a defect: the block counts for M1’s exit check (#64).');
  });
});

test('the person’s output style and missing MCP servers are #57 and #59', () => {
  const init = { type: 'system', subtype: 'init', output_style: 'Concise', mcp_servers: [{ name: 'postbox' }] };
  const f = base({ streams: [{ handle: 'researcher', events: [init] }], userMcpServers: ['search'] });
  assert.deepEqual(issuesOf(f).sort(), [57, 59]);
  const reminder = base({ transcripts: [{ handle: 'researcher', lines: ['Concise output style is active. Be concise…'] }] });
  assert.deepEqual(issuesOf(reminder), [57]);
  // A plain init can spell the default style either way.
  for (const output_style of ['default', 'Default'])
    assert.deepEqual(runChecks(base({ streams: [{ handle: 'researcher', events: [{ type: 'system', subtype: 'init', output_style }] }] })), [], output_style);
});

test('#57: the person’s global CLAUDE.md reaching agents is intended, so it’s no finding', () => {
  const f = base({
    transcripts: [{ handle: 'researcher', lines: ['… Draw every diagram as Mermaid …'] }],
    userRulesMarker: 'Draw every diagram as Mermaid',
  });
  assert.deepEqual(runChecks(f), []);
});

test('#57: publishing tools in a real init are a finding, unless the persona may publish', () => {
  // Real inits (tests/claude-code.test.mjs says how they were recorded): the person’s own setup, then Postbox’s flags.
  const [own, , fixed] = stream('host-setup-init');
  const leak = runChecks(base({ streams: [{ handle: 'researcher', events: [own] }] }));
  assert.deepEqual(
    leak.map((x) => x.issue),
    [57],
  );
  assert.match(leak[0].evidence, /@researcher had Artifact, ArtifactComments, ArtifactData, PushNotification, mcp__claude_ai_Claude_Docs__batch/);
  assert.deepEqual(runChecks(base({ streams: [{ handle: 'researcher', events: [fixed] }] })), []);
  const allowed = base({ streams: [{ handle: 'researcher', events: [own] }] });
  allowed.state.personas = { pe1: { id: 'pe1', handle: 'researcher', canPublish: true, tools: ['shell', 'web.fetch', 'agents.outside'] } };
  assert.deepEqual(runChecks(allowed), []);
});

test('#5: a tool the persona doesn’t allow in a real init is a finding; the init with its rules passed isn’t', () => {
  // Real inits: the person’s own setup, then a turn with every rule for a persona that ticks nothing passed.
  const [own, denied] = stream('host-mcp-init');
  const run = (events, persona) => {
    const f = base({ streams: [{ handle: 'researcher', events }] });
    if (persona) f.state.personas = { pe1: { id: 'pe1', handle: 'researcher', canPublish: true, ...persona } };
    return runChecks(f);
  };
  const leak = run([own], { tools: [] });
  assert.deepEqual(
    leak.map((x) => x.issue),
    [5],
  );
  assert.match(leak[0].evidence, /@researcher had .*CronCreate/);
  assert.match(leak[0].evidence, /Bash/);
  assert.deepEqual(run([denied], { tools: [] }), [], 'Claude Code removed every rule');
  // Ticked tools are allowed, and a persona the run doesn’t know is skipped.
  assert.deepEqual(run([own], { tools: ['shell', 'web.fetch', 'agents.outside'] }), []);
  assert.deepEqual(
    run([own], null).filter((x) => x.issue === 5),
    [],
  );
});

test('UI probes: an Expand that changes nothing is #45; an image shown as a chip is #48', () => {
  const f = base({
    probes: {
      fullScreen: [{ key: 'i1', before: { w: 728, h: 400 }, after: { w: 728, h: 400 }, viewport: { w: 1440, h: 1000 } }],
      attachments: [{ key: 'i2', images: 0, attachments: 1 }],
    },
  });
  assert.deepEqual(issuesOf(f).sort(), [45, 48]);
});

test('an agent working with nothing on screen to say so is #68', () => {
  const quiet = base({ samples: Array.from({ length: 6 }, () => ({ busy: ['researcher'], rows: 0 })) });
  assert.deepEqual(issuesOf(quiet), [68]);
  const shown = base({ samples: Array.from({ length: 6 }, () => ({ busy: ['researcher'], rows: 1 })) });
  assert.deepEqual(issuesOf(shown), []);
});

test('apps: a missing-data message is #47, tiny marks are #53, status colors for categories are #52', () => {
  const f = base({
    apps: { i1: { text: 'SciFact isn’t loaded in this Postbox yet. Restart Postbox.', marks: 1300, tinyMarks: 900, svgText: 0, tinyText: 0 } },
  });
  f.state.apps = {
    ap: { id: 'ap', threadId: 't1', title: 'Explorer', current: 1, versions: [{ code: '<circle fill="var(--good)">' }], check: { status: 'passed' } },
  };
  assert.deepEqual(issuesOf(f).sort(), [47, 52, 53]);
});

// M1’s exit check (#64): the person never asks for a block, so the agent has to choose one by itself.
const EXIT = ['wikisearch', 'announcement', 'papersurvey'];

test('the scenarios parse into phases the tester works through', () => {
  const dir = new URL('uat/e2e/scenarios/', import.meta.url);
  const names = readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.slice(0, -3));
  const personas = JSON.parse(readFileSync(new URL('uat/e2e/personas.json', import.meta.url), 'utf8')).map((p) => p.handle);
  for (const name of ['scifact', 'hotpotqa', ...EXIT]) assert.ok(names.includes(name), name);
  for (const name of names) {
    // uat-run.mjs --recheck reads a scenario’s name back from its run folder as word characters.
    assert.match(name, /^\w+$/, name);
    const s = parseScenario(readFileSync(new URL(`${name}.md`, dir), 'utf8'));
    assert.ok(s.phases.length >= 2 && s.phases.length <= 3, name);
    assert.ok(
      s.agents.every((h) => personas.includes(h)),
      name,
    );
    assert.ok(s.persona.length > 40 && s.project && s.conversation && s.summary, name);
  }
});

test('the M1 exit scenarios never name a block', () => {
  for (const name of EXIT) {
    const md = readFileSync(new URL(`uat/e2e/scenarios/${name}.md`, import.meta.url), 'utf8');
    assert.doesNotMatch(md, /\b(?:blocks?|choices?|forms?|reviews?|progress|confirms?|checklists?|buttons?)\b/i, name);
  }
});
