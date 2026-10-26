// The allow-once scenario’s triggers (#238, tests/uat/e2e/scenarios/allowonce.md). The refusal cards are built the
// way server/permission-cards.mjs’s recordDenial builds them, with the real rulesFor. The streams have the shapes of
// recorded ones: init, Bash calls, tool_result and tool_result_meta’s permission_decision as the allowonce UAT run of
// 24 October 2026 recorded them in auto mode (Claude Code 2.1.308: { decision: 'accept', source: 'config',
// reason_type: 'classifier' } for each Bash call the classifier let through), and permission_denied with its
// decision_reason_type, a rejected permission_decision and the result’s permission_denials as
// tests/fixtures/claude-code/denials.jsonl recorded them for a mode’s and a chain’s refusal. No recorded stream has a
// refusal by the classifier yet, so that one is the same shapes with reason_type 'classifier'. The chained card’s text
// is app/js/permission-cards.mjs’s.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { rulesFor } from '../server/permission-rules.mjs';
import { bashCalls, FAKE_VALUE, seedFakeEnv, ALLOW_ONCE_TRIGGERS as T } from '../tools/uat/allowonce-triggers.mjs';
import { parseScenario, stepCap } from '../tools/uat/scenario.mjs';
import { TRIGGERS, triggersFired, unknownTriggers } from '../tools/uat/triggers.mjs';

const SINGLE = 'cat .env';
const CHAINED = 'cd sub && cat .env';
const ANSWERED = 1_800_000_000_000;
const folder = mkdtempSync(join(tmpdir(), 'postbox-allowonce-'));
after(() => rmSync(folder, { recursive: true, force: true }));

const card = (command, extra = {}) => ({
  id: `it_${command.length}`,
  kind: 'denial',
  handle: 'researcher',
  toolUseId: 'toolu_refused',
  tool: 'Bash',
  summary: `Run ${command}`,
  detail: command,
  reason: 'Credential Materialization',
  reasonType: 'classifier',
  rules: rulesFor('Bash', { command }),
  status: 'open',
  at: ANSWERED - 60_000,
  ...extra,
});
const BY_RULE = { decision: 'accept', source: 'config', reason_type: 'rule' };
const BY_CLASSIFIER = { decision: 'accept', source: 'config', reason_type: 'classifier' };
const OUTPUT = `API_TOKEN=${FAKE_VALUE}\n`;
/**
 * A turn’s stream: its init, one Bash call, a refusal if it had one, its result and how Claude Code decided it, and the
 * turn’s result. `refusedBy` refuses it with that reason type, as a permission_denied event and a rejected decision.
 */
const turn = ({
  id = 'toolu_retry',
  command = SINGLE,
  started = ANSWERED + 500,
  mode = 'auto',
  error = false,
  refusedBy = null,
  decision = BY_RULE,
  output = OUTPUT,
} = {}) => {
  const refused = refusedBy ? `Permission to use Bash with command ${command} has been denied.` : null;
  const meta = refusedBy
    ? { non_execution_kind: 'permission-rule', permission_decision: { decision: 'reject', source: 'config', reason_type: refusedBy } }
    : { permission_decision: decision };
  return {
    handle: 'researcher',
    started,
    events: [
      { type: 'system', subtype: 'init', permissionMode: mode },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } },
      ...(refusedBy
        ? [{ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: id, decision_reason_type: refusedBy, message: refused }]
        : []),
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: error || !!refusedBy, content: refused ?? (error ? 'Exit code 1' : output) }] },
        ...(refusedBy || decision ? { tool_result_meta: [{ id, ...meta }] } : {}),
      },
      { type: 'result', permission_denials: refusedBy ? [{ tool_use_id: id, tool_name: 'Bash' }] : [] },
    ],
  };
};
/** The refused call’s turn, before the answer. */
const refusal = (o = {}) => turn({ id: 'toolu_refused', started: ANSWERED - 90_000, refusedBy: 'classifier', ...o });
const facts = (items, { streams = [], ui } = {}) => ({
  threads: ['t1'],
  state: { items: { t1: items }, threads: { t1: { projectId: 'p1' } }, projects: { p1: { folder } } },
  streams,
  ...(ui ? { ui } : {}),
});

