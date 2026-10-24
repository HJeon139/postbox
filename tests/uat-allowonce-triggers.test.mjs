// The allow-once scenario’s triggers (#238, tests/uat/e2e/scenarios/allowonce.md). The refusal cards are built the
// way server/permission-cards.mjs’s recordDenial builds them, with the real rulesFor; the streams have the shapes of
// the recorded ones in tests/fixtures/claude-code/denials.jsonl (init, permission_denied, tool_result, result), and
// tool_result_meta’s permission_decision is as UAT runs recorded it in auto mode (reason_type 'rule' for a call an
// --allowedTools rule let through, 'classifier' for Bash the classifier let through); the
// chained card’s text is app/js/permission-cards.mjs’s; and the `.git/config` is what git 2.54 writes for `git init`
// and then `git remote add backup ./backup.git` (recorded 24 October 2026).

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { rulesFor } from '../server/permission-rules.mjs';
import { bashCalls, ALLOW_ONCE_TRIGGERS as T } from '../tools/uat/allowonce-triggers.mjs';
import { parseScenario, stepCap } from '../tools/uat/scenario.mjs';
import { TRIGGERS, triggersFired, unknownTriggers } from '../tools/uat/triggers.mjs';

const SINGLE = 'git remote add backup ./backup.git';
const CHAINED = 'cd sub && git remote add mirror ../mirror.git';
const ANSWERED = 1_800_000_000_000;
const folder = mkdtempSync(join(tmpdir(), 'postbox-allowonce-'));
after(() => rmSync(folder, { recursive: true, force: true }));
mkdirSync(join(folder, '.git'));
const CORE =
  '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n\tignorecase = true\n\tprecomposeunicode = true\n';
const REMOTE = '[remote "backup"]\n\turl = ./backup.git\n\tfetch = +refs/heads/*:refs/remotes/backup/*\n';
writeFileSync(join(folder, '.git', 'config'), CORE);

const card = (command, extra = {}) => ({
  id: `it_${command.length}`,
  kind: 'denial',
  handle: 'researcher',
  toolUseId: 'toolu_refused',
  tool: 'Bash',
  summary: `Run ${command}`,
  detail: command,
  reason: 'Remote Repoint',
  reasonType: 'classifier',
  rules: rulesFor('Bash', { command }),
  status: 'open',
  at: ANSWERED - 60_000,
  ...extra,
});
const BY_RULE = { decision: 'accept', source: 'config', reason_type: 'rule' };
/** A turn’s stream: its init, one Bash call, its result and how Claude Code decided it, and the turn’s result. */
const turn = ({ command = SINGLE, started = ANSWERED + 500, mode = 'auto', error = false, denied = false, decision = BY_RULE } = {}) => ({
  handle: 'researcher',
  started,
  events: [
    { type: 'system', subtype: 'init', permissionMode: mode },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_retry', name: 'Bash', input: { command } }] } },
    ...(denied ? [{ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'toolu_retry', decision_reason_type: 'classifier' }] : []),
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_retry', is_error: error || denied, content: error ? 'Exit code 3' : '' }] },
      ...(decision ? { tool_result_meta: [{ id: 'toolu_retry', permission_decision: decision }] } : {}),
    },
    { type: 'result', permission_denials: denied ? [{ tool_use_id: 'toolu_retry', tool_name: 'Bash' }] : [] },
  ],
});
const facts = (items, { streams = [], ui } = {}) => ({
  threads: ['t1'],
  state: { items: { t1: items }, threads: { t1: { projectId: 'p1' } }, projects: { p1: { folder } } },
  streams,
  ...(ui ? { ui } : {}),
});

test('the first trigger is a classifier’s refusal of one command whose card offers its exact rule; another refusal isn’t', () => {
  assert.equal(T['classifier-refused-single'].run(facts([card(SINGLE)])).length, 1);
  assert.match(T['classifier-refused-single'].run(facts([card(SINGLE)]))[0].evidence, /`Bash\(git remote add backup \.\/backup\.git\)`/);
  // A deny rule or the mode refused it: not what #238 is about.
  assert.deepEqual(T['classifier-refused-single'].run(facts([card(SINGLE, { reasonType: 'rule' })])), []);
  assert.deepEqual(T['classifier-refused-single'].run(facts([card(SINGLE, { reasonType: null })])), []);
  // A chained command has no rule to allow once.
  assert.deepEqual(T['classifier-refused-single'].run(facts([card(CHAINED)])), []);
});

