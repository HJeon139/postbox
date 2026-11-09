// Forms of private data the privacy checker (tools/privacy-check.mjs) learned after tests/fixtures-privacy.test.mjs
// reached its length: each spec is a hostile input and the exact finding it makes. As there, every example is built
// at run time, so this file’s own text holds none and the tree test checks it like any other.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkContentPrivacy, checkFilePrivacy } from '../tools/privacy-check.mjs';

/** JSON text for an object, so a key isn’t written in quotes here. @param {object} value */
const json = (value) => JSON.stringify(value);

/** That JSON escaped inside another JSON string, as a recorded line holds it. @param {object} value */
const escaped = (value) => JSON.stringify({ line: JSON.stringify(value) });

/** A committed file’s text, by its path from the repository’s root. @param {string} path */
const committed = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

/** An init’s mcp_servers, holding one claude.ai connector of this name. @param {string} name */
const connectors = (name) => ({ mcp_servers: [{ name: `claude.ai ${name}`, status: 'needs-auth', source: 'claudeai' }] });

test('privacy checker flags a claude.ai connector a person named, but not one from the directory (#661)', () => {
  assert.deepEqual(checkContentPrivacy(json(connectors('Alice Trip Planner'))), ['connector name at line 1']);
  assert.deepEqual(checkContentPrivacy(escaped(connectors('Alice Trip Planner'))), ['connector name at line 1']);
  for (const name of ['Claude Docs', 'Gmail', 'Google Calendar', 'Google Drive']) {
    assert.deepEqual(checkContentPrivacy(json(connectors(name))), [], name);
  }
  const hostInit = 'tests/fixtures/claude-code/host-mcp-init.jsonl';
  assert.deepEqual(checkFilePrivacy(hostInit, committed(hostInit)), [], 'the directory’s names in a recorded init pass');
});

/** The recorded Claude Code turns whose init once listed a person’s own connector and synced plugin paths (#661). */
const CLEARED_INITS = ['denials', 'fail-before-output', 'resume-after-failure', 'thinking-subagent'];

/** The init a recorded Claude Code turn starts with. @param {string} name */
const recordedInit = (name) => JSON.parse(committed(`tests/fixtures/claude-code/${name}.jsonl`).split('\n', 1)[0]);

test('the recorded Claude Code inits list no MCP servers and no plugins (#661)', () => {
  for (const name of CLEARED_INITS) {
    const init = recordedInit(name);
    assert.equal(init.subtype, 'init', `${name} starts with its init`);
    assert.deepEqual({ mcp_servers: init.mcp_servers, plugins: init.plugins }, { mcp_servers: [], plugins: [] }, name);
  }
});

/**
 * The skills and slash commands Claude Code itself lists in an init, as the recorded inits name them. Any other name is
 * a plugin’s (“<plugin>:<skill>”) or a skill of a person’s own, and says what they installed (#661).
 */
const BUILT_IN_COMMANDS = new Set(
  [
    'deep-research design slides design-sync dataviz artifact-diagramming artifact-capabilities update-config verify',
    'debug code-review simplify batch fewer-permission-prompts doctor loop schedule claude-api workflow-authoring run',
    'run-skill-generator plugin-authoring advisor agents auto-mode-setup autocompact clear color compact config',
    'output-style context effort fast focus heapdump init mcp import model __remote-workflow workflow-launch-exec',
    'reload-plugins reload-skills rename ultrareview security-review usage-credits extra-usage usage insights recap',
    'skill-doctor goal design-consent design-revoke list-agents team-onboarding',
  ].flatMap((line) => line.split(' ')),
);

/** The agents Claude Code itself lists in an init. */
const BUILT_IN_AGENTS = new Set(['claude', 'claude-code-guide', 'Explore', 'general-purpose', 'Plan', 'statusline-setup']);

/** A tool id that names no one’s plugin: Claude Code’s own, Postbox’s, or a claude.ai directory connector’s. */
const GENERIC_TOOL = /^(?:[A-Z][A-Za-z]+|mcp__(?:postbox|claude_ai_Claude_Docs|claude_ai_Google_Drive)__[a-z_]+)$/;

