// The agent guide (#63): what a reply contains decides its form, before anything else, and it stays short.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { agyRules } from '../server/adapters/antigravity-cli.mjs';
import { agentGuide, guideText, turnFacts } from '../server/adapters/guide.mjs';
import { freshInstall } from '../server/seed.mjs';
import { TOOL_DEFS } from '../shared/mcp-tools.mjs';

test('#131: the guide says to check a setup before blaming it, and to rerun only what just reads or checks', () => {
  const g = agentGuide({
    persona: { handle: 'developer', backend: 'claude-code' },
    session: {},
    handles: ['developer'],
  });
  assert.match(g, /Your own model calls work, so don’t ask the person to change their setup or credentials on a hunch/);
  assert.match(g, /Compare the failing command with a working one that changes one thing/);
  assert.match(g, /rerun it yourself only if it just reads or checks something, and otherwise ask first/);
  assert.match(g, /If you can’t confirm the cause, say it’s a guess/);
  // agy’s rules file has no room for it, nor its turn for the session’s facts.
  assert.doesNotMatch(agentGuide({ persona: { handle: 'developer' }, handles: ['developer'], setup: false }), /Before blaming the setup|Your session/);
  assert.doesNotMatch(turnFacts({ persona: { handle: 'developer' }, handles: ['developer'], setup: false }), /Your session/);
});

// What the session runs on changes during a room, so each turn’s message says it, not the system prompt (#515).
test('#131: the turn says what this session runs on, and not that another command does', () => {
  const persona = { handle: 'developer', backend: 'claude-code', model: 'claude-opus-5-5', effort: 'medium' };
  const answered = turnFacts({
    persona,
    session: { lastModel: 'claude-sonnet-5-5', lastEffort: 'high' },
    handles: ['developer'],
  });
  assert.match(
    answered,
    /Your last turn ran on Claude Code · claude-sonnet-5-5 · not the model you set: claude-opus-5-5 · high effort on the last turn, set to medium/,
  );
  assert.match(answered, /That’s this session; a command you run may use other settings/);
  const unrun = turnFacts({ persona, session: {}, handles: ['developer'] });
  assert.match(unrun, /Postbox has you set to Claude Code · claude-opus-5-5 · medium effort, and hasn’t recorded an answered turn yet/);
});