test('the retry counts only when the byte-identical command ran after Allow once, by the rule in auto mode, and added the remote', () => {
  const allowed = card(SINGLE, { status: 'allowed-once', answeredAt: ANSWERED });
  const run = (streams, c = allowed) => T['allow-once-retry-ran'].run(facts([c], { streams }));
  // Before the command really ran, the folder has no such remote, so even a clean-looking stream isn’t enough.
  assert.deepEqual(run([turn()]), []);
  writeFileSync(join(folder, '.git', 'config'), CORE + REMOTE);
  assert.equal(run([turn()]).length, 1);
  assert.match(run([turn()])[0].evidence, /byte for byte.*\.git\/config has the remote/);
  // Refused again, failed, a byte different, before the answer, not in auto mode, or not allowed once: not the retry.
  assert.deepEqual(run([turn({ denied: true })]), []);
  assert.deepEqual(run([turn({ error: true })]), []);
  assert.deepEqual(run([turn({ command: `${SINGLE} ` })]), []);
  assert.deepEqual(run([turn({ started: ANSWERED - 1 })]), []);
  assert.deepEqual(run([turn({ mode: 'bypassPermissions' })]), []);
  assert.deepEqual(run([turn()], card(SINGLE, { status: 'left', answeredAt: ANSWERED })), []);
  // Let through by the classifier, maybe on the notice’s words, the rule wasn’t what ran it: not Allow once working.
  assert.deepEqual(run([turn({ decision: { decision: 'accept', source: 'config', reason_type: 'classifier' } })]), []);
  // A stream that doesn’t say how, or a project folder the run can’t read, can’t tell: not “never happened”.
  const tell = (streams, f = facts([allowed], { streams })) => triggersFired(f, ['allow-once-retry-ran'])['allow-once-retry-ran'];
  assert.equal(tell([turn({ decision: null })]), null);
  assert.equal(
    tell([turn()], { ...facts([allowed], { streams: [turn()] }), state: { ...facts([allowed]).state, projects: { p1: { folder: join(folder, 'gone') } } } }),
    null,
  );
  // git remote add’s options, with and without a value, don’t shift the name and url.
  const tracked = 'git remote add -t main -f backup ./backup.git';
  assert.equal(run([turn({ command: tracked })], card(tracked, { status: 'allowed-once', answeredAt: ANSWERED })).length, 1);
  // The refused call itself isn’t its own retry.
  assert.deepEqual(run([turn()], { ...allowed, toolUseId: 'toolu_retry' }), []);
  // A remote the config doesn’t have, under a name the command gave, isn’t its change.
  const other = 'git remote add spare ./spare.git';
  assert.deepEqual(run([turn({ command: other })], card(other, { status: 'allowed-once', answeredAt: ANSWERED })), []);
});

test('bashCalls reads each Bash call’s command, mode, result and refusal from a stream', () => {
  assert.deepEqual(bashCalls([turn({ denied: true, decision: { decision: 'reject', source: 'config', reason_type: 'classifier' } })]), [
    {
      handle: 'researcher',
      id: 'toolu_retry',
      command: SINGLE,
      started: ANSWERED + 500,
      mode: 'auto',
      result: { error: true, text: '' },
      denied: true,
      decision: { decision: 'reject', source: 'config', reason_type: 'classifier' },
    },
  ]);
});

const CHAINED_TEXT =
  'Claude Code checks each part of a chained command (joined by &&, ||, ;, | or &, or inside $( )) against its rules on its own, so no one rule can allow this whole line, and there’s nothing to allow once or always. To let it run, leave it and ask @researcher to run the parts as separate commands: a part that’s refused again gets a card of its own.';

test('the chained trigger needs the card on the page with no Allow once or Always allow, and saying why', () => {
  const c = card(CHAINED, { reasonType: 'subcommandResults' });
  assert.deepEqual(c.rules, { once: null, always: null, alwaysWords: '' });
  const shown = (buttons, text = CHAINED_TEXT) =>
    facts([c], { ui: { denialCards: { [c.id]: { buttons, text: `${CHAINED}\nWhy: Remote Repoint\n${text}` } } } });
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

test('the allow-once scenario is targeted, Claude only, and names triggers that exist', () => {
  const s = parseScenario(readFileSync(new URL('uat/e2e/scenarios/allowonce.md', import.meta.url), 'utf8'));
  assert.deepEqual(unknownTriggers(s), []);
  assert.deepEqual(
    s.phases.map((p) => p.triggers),
    [['classifier-refused-single', 'allow-once-retry-ran'], ['chained-refusal-no-allow']],
  );
  assert.deepEqual(s.backends, {});
  assert.deepEqual(s.agents, ['researcher']);
  assert.equal(stepCap(s), 10);
  for (const id of ['classifier-refused-single', 'allow-once-retry-ran', 'chained-refusal-no-allow']) assert.equal(TRIGGERS[id].issue, 238);
  // What the classifier reads as intent: the person never names the remote, so the refusal isn’t cleared by them.
  assert.match(s.summary, /Never name a remote/);
  assert.match(s.phases[0].text, /no `cd`, `&&`/);
  assert.match(s.phases[1].text, /starts with `cd sub &&`/);
});
