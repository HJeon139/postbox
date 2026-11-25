// #558's UAT pieces: the trigger that reads what an agent was told from its transcript, the runner's profile action
// against a stand-in page, and the scenario that is there to cause the trigger.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { saveProfile } from '../tools/uat/driver-profile.mjs';
import { parseScenario } from '../tools/uat/scenario.mjs';
import { TRIGGERS, unknownTriggers } from '../tools/uat/triggers.mjs';

const prompt = (/** @type {string} */ text, at = '2026-11-26T10:00:00.000Z') => ({ type: 'user', timestamp: at, message: { role: 'user', content: text } });
const NOTE =
  '[Postbox] About the person, from the profile they saved in Settings (not said in this conversation):\n- Name: Robin\n- Also written as: robin-example (github)';
const TURN = `[Postbox] 1 message for you in this room. Your reply posts there.\n\n[it_1] The person, 10:00 UTC: @developer hello\n\n${NOTE}`;

test('profile-told fires for each agent whose prompt carries the part about the person, and not before a profile is saved', () => {
  const { run, recorded } = TRIGGERS['profile-told'];
  const bare = { transcripts: [{ handle: 'developer', lines: [prompt('[it_1] The person, 10:00 UTC: @developer hello')] }] };
  assert.equal(recorded(bare), true);
  assert.deepEqual(run(bare), [], 'a run that never saved a profile fires nothing');
  // With no transcripts the run can’t say either way.
  assert.equal(recorded({ transcripts: [] }), false);
  const told = {
    transcripts: [
      { handle: 'developer', lines: [prompt('[it_0] The person, 09:59 UTC: before'), JSON.stringify(prompt(TURN))] },
      { handle: 'critic', lines: [prompt(TURN, '2026-11-26T10:01:00.000Z')] },
      // A tool result that quotes the words isn’t a prompt the agent was given.
      { handle: 'tester', lines: [{ type: 'user', timestamp: '2026-11-26T10:02:00.000Z', message: { content: [{ type: 'tool_result', content: NOTE }] } }] },
    ],
  };
  const hits = run(told);
  assert.deepEqual(
    hits.map((h) => h.evidence),
    [
      '@developer was told: “- Name: Robin - Also written as: robin-example (github)”.',
      '@critic was told: “- Name: Robin - Also written as: robin-example (github)”.',
    ],
  );
  assert.deepEqual(
    hits.map((h) => h.at),
    [Date.parse('2026-11-26T10:00:00.000Z'), Date.parse('2026-11-26T10:01:00.000Z')],
  );
});

test('profile-untold-before-save fires when the turns before the first save had no part about the person, whatever the agent answered', () => {
  const { run, recorded } = TRIGGERS['profile-untold-before-save'];
  const at = (/** @type {string} */ hhmm) => `2026-11-26T${hhmm}:00.000Z`;
  const saved = [{ at: Date.parse(at('10:05')) }, { at: Date.parse(at('10:20')) }];
  const before = prompt('[it_1] The person, 10:00 UTC: @developer what do you know about who I am?', at('10:00'));
  const after = prompt(TURN, at('10:06'));
  const f = { probes: { profiles: saved }, transcripts: [{ handle: 'developer', lines: [before, after] }] };
  assert.equal(recorded(f), true);
  assert.deepEqual(run(f), [{ at: Date.parse(at('10:00')), evidence: '1 turn to @developer before the first save, and none had a part about the person.' }]);
  // A turn before the save that did carry the part doesn’t fire: that is the defect it is there to catch.
  assert.deepEqual(run({ ...f, transcripts: [{ handle: 'developer', lines: [prompt(TURN, at('10:01')), after] }] }), []);
  // No turn before the save, or no save in the run, fires nothing; with no action recorded the run can’t say.
  assert.deepEqual(run({ ...f, transcripts: [{ handle: 'developer', lines: [after] }] }), []);
  assert.deepEqual(
    run({ probes: { profiles: [] }, transcripts: [{ handle: 'developer', lines: [before] }] }).length,
    1,
    'never saved: every turn is before a save',
  );
  assert.equal(recorded({ transcripts: f.transcripts, probes: {} }), false);
});