test('the recorded Claude Code inits name no plugin, no skill of a person’s own and no plugin’s tool (#661)', () => {
  for (const name of CLEARED_INITS) {
    const init = recordedInit(name);
    const named = {
      commands: [...init.skills, ...init.slash_commands].filter((command) => !BUILT_IN_COMMANDS.has(command)),
      agents: init.agents.filter((agent) => !BUILT_IN_AGENTS.has(agent)),
      tools: init.tools.filter((tool) => !GENERIC_TOOL.test(tool)),
    };
    assert.deepEqual(named, { commands: [], agents: [], tools: [] }, name);
  }
});

test('privacy checker flags a Bearer token, but not the word in prose or a placeholder (#696)', () => {
  const tail = 'Ab3'.repeat(10);
  assert.deepEqual(checkContentPrivacy(`Authorization: Bearer ${tail}`), ['token at line 1']);
  assert.deepEqual(checkContentPrivacy(json({ headers: { authorization: `bearer ${tail}` } })), ['token at line 1'], 'in any case');
  assert.deepEqual(checkContentPrivacy(`Bearer ${'a'.repeat(20)}`), ['token at line 1'], 'a token at the shortest length');
  assert.equal(checkContentPrivacy(`Bearer ${'a'.repeat(19)}`).length, 0, 'one just short of it');
  assert.deepEqual(checkContentPrivacy(`Bearer ${['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxIn0', 'c2ln'].join('.')}`), ['token at line 1'], 'a JWT');
  for (const text of ['send a Bearer token in the header', 'Authorization: Bearer <token>', 'curl -H "Authorization: Bearer $TOKEN"']) {
    assert.deepEqual(checkContentPrivacy(text), [], text);
  }
});

test('privacy checker flags a uid field that isn’t all zeros, quoted or not, but not a uuid (#696)', () => {
  assert.deepEqual(checkContentPrivacy(json({ uid: 501 })), ['uid at line 1']);
  assert.deepEqual(checkContentPrivacy(json({ uid: '1000' })), ['uid at line 1'], 'a uid written as a string');
  assert.deepEqual(checkContentPrivacy(escaped({ uid: 501 })), ['uid at line 1'], 'escaped inside a line');
  assert.deepEqual(checkContentPrivacy(json({ uid: 0 })), [], 'root, or a scrubbed uid');
  assert.deepEqual(checkContentPrivacy(json({ uid: -1 })), [], 'no user ids on this system');
  assert.deepEqual(checkContentPrivacy(json({ uuid: '501' })), [], 'another key that ends in uid');
});

/** Account keys, built here, as each written bare before a “:” or “=” is itself flagged. */
const PLAN_TYPE = ['plan', 'Type'].join('');
const AUTH_MODE = ['auth', 'mode'].join('_');

test('privacy checker flags an account field written bare, in YAML, JavaScript or TOML (#696)', () => {
  assert.deepEqual(checkContentPrivacy(`${PLAN_TYPE}: pro`), ['account field at line 1'], 'YAML');
  assert.deepEqual(checkContentPrivacy(`{${PLAN_TYPE}:"pro"}`), ['account field at line 1'], 'a JavaScript object');
  assert.deepEqual(checkContentPrivacy(`${['plan', 'type'].join('_')} = "pro"`), ['account field at line 1'], 'TOML');
  assert.deepEqual(checkContentPrivacy(`[account]\n${AUTH_MODE}="chatgpt"`), ['account field at line 2'], 'TOML with no spaces');
  assert.deepEqual(checkContentPrivacy(json({ [PLAN_TYPE]: 'pro' })), ['account field at line 1'], 'quoted, as before');
  for (const text of [`the ${PLAN_TYPE} field`, `if (event.${PLAN_TYPE} === 'pro')`, `keys: ['${PLAN_TYPE}', 'x']`, `my${PLAN_TYPE}: 1`]) {
    assert.deepEqual(checkContentPrivacy(text), [], text);
  }
});

test('privacy checker flags a bare account key before “=” only where TOML puts a key, not in a code declaration (#696)', () => {
  assert.deepEqual(checkContentPrivacy(`[account]\n  ${AUTH_MODE} = "chatgpt"`), ['account field at line 2'], 'an indented TOML key');
  assert.deepEqual(checkContentPrivacy(`account = { ${AUTH_MODE} = "chatgpt" }`), ['account field at line 1'], 'a TOML inline table');
  assert.deepEqual(checkContentPrivacy(`account = { x = 1, ${AUTH_MODE} = "chatgpt" }`), ['account field at line 1'], 'after a comma');
  for (const text of [`const ${PLAN_TYPE} = account.plan;`, `let ${AUTH_MODE} = 'x';`, `this.${PLAN_TYPE} = value;`, `${PLAN_TYPE} == 'pro'`]) {
    assert.deepEqual(checkContentPrivacy(text), [], text);
  }
});

