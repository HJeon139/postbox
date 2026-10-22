import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
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
  assert.deepEqual(issuesOf(f), [63]);
  f.state.items.t1.push({ id: 'b', kind: 'block', turnId: 'u1', valid: true, block: { type: 'choice' } });
  assert.deepEqual(issuesOf(f), []);
});

test('the person’s output style, rules and missing MCP servers are #57 and #59', () => {
  const init = { type: 'system', subtype: 'init', output_style: 'Concise', mcp_servers: [{ name: 'postbox' }] };
  const f = base({
    streams: [{ handle: 'researcher', events: [init] }],
    transcripts: [{ handle: 'researcher', lines: ['… Draw every diagram as Mermaid …'] }],
    userRulesMarker: 'Draw every diagram as Mermaid',
    userMcpServers: ['search'],
  });
  assert.deepEqual(issuesOf(f).sort(), [57, 59]);
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

test('the scenarios parse into phases the tester works through', () => {
  for (const name of ['scifact', 'hotpotqa']) {
    const s = parseScenario(readFileSync(new URL(`uat/e2e/scenarios/${name}.md`, import.meta.url), 'utf8'));
    assert.equal(s.phases.length, 3, name);
    assert.deepEqual(s.agents, ['researcher']);
    assert.ok(s.persona.length > 40 && s.project && s.conversation, name);
  }
});
