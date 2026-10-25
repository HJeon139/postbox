import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createAgyMapper } from '../server/adapters/antigravity-cli.mjs';
import { toPlainText } from '../shared/markdown.mjs';
import { agyTokens, kiroCredits, runChecks, waitingOnYou } from '../tools/uat/checks.mjs';
import { JOBS_ANSWERS } from '../tools/uat/driver.mjs';
import { readHistory } from '../tools/uat/history.mjs';
import { CLAUDE_BACKENDS, compatBackends, parseScenario, RELEASE_ONLY, releaseGate } from '../tools/uat/scenario.mjs';
import { SCHEMA, signInSettings, systemPrompt, unaddressed } from '../tools/uat/tester.mjs';

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
  // Several generic agents and no projects are a fresh install, not a finding.
  const generic = base({
    freshInstall: {
      personas: ['researcher', 'developer', 'critic'].map((handle) => ({ handle, description: 'General.', instructions: '' })),
      projects: [],
    },
  });
  assert.ok(!issuesOf(generic).includes(43));
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
const EXIT = ['wikisearch', 'announcement', 'papersurvey', 'longresearch'];

test('the scenarios parse into phases the tester works through', () => {
  const dir = new URL('uat/e2e/scenarios/', import.meta.url);
  const names = readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.slice(0, -3));
  const personas = JSON.parse(readFileSync(new URL('uat/e2e/personas.json', import.meta.url), 'utf8')).map((p) => p.handle);
  for (const name of ['scifact', 'hotpotqa', 'codex', 'diagnosis', ...EXIT]) assert.ok(names.includes(name), name);
  for (const name of names) {
    // uat-run.mjs --recheck reads a scenario’s name back from its run folder as word characters.
    assert.match(name, /^\w+$/, name);
    const s = parseScenario(readFileSync(new URL(`${name}.md`, dir), 'utf8'));
    assert.ok(s.phases.length >= 2 && s.phases.length <= (name === 'codex' ? 4 : 3), name);
    assert.ok(
      s.agents.every((h) => personas.includes(h)),
      name,
    );
    assert.ok(s.persona.length > 40 && s.project && s.conversation && s.summary, name);
  }
  const codex = parseScenario(readFileSync(new URL('codex.md', dir), 'utf8'));
  assert.deepEqual(codex.backends.critic, { backend: 'codex', model: null });
  assert.deepEqual(codex.permissionModes, { critic: 'ask' });
  assert.ok(codex.phases.some((p) => /resume/i.test(p.title)));
  assert.ok(codex.phases.some((p) => /fork/i.test(p.title)));
});

test('the M1 exit scenarios never name a block', () => {
  for (const name of EXIT) {
    const md = readFileSync(new URL(`uat/e2e/scenarios/${name}.md`, import.meta.url), 'utf8');
    assert.doesNotMatch(md, /\b(?:blocks?|choices?|forms?|reviews?|progress|confirms?|checklists?|buttons?)\b/i, name);
  }
});

test('lint-on-person-term counts a term you used only when a lint turn made the agent define it (#55)', () => {
  const facts = (lintReply) => {
    const f = base();
    f.state.items.t1 = [
      { id: 'u1', kind: 'user', at: 1, text: 'Show me the supporting facts.' },
      { id: 'a1', kind: 'agent', at: 2, handle: 'researcher', text: 'Here they are.', ...(lintReply ? { lintReply: true } : {}) },
    ];
    f.state.glossary.t1 = { 'supporting-facts': { key: 'supporting-facts', term: 'supporting facts', by: 'researcher', at: 3 } };
    return f;
  };
  // Defined on its own, in its own reply: not the lint's doing.
  assert.ok(!issuesOf(facts(false)).includes(55));
  // Defined in the turn that answered a lint: the lint flagged your words.
  assert.ok(issuesOf(facts(true)).includes(55));
});