/** A page that holds the Profile tab’s fields, records what the driver does to it, and saves when Save is clicked. */
function standIn({ opens = true } = {}) {
  const fields = { 'pf-name': 'Robin Example', 'pf-aliases': '', 'pf-prefs': '', 'pf-tz': '', 'pf-pronouns': 'they/them' };
  const did = [];
  let focused = '';
  let told = 'Nothing yet: agents call you “the person”.';
  const kit = {
    ev: async (/** @type {string} */ expr) => {
      const id = expr.match(/getElementById\("([\w-]+)"\)/)?.[1] ?? '';
      if (expr.startsWith('!!')) return opens && id === 'pf-save';
      if (expr.includes("el.value = ''")) return void (fields[id] = '');
      if (expr.endsWith('.value')) return fields[id];
      if (id === 'pf-told') return told;
      throw new Error(`The stand-in page doesn’t answer ${expr}`);
    },
    clickAt: async (/** @type {string} */ expr, /** @type {string} */ what) => {
      did.push(what);
      focused = expr.match(/getElementById\("([\w-]+)"\)/)?.[1] ?? '';
      if (focused === 'pf-save')
        told = Object.entries(fields)
          .filter(([, v]) => v)
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');
    },
    press: async (/** @type {string} */ key) => void did.push(key),
    page: { send: async (/** @type {string} */ _method, /** @type {{ text: string }} */ { text }) => void (fields[focused] += text) },
  };
  return { kit, did, fields };
}

test('the profile action opens Settings on the profile, writes each fill over what the field held, saves, and says what agents are told', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { kit, did, fields } = standIn();
  const going = saveProfile(kit, [
    { field: 'Name', value: 'Robin' },
    { field: 'also written as', value: 'github: robin-example' },
    { field: 'Pronouns', value: '' },
  ]);
  for (let i = 0; i < 20; i++) {
    await new Promise((ok) => setImmediate(ok));
    t.mock.timers.tick(1000);
  }
  const r = await going;
  assert.deepEqual(did, ['the Settings button', 'the Name field', 'the also written as field', 'the Pronouns field', 'Save profile', 'Escape']);
  // Written over, not after, what was there; cleared where the fill is empty; untouched where there is no fill.
  assert.deepEqual(fields, { 'pf-name': 'Robin', 'pf-aliases': 'github: robin-example', 'pf-prefs': '', 'pf-tz': '', 'pf-pronouns': '' });
  assert.deepEqual(r.held, { name: 'Robin', 'also written as': 'github: robin-example', preferences: '', 'time zone': '', pronouns: '' });
  assert.equal(r.told, 'pf-name=Robin; pf-aliases=github: robin-example');
});

test('the profile action says so when the field isn’t one the tab has, or Settings didn’t open on the profile', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pump = async (/** @type {Promise<any>} */ p) => {
    const settled = p.then(
      () => null,
      (e) => e,
    );
    for (let i = 0; i < 60; i++) {
      await new Promise((ok) => setImmediate(ok));
      t.mock.timers.tick(1000);
    }
    return settled;
  };
  const wrong = await pump(saveProfile(standIn().kit, [{ field: 'Email', value: 'x' }]));
  assert.match(wrong?.message ?? '', /^The profile has no “Email” field\. It has: Name, Also written as, Preferences, Time zone, Pronouns\.$/);
  const shut = await pump(saveProfile(standIn({ opens: false }).kit, []));
  assert.match(shut?.message ?? '', /^Settings didn’t open on the Profile tab\.$/);
});

test('the profile scenario is there to cause the trigger, in the phase that saves one', () => {
  const s = parseScenario(readFileSync(new URL('uat/e2e/scenarios/profile.md', import.meta.url), 'utf8'));
  assert.deepEqual(unknownTriggers(s), []);
  assert.deepEqual(
    s.phases.map((p) => p.triggers ?? []),
    [['profile-untold-before-save'], ['profile-told'], []],
  );
  assert.deepEqual(s.agents, ['developer', 'critic']);
});