test('the first trigger is a refusal of one command by the classifier, on its card and in its stream, whose card offers its exact rule', () => {
  const run = (c, streams = [refusal()]) => T['classifier-refused-single'].run(facts([c], { streams }));
  assert.equal(run(card(SINGLE)).length, 1);
  assert.match(run(card(SINGLE))[0].evidence, /`Bash\(cat \.env\)`/);
  // The stream has to say the classifier refused it, by its permission_denied or its decision.
  assert.equal(run(card(SINGLE), [refusal({ refusedBy: null, decision: { decision: 'reject', source: 'config', reason_type: 'classifier' } })]).length, 1);
  // The recorded run: the classifier let the command through, so nothing was refused, whatever a card says.
  assert.deepEqual(run(card(SINGLE), [refusal({ refusedBy: null, decision: BY_CLASSIFIER })]), []);
  assert.deepEqual(run(card(SINGLE), []), []);
  // A deny rule or the mode refused it, on the card or in the stream: not what #238 is about.
  assert.deepEqual(run(card(SINGLE), [refusal({ refusedBy: 'mode' })]), []);
  assert.deepEqual(run(card(SINGLE, { reasonType: 'rule' })), []);
  assert.deepEqual(run(card(SINGLE, { reasonType: null })), []);
  // A chained command has no rule to allow once.
  assert.deepEqual(run(card(CHAINED), [refusal({ command: CHAINED })]), []);
  // Another agent’s call with the same id isn’t this card’s.
  assert.deepEqual(run(card(SINGLE), [{ ...refusal(), handle: 'critic' }]), []);
  assert.equal(T['classifier-refused-single'].recorded({ state: {} }), false);
});

test('the retry counts only after a classifier’s refusal, when the byte-identical command ran by the rule in auto mode and read the fake value', () => {
  const allowed = card(SINGLE, { status: 'allowed-once', answeredAt: ANSWERED });
  const run = (streams, c = allowed) => T['allow-once-retry-ran'].run(facts([c], { streams: [refusal({ command: c.detail }), ...streams] }));
  assert.equal(run([turn()]).length, 1);
  assert.match(run([turn()])[0].evidence, /byte for byte.*printed the fake value/);
  // A read of .env that didn’t print the seeded value didn’t read the scenario’s file.
  assert.deepEqual(run([turn({ output: 'API_TOKEN=\n' })]), []);
  // Refused again, failed, a byte different, before the answer, not in auto mode, or not allowed once: not the retry.
  assert.deepEqual(run([turn({ refusedBy: 'classifier' })]), []);
  assert.deepEqual(run([turn({ error: true })]), []);
  assert.deepEqual(run([turn({ command: `${SINGLE} ` })]), []);
  assert.deepEqual(run([turn({ started: ANSWERED - 1 })]), []);
  assert.deepEqual(run([turn({ mode: 'bypassPermissions' })]), []);
  assert.deepEqual(run([turn()], card(SINGLE, { status: 'left', answeredAt: ANSWERED })), []);
  // Let through by the classifier, maybe on the notice’s words, the rule wasn’t what ran it: not Allow once working.
  assert.deepEqual(run([turn({ decision: BY_CLASSIFIER })]), []);
  // A refusal the stream doesn’t pin on the classifier never tested #238, so its retry doesn’t count either.
  assert.deepEqual(T['allow-once-retry-ran'].run(facts([allowed], { streams: [refusal({ refusedBy: 'mode' }), turn()] })), []);
  assert.deepEqual(T['allow-once-retry-ran'].run(facts([allowed], { streams: [turn()] })), []);
  // A stream that doesn’t say how the retry was allowed can’t tell: not “never happened”.
  const tell = (streams) => triggersFired(facts([allowed], { streams: [refusal(), ...streams] }), ['allow-once-retry-ran'])['allow-once-retry-ran'];
  assert.equal(tell([turn({ decision: null })]), null);
  // A command that doesn’t read .env has nothing to compare, so its effect isn’t checked, and the evidence says so.
  const other = 'ls -a';
  assert.match(run([turn({ command: other, output: '.\n..\n' })], card(other, { status: 'allowed-once', answeredAt: ANSWERED }))[0].evidence, /wasn’t checked/);
  // The refused call itself isn’t its own retry.
  assert.deepEqual(T['allow-once-retry-ran'].run(facts([allowed], { streams: [refusal()] })), []);
});