// ── Kiro CLI agents (#117): the checks read Kiro’s recorded turns (tests/fixtures/kiro-cli), kept apart from Claude Code’s.
const kiroFixture = (name) =>
  readFileSync(new URL(`fixtures/kiro-cli/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
const kiroFacts = (name, persona = {}, over = {}) => {
  const f = base({ kiroStreams: [{ handle: 'critic', events: kiroFixture(name) }], ...over });
  f.state.personas = { p1: { id: 'p1', handle: 'critic', backend: 'kiro-cli', usesHostSetup: false, tools: ['shell', 'web.fetch'], ...persona } };
  return f;
};
const kiroChecks = (facts) => runChecks(facts).filter((x) => x.check.startsWith('kiro-'));
const toolCall = (id, extra) => ({
  type: 'sessionUpdate',
  data: { sessionId: 's', update: { sessionUpdate: 'tool_call', toolCallId: id, status: 'pending', ...extra } },
});
const toolDone = (id, extra) => ({
  type: 'sessionUpdate',
  data: { sessionId: 's', update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', ...extra } },
});

test('kiro-settings-leak: an Isolated Kiro agent that loaded steering files; with your setup they’re meant to load', () => {
  // Recorded with the person’s own ~/.kiro: nine steering files.
  const leak = kiroChecks(kiroFacts('host-write-refused'));
  assert.deepEqual(
    leak.filter((x) => x.check === 'kiro-settings-leak').map((x) => x.issue),
    [57],
  );
  assert.match(leak.find((x) => x.check === 'kiro-settings-leak').evidence, /@critic loaded \d+ steering files/);
  assert.ok(!kiroChecks(kiroFacts('host-write-refused', { usesHostSetup: true })).some((x) => x.check === 'kiro-settings-leak'));
  // A Claude Code persona with the same handle isn’t read as a Kiro one.
  assert.deepEqual(kiroChecks(kiroFacts('host-write-refused', { backend: 'claude-code' })), []);
});

test('kiro-mcp-leak: a completed call to a server other than Postbox’s; the recorded denied one isn’t', () => {
  // Recorded: another server’s call denied by the Isolated rule, Postbox’s went through (and failed on a test session).
  assert.ok(!kiroChecks(kiroFacts('isolated-deny')).some((x) => x.check === 'kiro-mcp-leak'));
  const got = kiroFacts('isolated-deny');
  got.kiroStreams[0].events.push(
    toolCall('x1', { title: '@creds-agent/get_aws_creds', rawInput: { tool_id: 'creds-agent::get_aws_creds', arguments: {} } }),
    toolDone('x1', { _meta: { kiro: { serverName: 'creds-agent' } } }),
  );
  const found = kiroChecks(got).filter((x) => x.check === 'kiro-mcp-leak');
  assert.equal(found.length, 1);
  assert.match(found[0].evidence, /@critic: @creds-agent\/get_aws_creds \(creds-agent\)/);
  assert.ok(
    !kiroChecks({ ...got, state: { ...got.state, personas: { p1: { ...got.state.personas.p1, usesHostSetup: true } } } }).some(
      (x) => x.check === 'kiro-mcp-leak',
    ),
  );
});

test('kiro-refusal-not-shown: each refused call needs a denied step under its id', () => {
  // Recorded: a command Kiro would have asked about, refused headless (pending_interaction, then cancelled).
  const shown = (id) => ({
    t1: [{ id: 'a1', kind: 'agent', handle: 'critic', activity: { steps: [{ id, label: 'Print a test greeting', state: 'denied' }] } }],
  });
  const hidden = kiroChecks(kiroFacts('resume-refused')).filter((x) => x.check === 'kiro-refusal-not-shown');
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].issue, 65);
  assert.match(hidden[0].evidence, /^1 refused without a step: @critic: Print a test greeting\./);
  const f = kiroFacts('resume-refused');
  f.state.items = shown('run_command_toolu_bdrk_01VMYnYYRQUd4GpeSbRKVFQ8');
  assert.ok(!kiroChecks(f).some((x) => x.check === 'kiro-refusal-not-shown'));
  // A deny rule’s refusal (policyDenial) counts too.
  const deny = kiroChecks(kiroFacts('isolated-deny')).filter((x) => x.check === 'kiro-refusal-not-shown');
  assert.match(deny[0]?.evidence ?? '', /@other\/read_conversation/);
});

test('kiro-tool-not-allowed: a command or a fetch that ran when the persona doesn’t tick it', () => {
  const ran = (tools) => {
    const f = kiroFacts('first', { tools });
    f.kiroStreams[0].events.push(toolCall('c1', { kind: 'execute', title: 'Running: echo hi' }), toolDone('c1'));
    return kiroChecks(f).filter((x) => x.check === 'kiro-tool-not-allowed');
  };
  assert.equal(ran([]).length, 1);
  assert.match(ran([])[0].evidence, /@critic: Running: echo hi \(shell\)/);
  assert.deepEqual(ran(['shell']), []);
  // A refused command didn’t run.
  assert.ok(!kiroChecks(kiroFacts('resume-refused', { tools: [] })).some((x) => x.check === 'kiro-tool-not-allowed'));
});

test('Kiro streams don’t trip the Claude Code checks, and the recorded Kiro turns pass the Kiro ones', () => {
  // The same findings as a run with no streams at all.
  for (const name of ['block', 'host-write-refused', 'isolated-deny'])
    assert.deepEqual(
      runChecks(kiroFacts(name, { usesHostSetup: true }))
        .filter((x) => !x.check.startsWith('kiro-'))
        .map((x) => x.check),
      runChecks(base()).map((x) => x.check),
      name,
    );
  for (const name of ['block', 'first', 'missing-session', 'agent-missing']) assert.deepEqual(kiroChecks(kiroFacts(name)), [], name);
});

// ── Antigravity CLI agents (#143), in release runs: the checks read agy’s recorded turns (tests/fixtures/antigravity-cli).
const agyFixture = (name) =>
  readFileSync(new URL(`fixtures/antigravity-cli/${name}.jsonl`, import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
/** A run with one recorded agy turn; `shown` puts in the conversation the steps the adapter makes of it. */
const agyFacts = (name, { persona = {}, shown = false } = {}) => {
  const events = agyFixture(name);
  const f = base({ agyStreams: [{ handle: 'critic', events }] });
  f.state.personas = { p1: { id: 'p1', handle: 'critic', backend: 'antigravity-cli', tools: ['shell', 'web.fetch'], ...persona } };
  if (shown) {
    const steps = new Map();
    const ctx = { text: () => {}, status: () => {}, reported: () => {}, activity: (a) => steps.set(a.id, { ...steps.get(a.id), ...a }) };
    const m = createAgyMapper(ctx);
    for (const e of events) m.push(e);
    f.state.items.t1 = [{ id: 'i1', kind: 'agent', text: '', activity: { steps: [...steps.values()] } }];
  }
  return f;
};
const agyChecks = (facts) => runChecks(facts).filter((x) => x.check.startsWith('agy-'));

test('agy-refusal-not-shown: each refused call needs a denied step under the id the adapter gives it', () => {
  // Refused on the step (ERROR), and refused only in the result’s denied_actions (the step said DONE).
  for (const name of ['refused', 'auto-unavailable']) {
    const hidden = agyChecks(agyFacts(name)).filter((x) => x.check === 'agy-refusal-not-shown');
    assert.equal(hidden.length, 1, name);
    assert.match(hidden[0].evidence, /1 refused without a step: @critic: run_command echo hi > out\.txt/);
    // What the adapter shows for the same stream satisfies the check: the ids agree.
    assert.ok(!agyChecks(agyFacts(name, { shown: true })).some((x) => x.check === 'agy-refusal-not-shown'), name);
  }
});

test('agy-postbox-refused: Postbox’s own tool refused means the allow rule is missing', () => {
  const found = agyChecks(agyFacts('postbox-refused', { shown: true }));
  assert.deepEqual(
    found.map((x) => x.check),
    ['agy-postbox-refused'],
  );
  assert.match(found[0].evidence, /show_block \(postbox_postbox\).*allow rule/);
  assert.ok(!agyChecks(agyFacts('block')).some((x) => x.check === 'agy-postbox-refused'));
});

test('agy-tool-not-allowed: a command that ran when the persona doesn’t tick shell; a refused one didn’t run', () => {
  const ran = agyFacts('first', { persona: { tools: ['web.fetch'] } });
  ran.agyStreams[0].events.push(
    {
      event: 'step_update',
      step_update: {
        conversation_id: 'c',
        step_index: 7,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { parameters: { CommandLine: 'ls' } },
      },
    },
    {
      event: 'step_update',
      step_update: {
        conversation_id: 'c',
        step_index: 7,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { parameters: { CommandLine: 'ls' }, output: 'a.txt' },
      },
    },
  );
  const hit = agyChecks(ran).filter((x) => x.check === 'agy-tool-not-allowed');
  assert.equal(hit.length, 1);
  assert.match(hit[0].evidence, /@critic: run_command ls \(shell\)/);
  assert.ok(!agyChecks(agyFacts('refused', { persona: { tools: [] }, shown: true })).some((x) => x.check === 'agy-tool-not-allowed'));
  assert.ok(!agyChecks(agyFacts('auto-unavailable', { persona: { tools: [] }, shown: true })).some((x) => x.check === 'agy-tool-not-allowed'));
});

test('agy streams don’t trip the other checks; the clean recorded turns pass the agy ones; a Claude persona’s aren’t read', () => {
  for (const name of ['block', 'refused', 'resume'])
    assert.deepEqual(
      runChecks(agyFacts(name, { shown: true }))
        .filter((x) => !x.check.startsWith('agy-'))
        .map((x) => x.check),
      runChecks(base()).map((x) => x.check),
      name,
    );
  for (const name of ['block', 'first', 'resume', 'missing-session', 'bad-model']) assert.deepEqual(agyChecks(agyFacts(name)), [], name);
  assert.deepEqual(agyChecks(agyFacts('refused', { persona: { backend: 'claude-code' } })), []);
});

test('Antigravity tokens are added up per model call, not from results, which count the whole conversation', () => {
  // resume.jsonl: one call of 7,822 tokens; its result says 15,427, both turns so far.
  assert.equal(agyTokens([{ handle: 'critic', events: agyFixture('resume') }]), 7822);
  assert.equal(
    agyTokens([
      { handle: 'x', events: agyFixture('first') },
      { handle: 'y', events: [{ type: 'result', total_cost_usd: 1 }] },
    ]),
    6870,
  );
});

test('model-not-shown accepts a model a persona names, such as a Kiro agent’s GPT', () => {
  const f = (header, model) => {
    const x = base({ ui: { headerText: header } });
    x.state.personas = { p1: { id: 'p1', handle: 'critic', backend: 'kiro-cli', model } };
    return issuesOf(x).includes(60);
  };
  assert.equal(f('@critic gpt-5.6-terra · medium', 'gpt-5.6-terra'), false);
  assert.equal(f('@critic medium', 'gpt-5.6-terra'), true);
});

test('Kiro credits are added up from each turn’s completion; Claude streams add none', () => {
  assert.ok(Math.abs(kiroCredits([{ handle: 'critic', events: kiroFixture('isolated-deny') }]) - 0.3833) < 0.001);
  assert.equal(kiroCredits([{ handle: 'researcher', events: [{ type: 'result', total_cost_usd: 1 }] }]), 0);
});

test('a scenario with agents on a backend other than Claude’s is a compatibility run; Claude’s own backends aren’t', () => {
  const mixed = parseScenario(readFileSync(new URL('uat/e2e/scenarios/mixedroom.md', import.meta.url), 'utf8'));
  assert.deepEqual(compatBackends(mixed), ['kiro-cli']);
  assert.deepEqual(compatBackends(parseScenario('# T\n- backends: a=codex, b=agy:m1, c=codex\n')), ['codex', 'agy']);
  assert.deepEqual(compatBackends(parseScenario('# T\n- backends: a=claude-code:claude-opus-5-5, b=agent-sdk\n')), []);
  assert.deepEqual(compatBackends(parseScenario('# T\n')), []);
  // The README lists each scenario where it belongs: compatibility runs under their own heading, regular ones above it.
  const readme = readFileSync(new URL('uat/e2e/README.md', import.meta.url), 'utf8');
  const [regular, compat] = readme.split('### Compatibility scenarios');
  assert.ok(compat, 'the README has a Compatibility scenarios section');
  const dir = new URL('uat/e2e/scenarios/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const isCompat = compatBackends(parseScenario(readFileSync(new URL(f, dir), 'utf8'))).length > 0;
    assert.equal(compat.split('\n### ')[0].includes(`(scenarios/${f})`), isCompat, `${f} is listed under compatibility: ${isCompat}`);
    assert.equal(regular.includes(`(scenarios/${f})`), !isCompat, `${f} is listed as a regular scenario: ${!isCompat}`);
  }
});

test('a scenario can put agents on another backend, with a model', () => {
  const s = parseScenario(readFileSync(new URL('uat/e2e/scenarios/mixedroom.md', import.meta.url), 'utf8'));
  assert.deepEqual(s.backends, { critic: { backend: 'kiro-cli', model: 'gpt-5.6-terra' } });
  assert.deepEqual(s.agents, ['researcher']);
  assert.deepEqual(parseScenario('# T\n- backends: @a=kiro-cli, b=claude-code:claude-opus-5-5, junk\n').backends, {
    a: { backend: 'kiro-cli', model: null },
    b: { backend: 'claude-code', model: 'claude-opus-5-5' },
  });
  assert.deepEqual(parseScenario('# T\n').backends, {});
  assert.deepEqual(parseScenario('# T\n- permission_modes: @critic=ask, reviewer=bypass\n').permissionModes, { critic: 'ask', reviewer: 'bypass' });
});

test('the Antigravity CLI runs only in a release run: refused in a scenario, and off for the tester, otherwise (#143)', () => {
  const gem = parseScenario('# T\n- backends: critic=antigravity-cli:gemini-3.8-flash-high, researcher=kiro-cli\n');
  const refused = releaseGate(gem);
  assert.match(String(refused.error), /@critic on the Antigravity CLI, which runs only for a version release.*--release/);
  assert.doesNotMatch(String(refused.error), /@researcher/);
  assert.deepEqual(releaseGate(gem, { release: true }), { error: null, env: {} });
  // Any other scenario runs, with Postbox started without the Antigravity CLI.
  const plain = releaseGate(parseScenario(readFileSync(new URL('uat/e2e/scenarios/mixedroom.md', import.meta.url), 'utf8')));
  assert.equal(plain.error, null);
  assert.deepEqual(Object.keys(plain.env), ['POSTBOX_AGY_BIN']);
  assert.ok(Object.hasOwn(RELEASE_ONLY, 'antigravity-cli'));
  // A release-only backend is a compatibility backend first: it’s never one of Claude’s.
  for (const b of Object.keys(RELEASE_ONLY)) assert.ok(!CLAUDE_BACKENDS.has(b), b);
  // The Gemini room is the release run’s scenario.
  const gemini = parseScenario(readFileSync(new URL('uat/e2e/scenarios/geminiroom.md', import.meta.url), 'utf8'));
  assert.deepEqual(gemini.backends, { critic: { backend: 'antigravity-cli', model: 'gemini-3.8-flash-high' } });
  assert.deepEqual(compatBackends(gemini), ['antigravity-cli']);
  assert.match(String(releaseGate(gemini).error), /@critic on the Antigravity CLI/);
  assert.equal(releaseGate(gemini, { release: true }).error, null);
});

test('the tester keeps how your Claude Code signs in, and nothing else of your settings', () => {
  const read = () =>
    JSON.stringify({
      awsCredentialExport: 'some-helper --json',
      modelOverrides: { 'claude-sonnet-5-5': 'arn:aws:bedrock:us-west-2:000000000000:x' },
      env: { AWS_REGION: 'us-west-2', CLAUDE_CODE_USE_BEDROCK: '1', SECRET_THING: 'no' },
      outputStyle: 'Concise',
      permissions: { allow: ['Bash'] },
    });
  assert.deepEqual(signInSettings({ dir: '/nowhere', read }), {
    awsCredentialExport: 'some-helper --json',
    modelOverrides: { 'claude-sonnet-5-5': 'arn:aws:bedrock:us-west-2:000000000000:x' },
    env: { AWS_REGION: 'us-west-2', CLAUDE_CODE_USE_BEDROCK: '1' },
  });
  assert.deepEqual(signInSettings({ dir: '/nowhere', read: () => '{"theme":"dark"}' }), {});
  assert.deepEqual(
    signInSettings({
      dir: '/nowhere',
      read: () => {
        throw new Error('ENOENT');
      },
    }),
    {},
  );
});

test('what’s waiting on you: unanswered asking blocks, open requests, and what sessions need; not answered ones', () => {
  const state = {
    threads: { t1: { id: 't1', title: 'Main', members: ['s1', 's2'] }, t2: { id: 't2', title: 'Topic', members: ['s3'] } },
    sessions: {
      s1: { id: 's1', handle: 'researcher', threadId: 't1', needs: null },
      s2: { id: 's2', handle: 'critic', threadId: 't1', needs: { kind: 'permission', itemId: 'p1', text: '@critic asks to run python3' } },
      s3: { id: 's3', handle: 'critic', threadId: 't2', needs: { kind: 'failed', itemId: 'f1', text: 'The turn failed' } },
    },
    items: {
      t1: [
        { id: 'r1', kind: 'block', handle: 'researcher', valid: true, block: { type: 'review', title: 'Design note', revision: 3 } },
        { id: 'c1', kind: 'block', handle: 'researcher', valid: true, answered: true, block: { type: 'choice', title: 'Pick one' } },
        { id: 'x1', kind: 'block', handle: 'researcher', valid: true, block: { type: 'table', title: 'Numbers' } },
        { id: 'b1', kind: 'block', handle: 'researcher', valid: false, block: { type: 'form', title: 'Broken' } },
        { id: 'h1', kind: 'hop', status: 'open' },
        { id: 'p1', kind: 'permission', handle: 'critic', status: 'open' },
      ],
      t2: [{ id: 'f1', kind: 'agent', handle: 'critic', status: 'failed' }],
    },
  };
  assert.deepEqual(
    waitingOnYou(state, ['t1', 't2']).map((w) => [w.itemId, w.threadId, w.what]),
    [
      ['r1', 't1', '@researcher’s review “Design note”, revision 3'],
      ['h1', 't1', 'a wake request'],
      ['p1', 't1', '@critic asks to run python3'],
      ['f1', 't2', 'The turn failed'],
    ],
  );
  assert.deepEqual(waitingOnYou(state, []), []);
});

test('the tester can answer a review, and is told to clear what waits on it before moving on', () => {
  const action = SCHEMA.properties.action.properties;
  assert.ok(action.type.enum.includes('review'));
  assert.deepEqual(action.verdict.enum, ['approve', 'request_changes', 'comment']);
  assert.deepEqual(action.comments.items.required, ['line', 'text']);
  // And open a persona’s settings, and its permissions panel, which the mixed-room run couldn’t reach.
  assert.ok(action.type.enum.includes('settings'));
  assert.ok(action.type.enum.includes('send_then_stop'));
  assert.equal(action.permissions.type, 'boolean');
  const prompt = systemPrompt({ scenario: parseScenario('# T\n- persona: someone\n\n## Phase 1: x\n\ny\n'), issues: [] });
  assert.match(prompt, /review \{item, verdict, comments\}/);
  assert.match(prompt, /request changes, with at least one comment on a line/);
  assert.match(prompt, /Answer them before you move to the next phase or finish/);
  assert.match(prompt, /settings \{target, permissions\?\}/);
  assert.match(prompt, /send_then_stop \{text, seconds\?\}/);
});

test('a message that addresses an agent by name without its @ is flagged: it goes to whoever spoke last', () => {
  const handles = ['researcher', 'critic'];
  assert.deepEqual(unaddressed('critic: of everything you raised, what’s the biggest concern?', handles), ['critic']);
  assert.deepEqual(unaddressed('  Researcher, did you fix the gap critic found?', handles), ['researcher']);
  // A name that doesn’t open the message, followed by “:” or “,”, isn’t addressing anyone.
  assert.deepEqual(unaddressed('What did the researcher find?', handles), []);
  assert.deepEqual(unaddressed('the critics agree', handles), []);
  // It went to the agent it named anyway.
  assert.deepEqual(unaddressed('critic: and the second point?', handles, { lastSpeaker: 'critic' }), []);
  // Mentions are read as Postbox reads them: one in the text counts; one in code, or after a letter, doesn’t.
  assert.deepEqual(unaddressed('critic: ask @researcher too', handles), []);
  assert.deepEqual(unaddressed('critic: try `@researcher` in the composer', handles), ['critic']);
  assert.deepEqual(unaddressed('critic: write to x@researcher', handles), ['critic']);
  assert.deepEqual(unaddressed('Good draft. Ship it.', handles), []);
  const prompt = systemPrompt({ scenario: parseScenario('# T\n'), issues: [] });
  assert.match(prompt, /write its handle with the @/);
  // The actions stay one list: the waiting-on-you paragraph comes after done.
  assert.match(prompt, /- next_phase: [^\n]*\n- done: [^\n]*\n\nEach step also lists what’s waiting on you/);
});

describe('the P0 hotfixes’ checks fire on the defect as it was reported, and stay quiet once it’s fixed', () => {
  const T0 = Date.parse('2026-10-22T17:22:52.000Z');
  const iso = (ms) => new Date(ms).toISOString();
  const found = (facts, check) => runChecks(facts).filter((x) => x.check === check);
  const room = (over = {}) =>
    base({
      state: {
        threads: {
          t1: { id: 't1', title: 'The 2.0 release checklist', kind: 'thread', members: ['s1', 's2'] },
          t2: { id: 't2', title: '@critic ↔ @researcher', kind: 'side', parentId: 't1', members: ['s3'] },
        },
        items: { t1: [], t2: [] },
        sessions: {
          s1: { id: 's1', handle: 'researcher', state: 'idle', backendState: { claudeSessionId: 'aaaa1111-0000-4000-8000-000000000000' } },
          s2: { id: 's2', handle: 'critic', state: 'idle', backendState: { claudeSessionId: '35d8a8ea-0000-4000-8000-000000000000' } },
          s3: { id: 's3', handle: 'researcher', state: 'idle' },
        },
        apps: {},
        glossary: {},
      },
      threads: ['t1', 't2'],
      ...over,
    });

  test('duplicate-block-id (#125): two drafts shown under one id by one session, 27 s apart', () => {
    const block = (id, title, at, over = {}) => ({
      id,
      kind: 'block',
      sessionId: 's2',
      handle: 'critic',
      valid: true,
      at,
      block: { id: 'issue-review-revision-race', type: 'review', title, format: 'markdown', content: title },
      ...over,
    });
    const f = room();
    f.state.items.t1 = [block('it_WY8KwH8g', 'Draft: revision race', T0), block('it_AIMlKOi', 'Draft: answers lose their revision', T0 + 27_000)];
    const [hit, ...rest] = found(f, 'duplicate-block-id');
    assert.equal(rest.length, 0);
    assert.equal(hit.issue, 125);
    assert.equal(
      hit.evidence,
      '@critic showed “issue-review-revision-race” 2 times in “The 2.0 release checklist”: it_WY8KwH8g (“Draft: revision race”), it_AIMlKOi (“Draft: answers lose their revision”), 27 s apart.',
    );
    // Fixed: the second show_block is refused, so there’s one block. Another agent may use the same id, and a block
    // that failed to validate, shown again once fixed, isn’t two blocks.
    f.state.items.t1 = [block('it_WY8KwH8g', 'Draft: revision race', T0)];
    assert.deepEqual(found(f, 'duplicate-block-id'), []);
    f.state.items.t1.push(block('it_other', 'Same id, other agent', T0 + 5000, { sessionId: 's1', handle: 'researcher' }));
    f.state.items.t1.push(block('it_bad', 'Invalid first try', T0 - 5000, { valid: false }));
    assert.deepEqual(found(f, 'duplicate-block-id'), []);
  });

  // The request kept a 200-character preview (server/runtime.mjs at 74090ef), clipped the way Postbox clips it.
  const preview = (text) => {
    const t = toPlainText(text);
    return t.length > 200 ? `${t.slice(0, 199)}…` : t;
  };
  const fixes = Array.from({ length: 60 }, (_, i) => `Must fix ${i + 1}: Acceptance bar, the item that needs its own test before 2.0 ships.`)
    .join(' ')
    .slice(0, 3500)
    .padEnd(3500, '.');
  const wakeRoom = ({ hopText = undefined, delivered, streams = [] }) => {
    const f = room({ streams });
    const hop = { id: 'it_hop4', at: T0, kind: 'hop', fromSessionId: 's2', from: 'critic', to: 'researcher', reason: preview(fixes), status: 'allowed', n: 4 };
    f.state.items.t1 = [hopText === undefined ? hop : { ...hop, text: hopText }];
    f.state.items.t2 = [{ id: 'it_said', at: T0 + 30_000, kind: 'agent', sessionId: 's2', handle: 'critic', text: delivered, status: 'done' }];
    return f;
  };
  const wakeCall = [
    { type: 'system', subtype: 'init', session_id: '35d8a8ea-0000-4000-8000-000000000000' },
    {
      type: 'assistant',
      timestamp: iso(T0 - 1000),
      message: { content: [{ type: 'tool_use', id: 'toolu_wake', name: 'mcp__postbox__wake_agent', input: { handle: '@researcher', message: fixes } }] },
    },
  ];

  test('wake-text-clipped (#108): the fourth wake, allowed, delivered 200 of the 3,500 characters sent', () => {
    assert.equal(fixes.length, 3500);
    assert.equal(preview(fixes).length, 200);
    let hits = found(wakeRoom({ delivered: preview(fixes), streams: [{ handle: 'critic', events: wakeCall }] }), 'wake-text-clipped');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].issue, 108);
    assert.match(hits[0].evidence, /^@critic sent @researcher 3,500 characters; once the wake was allowed, @researcher got 200, ending “/);
    // Without the stream, the preview delivered as the message still gives it away.
    hits = found(wakeRoom({ delivered: preview(fixes) }), 'wake-text-clipped');
    assert.match(hits[0]?.evidence ?? '', /got only the request’s 200-character preview/);
    // Fixed: the request keeps the whole message, and allowing it delivers all of it.
    assert.deepEqual(found(wakeRoom({ hopText: fixes, delivered: fixes, streams: [{ handle: 'critic', events: wakeCall }] }), 'wake-text-clipped'), []);
    // A fix that kept the text but still delivered the preview is caught by the text it kept.
    assert.match(found(wakeRoom({ hopText: fixes, delivered: preview(fixes) }), 'wake-text-clipped')[0]?.evidence ?? '', /3,500 characters/);
    // A short message was never clipped.
    const short = room();
    short.state.items.t1 = [{ id: 'h', at: T0, kind: 'hop', fromSessionId: 's2', from: 'critic', to: 'researcher', reason: 'Two fixes.', status: 'allowed' }];
    short.state.items.t2 = [{ id: 'w', at: T0 + 1, kind: 'agent', sessionId: 's2', handle: 'critic', text: 'Two fixes.', status: 'done' }];
    assert.deepEqual(found(short, 'wake-text-clipped'), []);
    // Nor was one under 200 characters whose preview is only plainer, with its Markdown gone.
    const md = 'Fix [the docs](https://example.com/docs) and `setup.py` first.';
    const plain = room({
      streams: [
        {
          handle: 'critic',
          events: [{ ...wakeCall[1], message: { content: [{ ...wakeCall[1].message.content[0], input: { handle: 'researcher', message: md } }] } }],
        },
      ],
    });
    plain.state.items.t1 = [{ id: 'h', at: T0, kind: 'hop', fromSessionId: 's2', from: 'critic', to: 'researcher', reason: preview(md), status: 'allowed' }];
    plain.state.items.t2 = [{ id: 'w', at: T0 + 1, kind: 'agent', sessionId: 's2', handle: 'critic', text: preview(md), status: 'done' }];
    assert.ok(preview(md).length < md.length);
    assert.deepEqual(found(plain, 'wake-text-clipped'), []);
  });

  // Two turns of @critic’s one Claude Code session, as in #126: the person sent a message at 17:22:52, Postbox showed
  // the turn stopped and started the next, and the old process went on until about 17:24:20.
  const CLAUDE = '35d8a8ea-0000-4000-8000-000000000000';
  const turn = (started, until, calls = []) => ({
    handle: 'critic',
    started,
    ended: until,
    events: [
      { type: 'system', subtype: 'init', session_id: CLAUDE },
      { type: 'assistant', timestamp: iso(started + 200), message: { content: [{ type: 'text', text: 'Looking into it.' }] } },
      ...calls.flatMap(({ at, name, error = false }, i) => [
        { type: 'assistant', timestamp: iso(at), message: { content: [{ type: 'tool_use', id: `toolu_${i}`, name, input: {} }] } },
        {
          type: 'user',
          timestamp: iso(at + 200),
          message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: 'ok', ...(error ? { is_error: true } : {}) }] },
        },
      ]),
      { type: 'assistant', timestamp: iso(until), message: { content: [{ type: 'text', text: 'Done.' }] } },
    ],
  });
  const stopped = {
    id: 'it_stop',
    kind: 'agent',
    sessionId: 's2',
    handle: 'critic',
    turnId: 'turn_zCrGu5np',
    text: '',
    status: 'stopped',
    stoppedAt: T0,
    at: T0 - 60_000,
  };

  test('two-processes-one-session (#126): the stopped turn ran on for 88 s beside the next, calling Postbox’s tools', () => {
    const old = turn(T0 - 60_000, T0 + 88_000, [
      { at: T0 + 40_000, name: 'mcp__postbox__show_block' },
      { at: T0 + 70_000, name: 'mcp__postbox__update_block' },
    ]);
    const f = room({ streams: [old, turn(T0 + 50, T0 + 30_000)] });
    f.state.items.t1 = [stopped];
    const hits = found(f, 'two-processes-one-session');
    assert.deepEqual(
      hits.map((h) => [h.issue, h.title]),
      [
        [126, 'Two turns of one agent session ran at the same time'],
        [126, 'A stopped turn went on calling Postbox’s tools'],
      ],
    );
    assert.equal(
      hits[0].evidence,
      '@critic’s turn started at 17:22:52 UTC while the session’s previous turn (Claude Code session 35d8a8ea) went on until 17:24:20 UTC, 88 s later.',
    );
    assert.equal(
      hits[1].evidence,
      '@critic was stopped at 17:22:52 UTC, and its process then made 2 Postbox calls (show_block, update_block), the last 70 s after Stop.',
    );
  });

  test('two-processes-one-session stays quiet when the next turn waits for the old process, and on refused calls', () => {
    // Fixed: the old process exited a moment after Stop, and the next turn started after it.
    let f = room({ streams: [turn(T0 - 60_000, T0 + 400), turn(T0 + 1500, T0 + 30_000)] });
    f.state.items.t1 = [stopped];
    assert.deepEqual(found(f, 'two-processes-one-session'), []);
    // A call in the moment after Stop that Postbox refused (a stopped turn’s token) wasn’t applied.
    f = room({
      streams: [turn(T0 - 60_000, T0 + 2900, [{ at: T0 + 2500, name: 'mcp__postbox__show_block', error: true }]), turn(T0 + 4000, T0 + 9000)],
    });
    f.state.items.t1 = [stopped];
    assert.deepEqual(found(f, 'two-processes-one-session'), []);
    // A call the process made just before it was killed, with no result, never reached Postbox.
    const cut = turn(T0 - 60_000, T0 + 1000);
    cut.events.push({
      type: 'assistant',
      timestamp: iso(T0 + 1500),
      message: { content: [{ type: 'tool_use', id: 'toolu_cut', name: 'mcp__postbox__show_block', input: {} }] },
    });
    f = room({ streams: [cut, turn(T0 + 4000, T0 + 9000)] });
    f.state.items.t1 = [stopped];
    assert.deepEqual(found(f, 'two-processes-one-session'), []);
    // Turns of different sessions (a topic thread’s fork has its own id) may run side by side.
    const fork = turn(T0, T0 + 60_000);
    fork.events[0] = { ...fork.events[0], session_id: 'fork-0000' };
    assert.deepEqual(found(room({ streams: [turn(T0 - 60_000, T0 + 30_000), fork] }), 'two-processes-one-session'), []);
  });

  // @developer’s background command in #129: its step closed as done in 2.6 s while the command ran on.
  const bgStream = (extra = []) => ({
    handle: 'researcher',
    events: [
      { type: 'system', subtype: 'init', session_id: 'aaaa1111-0000-4000-8000-000000000000' },
      {
        type: 'assistant',
        timestamp: iso(T0),
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'toolu_bg',
              name: 'Bash',
              input: {
                command: 'for i in $(seq 36); do date >> heartbeat-1.log; sleep 5; done',
                description: 'Append the time every 5 s',
                run_in_background: true,
              },
            },
          ],
        },
      },
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'bgxwt3pqu',
        tool_use_id: 'toolu_bg',
        description: 'Append the time every 5 s',
        task_type: 'local_bash',
      },
      {
        type: 'user',
        timestamp: iso(T0 + 2600),
        message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'Command running in background with ID: bgxwt3pqu.' }] },
        tool_use_result: { stdout: '', stderr: '', backgroundTaskId: 'bgxwt3pqu' },
      },
      ...extra,
    ],
  });
  const bgRoom = (state, streams, sessionFields = {}) => {
    const f = room({ streams });
    f.state.items.t1 = [
      {
        id: 'it_a',
        kind: 'agent',
        sessionId: 's1',
        handle: 'researcher',
        turnId: 'u1',
        text: 'Started.',
        activity: { steps: [{ id: 'toolu_bg', label: 'Append the time every 5 s', state, ms: 2600 }] },
      },
    ];
    Object.assign(f.state.sessions.s1, sessionFields);
    return f;
  };

  test('background-step-closed (#126, #129): a background command’s step says done while the stream hasn’t seen it end', () => {
    const [hit, ...rest] = found(bgRoom('done', [bgStream()]), 'background-step-closed');
    assert.equal(rest.length, 0);
    assert.equal(hit.issue, 126);
    assert.match(
      hit.evidence,
      /^@researcher’s step “Append the time every 5 s” says done, but the stream hasn’t seen it end \(background id bgxwt3pqu\): for i in/,
    );
    // Fixed: the step stays running while the job runs; or it closes once the job’s end is reported.
    assert.deepEqual(found(bgRoom('running', [bgStream()]), 'background-step-closed'), []);
    const end = {
      type: 'system',
      subtype: 'task_notification',
      task_id: 'bgxwt3pqu',
      tool_use_id: 'toolu_bg',
      status: 'completed',
      output_file: '/tmp/x.output',
    };
    assert.deepEqual(found(bgRoom('done', [bgStream([end])]), 'background-step-closed'), []);
    // A fix’s own record of the job decides, when there is one. Without one, a step that names its job was closed by a
    // fix that tracks it (fix/p0-stop removes the record when the job ends), even when Keep running left the stream
    // without the end.
    const tracked = bgRoom('done', [bgStream()]);
    tracked.state.items.t1[0].activity.steps[0].job = 'bgxwt3pqu';
    assert.deepEqual(found(tracked, 'background-step-closed'), []);
    tracked.state.sessions.s1.jobs = [{ id: 'bgxwt3pqu', toolUseId: 'toolu_bg', state: 'running', kept: true }];
    assert.equal(found(tracked, 'background-step-closed').length, 1);
    assert.deepEqual(
      found(bgRoom('done', [bgStream()], { jobs: [{ id: 'bgxwt3pqu', toolUseId: 'toolu_bg', status: 'stopped' }] }), 'background-step-closed'),
      [],
    );
    assert.equal(
      found(bgRoom('done', [bgStream([end])], { jobs: [{ id: 'bgxwt3pqu', toolUseId: 'toolu_bg', status: 'running' }] }), 'background-step-closed').length,
      1,
    );
  });

  test('background-step-closed reads a command Claude Code moved to the background, as a wave 2 run recorded it', () => {
    // From uat-runs/2026-10-22T01-02-09-hotpotqa: a command past its 120 s timeout, moved to the background, later
    // killed. A command that stays in the foreground isn’t a background job, and a monitor isn’t a command.
    const events = [
      {
        type: 'assistant',
        timestamp: iso(T0),
        message: { content: [{ type: 'tool_use', id: 'toolu_find', name: 'Bash', input: { command: 'find / -name "*.ner.pkl"' } }] },
      },
      { type: 'system', subtype: 'task_started', task_id: 'b3tvckkvo', tool_use_id: 'toolu_find', is_backgrounded: false, task_type: 'local_bash' },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b3tvckkvo', task_type: 'local_bash' }] },
      { type: 'system', subtype: 'task_updated', task_id: 'b3tvckkvo', patch: { is_backgrounded: true } },
      {
        type: 'assistant',
        timestamp: iso(T0),
        message: { content: [{ type: 'tool_use', id: 'toolu_fg', name: 'Bash', input: { command: 'python3 probe.py' } }] },
      },
      { type: 'system', subtype: 'task_started', task_id: 'bfg', tool_use_id: 'toolu_fg', is_backgrounded: false, task_type: 'local_bash' },
      { type: 'system', subtype: 'task_started', task_id: 'smzuayiss', tool_use_id: 'toolu_mon', task_type: 'monitor_ws', ambient: true },
    ];
    const withSteps = (extra) => {
      const f = room({ streams: [{ handle: 'critic', events: [...events, ...extra] }] });
      f.state.items.t1 = [
        {
          id: 'it_c',
          kind: 'agent',
          sessionId: 's2',
          handle: 'critic',
          turnId: 'u1',
          text: '',
          activity: {
            steps: [
              { id: 'toolu_find', label: 'find', state: 'done' },
              { id: 'toolu_fg', label: 'probe', state: 'done' },
              { id: 'toolu_mon', label: 'monitor', state: 'done' },
            ],
          },
        },
      ];
      return f;
    };
    assert.deepEqual(
      found(withSteps([]), 'background-step-closed').map((h) => h.key),
      ['toolu_find'],
    );
    const killed = [
      { type: 'system', subtype: 'task_updated', task_id: 'b3tvckkvo', patch: { status: 'killed', end_time: T0 + 700_000 } },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [] },
    ];
    assert.deepEqual(found(withSteps(killed), 'background-step-closed'), []);
    // Gone from the list of background tasks is ended too.
    assert.deepEqual(found(withSteps([killed[1]]), 'background-step-closed'), []);
  });

  // #123’s timeline, from the event log of block it_QhzCNay: @critic’s update at +4 s was written before it read the
  // request for changes, and its update at +70 s before it read the approval of revision 2.
  // A turn clears finishedAt as it starts and sets it as it ends; a permission card mid-turn sets needs, not finishedAt.
  const session = (seq, state, finishedAt = state === 'idle' ? T0 : null) => ({ seq, type: 'session', data: { id: 's2', state, finishedAt } });
  const added = {
    seq: 2,
    type: 'item.add',
    data: {
      threadId: 't1',
      item: {
        id: 'it_QhzCNay',
        kind: 'block',
        sessionId: 's2',
        handle: 'critic',
        valid: true,
        at: T0,
        block: { id: 'issue-draft', type: 'review', title: 'Draft issue' },
      },
    },
  };
  const answer = (seq, action, at, extra = {}) => ({
    seq,
    type: 'item.patch',
    data: { threadId: 't1', id: 'it_QhzCNay', patch: { answered: true, answer: { action, values: {}, at, ...extra } } },
  });
  const update = (seq, revision, at) => ({
    seq,
    type: 'item.patch',
    data: { threadId: 't1', id: 'it_QhzCNay', patch: { block: {}, answered: false, answer: null, revision, updatedAt: at } },
  });

  test('approval-for-other-revision (#123): updates that reopened answers the agent hadn’t read', () => {
    const events = [
      session(1, 'think'),
      added,
      answer(3, 'request_changes', T0),
      update(4, 2, T0 + 4000),
      session(5, 'idle'),
      session(6, 'think'),
      session(7, 'tool'),
      answer(8, 'approve', T0 + 35_000),
      // A permission card in the same turn: the state goes to needs and back, and the turn goes on.
      session(9, 'needs'),
      session(10, 'think'),
      update(11, 3, T0 + 70_000),
    ];
    const hits = found(room({ events }), 'approval-for-other-revision');
    assert.deepEqual(
      hits.map((h) => h.evidence),
      [
        '@critic’s update made revision 2 of “Draft issue” 4 s after the person’s request_changes on revision 1, with no turn in between to read it, so the answer was erased unread.',
        '@critic’s update made revision 3 of “Draft issue” 35 s after the person’s approve on revision 2, with no turn in between to read it, so the answer was erased unread.',
      ],
    );
    assert.ok(hits.every((h) => h.issue === 123));
  });

  test('approval-for-other-revision stays quiet when the agent read the answer first, or the update was refused', () => {
    // The person answered while @critic was idle: the answer started its turn, which then revised the draft.
    const read = [session(1, 'idle'), added, answer(3, 'request_changes', T0), session(4, 'think'), update(5, 2, T0 + 20_000)];
    assert.deepEqual(found(room({ events: read }), 'approval-for-other-revision'), []);
    // Fixed: the update over an unread answer is refused, so the answer stays and nothing reopens.
    const refused = [session(1, 'think'), added, answer(3, 'request_changes', T0), session(4, 'idle')];
    assert.deepEqual(found(room({ events: refused }), 'approval-for-other-revision'), []);
    // An outcome under an answer reports a result; it doesn’t reopen the block (#94).
    // A fix marks the answer read when it reaches the agent, or when update_block’s refusal gives it: an update after
    // that, in the same turn, was written with it.
    const told = [
      session(1, 'think'),
      added,
      answer(3, 'request_changes', T0, { revision: 1, read: false }),
      {
        seq: 4,
        type: 'item.patch',
        data: { threadId: 't1', id: 'it_QhzCNay', patch: { answer: { action: 'request_changes', at: T0, revision: 1, read: true } } },
      },
      update(5, 2, T0 + 9000),
    ];
    assert.deepEqual(found(room({ events: told }), 'approval-for-other-revision'), []);
    const outcome = [
      session(1, 'think'),
      added,
      answer(3, 'approve', T0),
      { seq: 4, type: 'item.patch', data: { threadId: 't1', id: 'it_QhzCNay', patch: { block: {}, revision: 2, updatedAt: T0 + 9000 } } },
    ];
    assert.deepEqual(found(room({ events: outcome }), 'approval-for-other-revision'), []);
  });

  test('approval-for-other-revision: an answer that landed on a revision other than the one answered', () => {
    // The runner read revision 2 just before it approved; the agent’s update to revision 3 landed first.
    const events = [session(1, 'idle'), added, update(3, 2, T0), session(4, 'think'), update(5, 3, T0 + 34_500), answer(6, 'approve', T0 + 35_000)];
    const probes = { fullScreen: [], attachments: [], answers: [{ key: 'it_QhzCNay', revision: 2, at: T0 + 34_000 }] };
    const [hit] = found(room({ events, probes }), 'approval-for-other-revision');
    assert.equal(hit?.evidence, 'The person answered revision 2 of @critic’s “Draft issue”, and Postbox applied their approve to revision 3.');
    // A fix records the revision the person saw on the answer: that decides, with or without the runner’s note.
    const saw = (revision) => [...events.slice(0, 5), answer(6, 'approve', T0 + 35_000, { revision })];
    assert.equal(found(room({ events: saw(2) }), 'approval-for-other-revision').length, 1);
    assert.deepEqual(found(room({ events: saw(3) }), 'approval-for-other-revision'), []);
    // Answered the revision it read: quiet, whatever an earlier answer to the same block read.
    assert.deepEqual(
      found(
        room({
          events,
          probes: {
            ...probes,
            answers: [
              { key: 'it_QhzCNay', revision: 1, at: T0 - 9000 },
              { key: 'it_QhzCNay', revision: 3, at: T0 + 34_800 },
            ],
          },
        }),
        'approval-for-other-revision',
      ),
      [],
    );
  });

  test('the history: a run’s saved events, else what’s left of Postbox’s log, cut to what the checks read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'postbox-history-'));
    try {
      mkdirSync(join(dir, 'data'));
      const log = [
        { seq: 1, type: 'session', data: { id: 's2', state: 'think', personaSnapshot: { instructions: 'long' } } },
        { seq: 2, type: 'item.text', data: { threadId: 't1', id: 'x', text: 'Try' } },
        added,
      ];
      // The last line was still being written.
      writeFileSync(join(dir, 'data', 'events-1.jsonl'), `${log.map((e) => JSON.stringify(e)).join('\n')}\n{"seq":4,"type":"item.pa`);
      assert.deepEqual(readHistory(dir), [{ seq: 1, type: 'session', data: { id: 's2', state: 'think', finishedAt: null, updatedAt: null } }, added]);
      writeFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(session(9, 'idle'))}\n`);
      assert.deepEqual(readHistory(dir), [session(9, 'idle')]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the P0 scenario: a room of two Claude Code agents, in three phases', () => {
    const s = parseScenario(readFileSync(new URL('uat/e2e/scenarios/p0.md', import.meta.url), 'utf8'));
    assert.deepEqual(s.agents, ['researcher', 'critic']);
    assert.deepEqual(s.backends, {});
    assert.equal(s.phases.length, 3);
    assert.match(s.phases[0].text, /allow it/);
    assert.match(s.phases[1].text, /answer the draft while it’s still working/);
    assert.match(s.phases[2].text, /press Stop[\s\S]*keep it running[\s\S]*stop it too[\s\S]*Send now/);
  });

  test('the tester can stop a turn or send now while it runs, and answer the question about background jobs', () => {
    const action = SCHEMA.properties.action.properties;
    assert.ok(action.type.enum.includes('jobs'));
    assert.deepEqual(action.answer.enum, ['stop', 'keep']);
    assert.deepEqual(action.interrupt.properties.do.enum, ['stop', 'send_now', 'answer', 'fault']);
    assert.deepEqual(action.interrupt.required, ['after', 'do']);
    // The decision’s words for the two answers (#126).
    assert.deepEqual(JOBS_ANSWERS, { stop: ['Stop it too', 'Stop them too'], keep: ['Keep running'] });
    const prompt = systemPrompt({ scenario: parseScenario('# T\n'), issues: [] });
    assert.match(prompt, /jobs \{answer\}/);
    assert.match(prompt, /an interrupt \{after, do, jobs\?, text\?\}/);
    assert.match(prompt, /A wake request \(“Let @a wake @b\?”\) is a card/);
  });
});

describe('the Agents section, the Work ledger and the right pane (#105, #132, #146)', () => {
  const ids = (facts) => runChecks(facts).map((f) => f.check);
  const call = (id, name, input, extra = {}) => [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok', ...extra }] } },
  ];

  test('agents-section-members: every member has a row', () => {
    const f = base({ ui: { agentRows: ['researcher'] } });
    f.state.threads.t1.members = ['s1', 's2'];
    f.state.sessions.s2 = { id: 's2', handle: 'critic', state: 'idle' };
    assert.ok(ids(f).includes('agents-section-members'));
    f.ui.agentRows = ['researcher', 'critic'];
    assert.ok(!ids(f).includes('agents-section-members'));
  });

  test('topbar-title-cut: only when the page measured a cut', () => {
    assert.ok(ids(base({ ui: { topbarCut: true } })).includes('topbar-title-cut'));
    assert.ok(!ids(base({ ui: { topbarCut: false } })).includes('topbar-title-cut'));
  });

  test('work-files-match-stream and work-commands-match-stream compare the ledger with the turns’ tool calls', () => {
    const events = [...call('e1', 'Write', { file_path: '/w/conv.py' }), ...call('b1', 'Bash', { command: 'pytest' })];
    const f = base({ streams: [{ handle: 'researcher', started: 1, events }] });
    f.state.work = { t1: [] };
    assert.ok(ids(f).includes('work-files-match-stream'));
    assert.ok(ids(f).includes('work-commands-match-stream'));
    f.state.work.t1 = [
      { kind: 'file', path: '/w/conv.py' },
      { kind: 'command', toolUseId: 'b1' },
    ];
    assert.ok(!ids(f).includes('work-files-match-stream'));
    assert.ok(!ids(f).includes('work-commands-match-stream'));
  });

  test('quick-panel-takes-effect: the next turn runs the model picked', () => {
    const turn = (model) => ({ handle: 'critic', started: 20, events: [{ type: 'system', subtype: 'init', model }] });
    const panels = [{ handle: 'critic', set: { model: 'Sonnet 5.5' }, at: 10 }];
    assert.ok(ids(base({ probes: { fullScreen: [], attachments: [], panels }, streams: [turn('claude-opus-5-5')] })).includes('quick-panel-takes-effect'));
    assert.ok(!ids(base({ probes: { fullScreen: [], attachments: [], panels }, streams: [turn('claude-sonnet-5-5')] })).includes('quick-panel-takes-effect'));
  });

  test('shell-off-silent: a refused command after Shell went off must show as refused', () => {
    const events = call('b2', 'Bash', { command: 'pytest' }, { is_error: true, content: 'Permission denied' });
    const panels = [{ handle: 'critic', set: { shell: false }, at: 10 }];
    const f = base({ probes: { fullScreen: [], attachments: [], panels }, streams: [{ handle: 'critic', started: 20, events }] });
    assert.ok(ids(f).includes('shell-off-silent'));
    f.state.items.t1 = [{ id: 'd1', kind: 'denial', handle: 'critic', at: 25 }];
    assert.ok(!ids(f).includes('shell-off-silent'));
  });

  test('pane-split and fullscreen-keeps-draft read the probes the run took', () => {
    const probes = (panes, drafts) => ({ fullScreen: [], attachments: [], panes, drafts });
    assert.ok(ids(base({ probes: probes([{ work: { w: 440, h: 60 }, thread: { w: 440, h: 800 } }], []) })).includes('pane-split'));
    assert.ok(!ids(base({ probes: probes([{ work: { w: 440, h: 400 }, thread: { w: 440, h: 460 } }], []) })).includes('pane-split'));
    assert.ok(ids(base({ probes: probes([], [{ kept: false, draft: '', exited: true, before: 0, after: 0 }]) })).includes('fullscreen-keeps-draft'));
    assert.ok(
      !ids(base({ probes: probes([], [{ kept: true, exited: true, before: { top: 120, gap: 300 }, after: { top: 120, gap: 300 } }]) })).includes(
        'fullscreen-keeps-draft',
      ),
    );
    // At its end before and after, though the text re-wrapped: not moved.
    assert.ok(
      !ids(base({ probes: probes([], [{ kept: true, exited: true, before: { top: 481, gap: 0 }, after: { top: 276, gap: 0 } }]) })).includes(
        'fullscreen-keeps-draft',
      ),
    );
    // Read further up, and put back somewhere else: moved.
    assert.ok(
      ids(base({ probes: probes([], [{ kept: true, exited: true, before: { top: 120, gap: 300 }, after: { top: 40, gap: 380 } }]) })).includes(
        'fullscreen-keeps-draft',
      ),
    );
  });
});

test('a scenario that measures agent choices keeps the personas’ models', () => {
  const head = (extra) => `# T\n\n- agents: researcher\n${extra}\n\nSummary.\n\n## Phase 1: One\n\nDo it.`;
  assert.equal(parseScenario(head('- models: persona')).models, 'persona');
  assert.equal(parseScenario(head('')).models, 'run');
  for (const f of EXIT) assert.equal(parseScenario(readFileSync(new URL(`uat/e2e/scenarios/${f}.md`, import.meta.url), 'utf8')).models, 'persona', f);
});