test('a recording’s placeholder home is allowed only in its own joined deltas, and only that home (#784)', () => {
  const delta = (part) => JSON.stringify({ type: 'stream_event', event: { index: 1, delta: { type: 'text_delta', text: part } }, api_message_id: 'm' });
  const split = (path) => [path.slice(0, 4), path.slice(4)].map(delta).join('\n');
  const allowedIn = 'tests/fixtures/claude-code/permission-allow.jsonl';
  assert.deepEqual(checkFilePrivacy(allowedIn, split(['', 'Users', 'postbox', 'x'].join('/'))), [], 'its made-up project folder');
  assert.deepEqual(checkFilePrivacy(allowedIn, split(['', 'Users', 'alice', 'x'].join('/'))), ['home path in the deltas joined from line 1']);
  assert.deepEqual(checkFilePrivacy('tests/fixtures/x.jsonl', split(['', 'Users', 'postbox', 'x'].join('/'))), ['home path in the deltas joined from line 1']);
});

test('a recording’s placeholder home is allowed in its joined deltas only as a home, not as another kind (#784)', () => {
  const delta = (part) => JSON.stringify({ type: 'stream_event', event: { index: 1, delta: { type: 'text_delta', text: part } }, api_message_id: 'm' });
  const named = json({ name: `claude.ai ${['Users', 'postbox'].join('/')}` }).slice(1, -1);
  const parts = [named.slice(0, 11), named.slice(11, 21), named.slice(21)];
  const allowedIn = 'tests/fixtures/claude-code/permission-allow.jsonl';
  assert.deepEqual(checkFilePrivacy(allowedIn, parts.map(delta).join('\n')), ['connector name in the deltas joined from line 1']);
});

test('an installation id of zeros with white space in it is the scrubbed placeholder', () => {
  assert.deepEqual(checkContentPrivacy(json({ installationId: '0000 0000' })), []);
  assert.deepEqual(checkContentPrivacy(json({ installationId: '0000 0001' })), ['installationId at line 1']);
});

/** A claude.ai connector’s tool id, as Claude Code names it: each character a server name can’t hold becomes “_”. */
const connectorTool = (name, tool = 'search') => `${connectorServer(name)}__${tool}`;

/** A claude.ai connector’s server, as a tool id or a permission rule names it, built here as the rule flags one. */
const connectorServer = (name) => ['mcp', `claude_ai_${name}`].join('__');

test('privacy checker flags the tool id of a claude.ai connector a person named, but not a directory connector’s (#905)', () => {
  assert.deepEqual(checkContentPrivacy(json({ tools: [connectorTool('Alice_Trip_Planner')] })), ['connector tool id at line 1']);
  assert.deepEqual(checkContentPrivacy(escaped({ tools: [connectorTool('Alice_Trip_Planner')] })), ['connector tool id at line 1'], 'escaped');
  assert.deepEqual(checkContentPrivacy(`allow ${connectorTool('Alice_Trip_Planner', '*')}`), ['connector tool id at line 1'], 'a rule for all its tools');
  const directory = [
    ['Box', 'upload_file'],
    ['Claude_Docs', 'read'],
    ['Gmail', 'send'],
    ['Google_Calendar', 'list_events'],
    ['Google_Drive', 'search_files'],
    ['Linear', 'create_issue'],
    ['Notion', 'notion-search'],
    ['Slack', 'slack_create_canvas'],
  ];
  for (const [name, tool] of directory) assert.deepEqual(checkContentPrivacy(json({ tools: [connectorTool(name, tool)] })), [], name);
  assert.deepEqual(checkContentPrivacy(`allow ${connectorTool('Gmail', '*')}`), [], 'a rule for all of a directory connector’s tools');
  assert.deepEqual(checkContentPrivacy(`deny ${connectorServer('Gmail')}`), [], 'a directory connector, by its server');
});

test('a tool id that only starts with a directory connector’s name, or differs in case, is flagged (#905)', () => {
  for (const id of [
    connectorTool('Google_Drive_Personal'),
    connectorTool('Gmail-Personal'),
    connectorTool('Gmail', '_Alice__send'),
    connectorTool('Gmail', 'send__Alice'),
    connectorTool('gmail'),
    connectorTool('Gmail', 'send_'),
    connectorServer('Gmailer'),
  ]) {
    assert.deepEqual(checkContentPrivacy(`tool ${id}`), ['connector tool id at line 1'], id);
  }
});