test('the guide starts from what a reply contains, not from what the person asked for', () => {
  const g = guideText();
  const first = g.split('\n## ')[0];
  assert.match(first, /^## What your reply contains decides its form/);
  assert.match(first, /whether or not the person asked for a block/);
  for (const [contains, block] of [
    ['Options to pick from', 'a choice'],
    ['Questions for the person', 'a form'],
    ['A draft to approve', 'a review block'],
    ['A job of several steps that takes minutes', 'a progress block'],
  ])
    assert.match(first, new RegExp(`^- ${contains}[^\\n]*→ ${block}`, 'm'), `${contains} → ${block}`);
  // The old wording matched requests (“To ask for a line-by-line review…”), which agents read as “when asked”.
  assert.doesNotMatch(g, /To ask for a/);
});

test('#673 agents are no longer told to choose a choice block’s display', () => {
  assert.doesNotMatch(guideText(), /display\?:/);
  assert.doesNotMatch(readFileSync(new URL('../README.md', import.meta.url), 'utf8'), /display\?:/);
});

test('the guide tells agents to report results, and to update an answered block only to ask again (#94)', () => {
  const g = guideText();
  assert.match(g, /Report what you did in your reply, or with update_block on the answered block with outcome set/);
  assert.match(g, /Update an answered block without outcome only to ask again/);
});

test('what agents read about the app check says narrow and wide windows, not phones (#75)', () => {
  const read = [
    agentGuide({ persona: { handle: 'a' } }),
    turnFacts({ persona: { handle: 'a' }, handles: ['a'], project: { name: 'P' }, brief: 'You were asked in.' }),
    ...TOOL_DEFS.map((t) => t.description),
    readFileSync(new URL('../app/js/apps.mjs', import.meta.url), 'utf8'),
  ].join('\n');
  assert.doesNotMatch(read, /\bphones?\b/i);
  assert.match(read, /checks it in a narrow and a wide window \(375 and 1280 px\)/);
  assert.match(read, /This conversation belongs to the project “P”\./);
});

test('the guide stays short: agents follow defaults more than prose', () => {
  // About 8,300 characters before M1 core, which added the limits, palettes and outcome. Cut before adding.
  assert.ok(guideText().length <= 9250, `The guide is ${guideText().length} characters. Keep it under 9,250.`);
  // It’s the same text on every turn.
  const who = { persona: { handle: 'a' }, handles: ['a', 'b'] };
  assert.equal(agentGuide(who), agentGuide(who));
});

test('#1684 the guide tells an agent an app’s animation loop stops at rest, with fixed-size history, before it ships one', () => {
  assert.match(guideText(), /Stop loops when nothing moves; cap their history\./);
});

test('#1478 the guide names postbox.publish, so agents learn an app can share its data, and read_app reads it', () => {
  assert.match(guideText(), /^- postbox\.publish\(data\) shares the app’s data with you, no turn; read_app reads it$/m);
});

test('#855 the guide names postbox.anchors, so an app shown for review names the parts to comment on', () => {
  assert.match(guideText(), /or appId \(parts: postbox\.anchors\(\{ name: el \}\)\), previous\?/);
});

test('an agent is told which tools are turned off for it, and how to ask for one, not that the computer lacks them (#104)', () => {
  const who = { persona: { handle: 'critic', tools: ['web.fetch'] }, handles: ['critic'] };
  const g = turnFacts(who);
  assert.match(g, /## Turned off for you/);
  assert.match(g, /running commands \(shell\)/);
  assert.match(g, /messaging, scheduling or starting agents outside Postbox \(agents\.outside\)/);
  assert.doesNotMatch(g, /fetching web pages or searching the web \(web\.fetch\)/);
  assert.match(g, /don’t say the computer or the person lacks it: call ask_for_tool \{ tool: "shell"/);
  assert.ok(TOOL_DEFS.some((t) => t.name === 'ask_for_tool'));
  // Nothing off, nothing said; a backend that can’t turn tools off (Codex, agy) passes no rules.
  assert.doesNotMatch(turnFacts({ ...who, persona: { handle: 'critic', tools: ['shell', 'web.fetch', 'agents.outside'] } }), /Turned off for you/);
  assert.doesNotMatch(turnFacts({ ...who, toolRules: null }), /Turned off for you/);
  // The Kiro CLI turns off only what it has rules for.
  assert.doesNotMatch(turnFacts({ ...who, toolRules: { shell: ['shell'], 'web.fetch': ['web_fetch'] } }), /agents\.outside/);
});

test('a write outside the conversation is shown as a draft in a review block first, through any tool (#112)', () => {
  const first = guideText().split('\n## ')[0];
  assert.match(first, /^- A write outside this conversation \(a document, an issue, a message, through any tool\) → first its draft in a review block/m);
  assert.match(first, /unless they said to publish directly/);
});

test('the room tells an agent who else is in the conversation and what each does, and how to share the work', () => {
  const room = [
    { handle: 'researcher', role: 'Finds and reads sources.' },
    { handle: 'critic', role: 'Reviews code and documents.' },
  ];
  const g = turnFacts({ persona: { handle: 'developer' }, handles: ['researcher', 'developer', 'critic', 'indexer'], room });
  assert.match(g, /## In this conversation\n\n- @researcher: Finds and reads sources\.\n- @critic: Reviews code and documents\./);
  assert.match(g, /Of a request, take the part that’s yours/);
  // The catch-up is context: a message the person sent to another agent is that agent’s to answer.
  assert.match(g, /Your task is this turn’s request and anything that @-mentions you; what else happened since your last turn is context\./);
  assert.match(g, /A message the person sent to another agent is that agent’s, unless it asks for you too\./);
  assert.match(g, /To hand work on, @mention the agent with what it needs to start/);
  // Agents elsewhere in Postbox are listed apart, without the ones already here.
  assert.match(g, /Other agents in Postbox: @indexer\./);
  // Alone in its conversation, an agent gets no team section, only who it could bring in.
  const alone = turnFacts({ persona: { handle: 'developer' }, handles: ['developer', 'critic'] });
  assert.doesNotMatch(alone, /In this conversation|take the part/);
  assert.match(alone, /Agents in Postbox: @critic\. Mention one with @handle/);
  // The persona’s own prompt names no other agent: the team comes from the room.
  for (const p of freshInstall().personas) assert.doesNotMatch(p.instructions, /@(?:researcher|developer|critic)\b/, p.handle);
});

// Antigravity reads its rules file up to 12,000 characters (antigravity.google/docs/rules). A busy room’s fits, without
// the session and setup sections (#131), which would take it to about 12,300.
test('agy’s rules file for a busy room stays within its 12,000 characters', () => {
  const persona = { handle: 'researcher', tools: ['shell', 'web.fetch', 'agents.outside'], canPublish: false };
  const role = 'Finds sources, checks claims against the corpus, and writes short summaries with citations for the room.';
  const room = ['critic', 'developer', 'analyst'].map((handle) => ({ handle, role }));
  const brief = '@critic asked you to join to check the retrieval numbers in the review block, and to say what the corpus supports.';
  const guide = agentGuide({
    persona,
    handles: ['researcher', ...room.map((r) => r.handle)],
    room,
    project: { name: 'A project with a long descriptive name' },
    brief,
    toolRules: null,
    setup: false,
  });
  assert.ok(agyRules({ persona, guide, schemas: '/Users/someone/.gemini/antigravity/mcp/postbox' }).length <= 12000);
});

// Codex agents drifted to unstructured replies and hand-offs with the spaces left out, so they’re told how to write; no
// other backend was seen doing it, so no other backend’s guide carries it. wake_agent is gone, so it names no tool for it.
test('a Codex agent’s guide says how to write, hand-offs included, and names no wake_agent', () => {
  const g = agentGuide({ persona: { handle: 'gpt', backend: 'codex' }, session: {}, handles: ['gpt'] });
  assert.match(g, /## How you write here\n\nEverything you send is read in the conversation as Markdown\. Write it as you would for a person/);
  assert.match(g, /Don’t compress or abbreviate a hand-off to save room/);
  assert.doesNotMatch(g, /wake_agent/);
  assert.match(g, /a blank line before every list, and a space between all words/);
  for (const backend of ['claude-code', 'kiro-cli', 'antigravity-cli'])
    assert.doesNotMatch(agentGuide({ persona: { handle: 'x', backend }, handles: ['x'] }), /How you write here/, backend);
  assert.doesNotMatch(agentGuide({ persona: { handle: 'gem' }, handles: ['gem'], setup: false }), /How you write here/);
});

// A reply wakes its waker only by an @-mention (#372), so the guide says when to mention: too often loops, never stalls.
test('#372 a room’s guide says to @mention an agent only when it must act next, and to name it without @ otherwise', () => {
  const g = turnFacts({ persona: { handle: 'alpha' }, handles: ['alpha', 'beta'], room: [{ handle: 'beta', role: 'Reviews' }] });
  assert.match(g, /@mention one only when it must act next \(a hand-off, a question, a review\); else write its name without @\./);
  assert.doesNotMatch(guideText(), /side thread/i);
  assert.doesNotMatch(TOOL_DEFS.find((d) => d.name === 'open_topic').description, /side thread/);
});

// An agent may open a thread for a review or a design check (#382), while hand-offs stay in the conversation. When to
// post the thread’s outcome is bring_to_conversation’s description, which only a turn in a thread is offered.
test('#382 the guide says when to open a topic thread and that hand-offs stay in the conversation', () => {
  assert.match(guideText(), /^- Review a PR or design in a topic \(open_topic\); hand-offs stay in the conversation\.$/m);
  assert.doesNotMatch(guideText(), /bring_to_conversation/);
  assert.match(TOOL_DEFS.find((d) => d.name === 'bring_to_conversation').description, /the topic thread’s outcome once its work is done/);
});

// An agent ended turns promising results that “will follow”, and nothing woke it when they did: Postbox wakes an agent
// only for a message, a mention or a wake it scheduled. Codex agents are told so (the habit was Codex’s); other backends aren’t.
test('a Codex agent’s guide says its turn ends when it replies, to finish a check first, or to schedule_wake', () => {
  const g = agentGuide({ persona: { handle: 'gpt', backend: 'codex' }, session: {}, handles: ['gpt'] });
  assert.match(g, /## When your turn ends\n\nYour turn ends when you reply\./);
  assert.match(g, /don’t end with “results will follow”\. If something must outlive your turn, call schedule_wake/);
  assert.doesNotMatch(agentGuide({ persona: { handle: 'gem' }, handles: ['gem'], setup: false }), /When your turn ends/);
  // Only Codex agents ended turns that way, so the other backends aren’t told.
  for (const backend of ['claude-code', 'kiro-cli', 'antigravity-cli'])
    assert.doesNotMatch(agentGuide({ persona: { handle: 'x', backend }, handles: ['x'] }), /When your turn ends/, backend);
});

test('#838 the guide shows an option’s shape for a choice and a form’s select, description and all', () => {
  const g = guideText();
  assert.match(g, /- choice: options \[\{ id, label, description\? \(up to 200 characters, shown under the label\) \}\] \(1–\d+\)/);
  assert.match(g, /options\? \[\{ id, label, description\? \}\] \(select only, up to \d+\)/);
});

test('#971 the guide says a choice is a seg or chips with aria-pressed, not btns toggling ghost, and at most one btn primary', () => {
  const g = guideText();
  assert.match(g, /Postbox’s classes btn \(sm, primary, ghost\), seg, chip,/);
  assert.match(g, /Pick one of a few options with a seg or chips \(aria-pressed\), not btns toggling ghost\./);
  assert.match(g, /At most one btn primary; ghost only for a minor action in text; links only for reading\./);
});

test('#995 the guide gives assets.search’s whole result, as apps filter by it, and no corpus is left in it (#516)', () => {
  const line = guideText()
    .split('\n')
    .find((l) => l.includes('"assets.search" with'));
  assert.match(line ?? '', /returns passages \[\{ id, asset, name, version, where, text, lexical: \{ score, terms \} \| null, semantic: number \| null \}\]/);
  assert.doesNotMatch(guideText(), /corpus\.|add_dataset|\.postbox\/datasets/);
});

test('#203 the guide asks for option descriptions that start with what the person gets, each listed in the fallback', () => {
  const choice = guideText()
    .split('\n')
    .find((l) => l.startsWith('- Options to pick from'));
  assert.match(choice ?? '', /If options make different things, start each description with what the person gets/);
  assert.match(choice ?? '', /and list each in the fallback/);
});

test('#1712 the guide keeps an agent’s notes for itself out of a folder’s AGENTS.md and CLAUDE.md, which every agent there reads', () => {
  assert.match(guideText(), /^- Keep your notes out of AGENTS\.md and CLAUDE\.md: every agent in the folder reads them\.$/m);
  assert.match(guideText(), /^- Writing @handle wakes that agent; to name one, omit @\.$/m, 'the line it sits beside stays');
});

test('#102 the guide says to define anything a reader can’t decode on sight, such as a citation, when first used', () => {
  assert.match(guideText(), /^- define_term anything a reader can’t decode on sight, such as R:31 or an abbreviation, when you first use it\.$/m);
});