test('bashCalls reads each Bash call’s command, mode, result, refusal and decision from a stream', () => {
  assert.deepEqual(bashCalls([refusal()]), [
    {
      handle: 'researcher',
      id: 'toolu_refused',
      command: SINGLE,
      started: ANSWERED - 90_000,
      mode: 'auto',
      result: { error: true, text: 'Permission to use Bash with command cat .env has been denied.' },
      denied: true,
      deniedBy: 'classifier',
      decision: { decision: 'reject', source: 'config', reason_type: 'classifier' },
    },
  ]);
});

test('the seed writes an obviously fake .env, and one in sub, inside the project folder only', () => {
  const project = mkdtempSync(join(folder, 'seed-'));
  seedFakeEnv(project);
  assert.deepEqual(readdirSync(project).sort(), ['.env', 'sub']);
  assert.deepEqual(readdirSync(join(project, 'sub')), ['.env']);
  for (const f of [join(project, '.env'), join(project, 'sub', '.env')]) assert.equal(readFileSync(f, 'utf8'), `API_TOKEN=${FAKE_VALUE}\n`);
  assert.equal(FAKE_VALUE, 'uat-not-a-secret');
  assert.equal(existsSync(join(folder, '.env')), false);
});

const CHAINED_TEXT =
  'Claude Code checks each part of a chained command (joined by &&, ||, ;, | or &) against its rules on its own, so no one rule can allow this whole line, and there’s nothing to allow once or always. To let it run, leave it and ask @researcher to run the parts as separate commands: a part that’s refused again gets a card of its own.';

test('the chained trigger needs the card on the page with no Allow once or Always allow, and saying why', () => {
  const c = card(CHAINED, { reasonType: 'subcommandResults' });
  assert.deepEqual(c.rules, { once: null, always: null, alwaysWords: '', why: 'chained' });
  const shown = (buttons, text = CHAINED_TEXT) =>
    facts([c], { ui: { denialCards: { [c.id]: { buttons, text: `${CHAINED}\nWhy: Credential Materialization\n${text}` } } } });
  assert.equal(T['chained-refusal-no-allow'].run(shown(['Leave it'])).length, 1);
  assert.match(T['chained-refusal-no-allow'].run(shown(['Leave it']))[0].evidence, /offered only “Leave it”/);
  assert.deepEqual(T['chained-refusal-no-allow'].run(shown(['Allow once and retry', 'Leave it'])), []);
  assert.deepEqual(T['chained-refusal-no-allow'].run(shown(['Leave it'], '')), []);
  // Answered already, so its buttons are gone: not what the person was offered.
  assert.deepEqual(T['chained-refusal-no-allow'].run(shown([])), []);
  // A single command’s card isn’t this, and a run that didn’t read the page can’t tell.
  assert.deepEqual(
    T['chained-refusal-no-allow'].run(facts([card(SINGLE)], { ui: { denialCards: { [card(SINGLE).id]: { buttons: ['Leave it'], text: CHAINED_TEXT } } } })),
    [],
  );
  assert.equal(T['chained-refusal-no-allow'].recorded(facts([c])), false);
});

test('the allow-once scenario is targeted, Claude only, seeds the fake .env, and names triggers that exist', () => {
  const s = parseScenario(readFileSync(new URL('uat/e2e/scenarios/allowonce.md', import.meta.url), 'utf8'));
  assert.deepEqual(unknownTriggers(s), []);
  assert.deepEqual(
    s.phases.map((p) => p.triggers),
    [['classifier-refused-single', 'allow-once-retry-ran'], ['chained-refusal-no-allow']],
  );
  assert.deepEqual(s.backends, {});
  assert.deepEqual(s.agents, ['researcher']);
  assert.equal(s.seed, 'fake-env');
  assert.equal(stepCap(s), 10);
  for (const id of ['classifier-refused-single', 'allow-once-retry-ran', 'chained-refusal-no-allow']) assert.equal(TRIGGERS[id].issue, 238);
  // What the classifier reads as intent: the person never names the file, a setting or its value, nor says it’s fake.
  assert.match(s.summary, /Never name the file/);
  assert.match(s.phases[0].text, /no `cd`, `&&`/);
  // Read, Grep and Glob read the project’s files in auto mode without the classifier, so only Bash can be refused.
  assert.match(s.phases[0].text, /only with Bash, not its Read, Grep or Glob tools/);
  // No refusal by the classifier, no Allow once: the tester reports the gap and stops.
  assert.match(s.phases[0].text, /don’t press Allow once/);
  assert.match(s.phases[1].text, /starts with `cd sub &&`/);
});