test('a hostile connector name in a tool id is flagged, and the finding holds no part of it (#905)', () => {
  const hostile = `Alice"<&\0${['', 'Users', 'alice', 'x'].join('/')}`;
  const found = checkContentPrivacy(`x\n${connectorTool(hostile)}`);
  assert.ok(found.includes('connector tool id at line 2'), found.join('; '));
  for (const finding of found) for (const part of ['Ali', 'lic', '"<&', 'Use']) assert.ok(!finding.includes(part), finding);
});

/**
 * The recordings beside the four above whose inits list plugins and connectors: Postbox’s host init, and the delivery
 * spike’s runs (#905).
 */
const DELIVERY_ROUTES = 'tests/fixtures/delivery-routes';
const RECORDINGS = [
  'tests/fixtures/claude-code/host-mcp-init.jsonl',
  ...readdirSync(new URL(`../${DELIVERY_ROUTES}`, import.meta.url))
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => `${DELIVERY_ROUTES}/${name}`),
];

/**
 * Plugins whose names are public: Anthropic’s own, from its public plugin marketplaces and claude.ai’s built-in skills,
 * and “sample”, the made-up plugin the tests name.
 */
const PUBLIC_PLUGINS = ['anthropic-skills', 'cowork-plugin-management', 'design', 'engineering', 'pdf-viewer', 'sample'];

/** claude.ai’s directory connectors (tools/privacy-check.mjs), as an init names their servers. */
const DIRECTORY = ['Claude Docs', 'Gmail', 'Google Calendar', 'Google Drive'];

/** MCP servers that name no one’s setup: Postbox’s, the recording’s made-up project server, and the scrubbed one. */
const PUBLIC_SERVERS = new Set(['postbox', 'probe', 'sanitized_mcp']);

/** Whether a name is a public plugin’s, by the prefix each kind of name puts before it. @param {string} name @param {(plugin: string) => string} prefix */
const ofPublicPlugin = (name, prefix) => PUBLIC_PLUGINS.some((plugin) => name.startsWith(prefix(plugin)));

/** How many names of each kind an init holds that aren’t on a public list, so a failure prints no name (#784). */
function privateNames(init) {
  const commands = [...(init.skills ?? []), ...(init.slash_commands ?? [])];
  const server = (name) =>
    PUBLIC_SERVERS.has(name) || DIRECTORY.some((connector) => name === `claude.ai ${connector}`) || ofPublicPlugin(name, (p) => `plugin:${p}:`);
  const tool = (name) =>
    /^[A-Z][A-Za-z]+$/.test(name) ||
    name.startsWith('mcp__postbox__') ||
    DIRECTORY.some((connector) => name.startsWith(`${connectorServer(connector.replaceAll(' ', '_'))}__`)) ||
    ofPublicPlugin(name, (p) => `mcp__plugin_${p}_`);
  return {
    servers: (init.mcp_servers ?? []).filter((entry) => !server(entry.name ?? entry)).length,
    plugins: (init.plugins ?? []).filter((plugin) => !PUBLIC_PLUGINS.includes(plugin.name ?? plugin)).length,
    commands: commands.filter((command) => !BUILT_IN_COMMANDS.has(command) && !ofPublicPlugin(command, (p) => `${p}:`)).length,
    agents: (init.agents ?? []).filter((agent) => !BUILT_IN_AGENTS.has(agent) && !ofPublicPlugin(agent, (p) => `${p}:`)).length,
    tools: (init.tools ?? []).filter((name) => !tool(name)).length,
  };
}

test('the other recorded Claude Code inits name only public plugins, connectors, skills and tools (#905)', () => {
  let inits = 0;
  for (const path of RECORDINGS) {
    committed(path)
      .split('\n')
      .forEach((line, i) => {
        if (!line.includes('"init"')) return;
        const event = JSON.parse(line);
        if (event.subtype !== 'init') return;
        inits++;
        assert.deepEqual(privateNames(event), { servers: 0, plugins: 0, commands: 0, agents: 0, tools: 0 }, `${path}:${i + 1}`);
      });
  }
  assert.equal(inits, 15, 'the recordings hold 15 inits');
});
