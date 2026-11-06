// Forms of private data the privacy checker (tools/privacy-check.mjs) learned after tests/fixtures-privacy.test.mjs
// reached its length: each spec is a hostile input and the exact finding it makes. As there, every example is built
// at run time, so this file’s own text holds none and the tree test checks it like any other.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.deepEqual(checkContentPrivacy(json(connectors('Alice Trip Planner'))), ['connector name: claude.ai Alice Trip Planner']);
  assert.deepEqual(checkContentPrivacy(escaped(connectors('Alice Trip Planner'))), ['connector name: claude.ai Alice Trip Planner']);
  for (const name of ['Claude Docs', 'Gmail', 'Google Calendar', 'Google Drive']) {
    assert.deepEqual(checkContentPrivacy(json(connectors(name))), [], name);
  }
  const hostInit = 'tests/fixtures/claude-code/host-mcp-init.jsonl';
  assert.deepEqual(checkFilePrivacy(hostInit, committed(hostInit)), [], 'the directory’s names in a recorded init pass');
});

/** The recorded Claude Code turns whose init once listed a person’s own connector and synced plugin paths (#661). */
const CLEARED_INITS = ['denials', 'fail-before-output', 'resume-after-failure', 'thinking-subagent'];

test('the recorded Claude Code inits list no MCP servers and no plugins (#661)', () => {
  for (const name of CLEARED_INITS) {
    const init = JSON.parse(committed(`tests/fixtures/claude-code/${name}.jsonl`).split('\n', 1)[0]);
    assert.equal(init.subtype, 'init', `${name} starts with its init`);
    assert.deepEqual({ mcp_servers: init.mcp_servers, plugins: init.plugins }, { mcp_servers: [], plugins: [] }, name);
  }
});
