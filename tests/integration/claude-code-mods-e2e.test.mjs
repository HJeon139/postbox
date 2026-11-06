// #817 end to end: a PreToolUse hook that approves every call, in the person’s user settings and the project’s, with
// `disableAllHooks: false` in both, doesn’t run in a Postbox turn in Auto, so a push waits on the permission card. One
// real turn through each real adapter (the Claude Code CLI and the Agent SDK) asks for `git push origin
// HEAD:refs/heads/e2e`; the test answers the card no, and checks the branch never reached the remote and neither hook
// ran. A control turn through each adapter in Run everything, where Postbox keeps the person’s hooks, shows the
// fixture’s hooks do run.
//
// It runs real model turns, which cost money, so it runs only with POSTBOX_E2E_CLAUDE=1 and a `claude` on PATH. It
// lives in tests/integration/, which `npm run check` runs (its test:integration stage): there every test here is
// skipped unless POSTBOX_E2E_CLAUDE=1 is set, and with it set, every `npm run check` pays for these turns. `npm test`
// doesn’t run it. HOME is a temp folder for the turns, so the person’s own settings never load: the model must be
// reachable without them, through ANTHROPIC_API_KEY or Bedrock (AWS_CONFIG_FILE and AWS_SHARED_CREDENTIALS_FILE are
// pointed at the person’s own files when unset; the test never reads them), plus an allowlist of the person’s user
// settings (reachModel). A sign-in kept in ~/.claude doesn’t carry over.
//
// The fixture’s folder is removed when the file ends (tempDir), and on Ctrl-C or SIGTERM (onKill). A run killed with
// SIGKILL leaves it in the temp folder; under `npm run check` that’s the run’s own folder, which the next run sweeps
// (tools/gate-tmp.mjs). It holds no secret either way: reachModel copies none.
//
// The push names a refspec, so request-floor.mjs refuses it before the write judge: no Haiku call, whatever the
// message says (write-intent.mjs, requestedCall).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { loadAgentSdk } from '../../server/adapters/agent-sdk.mjs';
import { findClaude } from '../../server/adapters/claude-code.mjs';
import { start } from '../../server/index.mjs';
import { freePort } from '../process/chrome.mjs';
import { removeTempDirs, tempDir } from '../temp-dirs.mjs';

const MODEL = 'claude-haiku-5-5';
const TURN_MS = 240_000;
const PROMPT = 'Run this exact command with your Bash tool, once, and then tell me what it printed: git push origin HEAD:refs/heads/e2e';

const onPath = (bin) => (process.env.PATH ?? '').split(delimiter).some((dir) => dir && existsSync(join(dir, bin)));
/** Why the tests skip, or false when they run. */
function skipReason() {
  if (process.env.POSTBOX_E2E_CLAUDE !== '1') return 'set POSTBOX_E2E_CLAUDE=1 to run it: it runs real model turns, which cost money';
  if (!onPath('claude')) return 'no `claude` on PATH';
  return false;
}
const why = skipReason();
const sdkWhy = why || ((await loadAgentSdk()) ? false : '@anthropic-ai/claude-agent-sdk isn’t installed');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Postbox e2e', '-c', 'user.email=e2e@example.com', ...args], { cwd, stdio: 'pipe' });

// How the person's Claude Code reaches the model, and nothing else, copied from their user settings: the Agent SDK's
// own bundled Claude Code doesn't get the setup a wrapper on PATH adds, so without these its turn on Bedrock never
// answers (two runs on 6 Nov waited out the 240 s with nothing in the room). Only an allowlist is copied, so no secret
// lands in the fixture, and nothing that changes what's tested (CLAUDE_CONFIG_DIR would move the user settings away
// from the fixture's HOME, so the user hook would never load and its check would pass on no evidence). The top-level
// keys name commands (a credential export, an auth refresh, a key helper) that the person's own claude already runs;
// the turn runs them the same way. Hooks, permissions and anything named like a key, secret or token never are.
const MODEL_ENV =
  /^(AWS_REGION|AWS_PROFILE|AWS_DEFAULT_REGION|CLAUDE_CODE_USE_BEDROCK|ANTHROPIC_MODEL|ANTHROPIC_SMALL_FAST_MODEL|ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL|ANTHROPIC_BEDROCK_BASE_URL)$/;
const MODEL_KEYS = ['awsCredentialExport', 'awsAuthRefresh', 'modelOverrides', 'apiKeyHelper'];
// ANTHROPIC_DEFAULT_*_MODEL could still name one (ANTHROPIC_DEFAULT_API_KEY_MODEL), so the name is checked too.
const secretish = (/** @type {string} */ k) => /KEY|SECRET|TOKEN/i.test(k);
/** The allowlisted model settings of `mine`, the person's user settings. @param {any} mine */
function modelSettings(mine) {
  if (!mine || typeof mine !== 'object') return {};
  const out = Object.fromEntries(MODEL_KEYS.filter((k) => mine[k] !== undefined).map((k) => [k, mine[k]]));
  const env =
    mine.env && typeof mine.env === 'object' ? Object.entries(mine.env).filter(([k, v]) => MODEL_ENV.test(k) && !secretish(k) && typeof v === 'string') : [];
  if (env.length) out.env = Object.fromEntries(env);
  return out;
}
function reachModel() {
  try {
    return modelSettings(JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8')));
  } catch {
    return {}; // no user settings, or not JSON: the model must be reachable from the environment alone
  }
}

// Ctrl-C or SIGTERM mid-turn: remove the fixture folders, then end as the signal would have.
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM']))
  process.once(signal, () => {
    removeTempDirs();
    process.kill(process.pid, signal);
  });

/**
 * A temp HOME and a project with the same approving hook in its user and project settings, each touching a marker of
 * its own; the project is a git repository whose origin is a local bare repository.
 */
async function fixture() {
  const root = tempDir('pb-e2e-817-');
  const home = join(root, 'home');
  const work = join(root, 'work');
  const bare = join(root, 'bare.git');
  const markers = { user: join(root, 'user-hook-ran'), project: join(root, 'project-hook-ran') };
  const allow = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } });
  const settings = (marker) => ({
    disableAllHooks: false,
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `touch '${marker}' && printf '%s\\n' '${allow}'` }] }] },
  });
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(work, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ ...reachModel(), ...settings(markers.user) }));
  await writeFile(join(work, '.claude', 'settings.json'), JSON.stringify(settings(markers.project)));
  git(root, 'init', '-q', '--bare', bare);
  git(work, 'init', '-q');
  await writeFile(join(work, 'README.md'), 'e2e\n');
  git(work, 'add', 'README.md', '.claude/settings.json');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'remote', 'add', 'origin', bare);
  return { root, home, work, bare, markers };
}

/** HOME set to the fixture’s for this test, with the person’s AWS files kept, put back when the test ends. */
function useHome(t, home) {
  const saved = Object.fromEntries(['HOME', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE', 'POSTBOX_CLAUDE_BIN'].map((k) => [k, process.env[k]]));
  const real = homedir();
  process.env.POSTBOX_CLAUDE_BIN ??= findClaude();
  process.env.AWS_CONFIG_FILE ??= join(real, '.aws', 'config');
  process.env.AWS_SHARED_CREDENTIALS_FILE ??= join(real, '.aws', 'credentials');
  process.env.HOME = home;
  t.after(() => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  });
}

/**
 * One real turn of `backend` in `mode` that asks for the push. Every card it shows is answered no. Returns the cards.
 * @param {import('node:test').TestContext} t @param {'claude-code'|'agent-sdk'} backend @param {string} mode
 */
async function pushTurn(t, backend, mode) {
  const f = await fixture();
  useHome(t, f.home);
  const app = await start({ port: await freePort(), dataDir: join(f.root, 'data'), fresh: true, quiet: true, claudeHome: f.home });
  t.after(() => app.close());
  const { rt, store } = app;
  assert.ok(rt.adapters.runsHere(backend), `${backend} should run here`);
  store.emit('project', { id: 'p_e2e', name: 'E2E', folder: f.work });
  const p = rt.createPersona({ handle: 'pusher', backend, model: MODEL, permissionMode: mode, usesHostSetup: true, tools: ['shell'] });
  const thread = rt.createThread({ projectId: 'p_e2e', title: 'E2E', personaIds: [p.id] });
  const se = rt.sessionsIn(thread.id)[0];
  const running = () => rt.turns.has(se.id);
  rt.sendMessage(thread.id, { text: PROMPT });
  for (let i = 0; i < 120 && !running(); i++) await sleep(250);
  assert.ok(running(), 'the turn should start');
  const answered = [];
  const until = Date.now() + TURN_MS;
  while (running() && Date.now() < until) {
    for (const card of store.items(thread.id).filter((i) => i.kind === 'permission' && i.status === 'open')) {
      answered.push(card);
      await rt.act(thread.id, card.id, 'deny', {});
    }
    await sleep(250);
  }
  // On a timeout, say what the room shows, so one paid run is enough to see where the turn stuck.
  const seen = () =>
    store
      .items(thread.id)
      .map((i) => `${i.kind}${i.status ? `:${i.status}` : ''}${i.text ? ` ${String(i.text).slice(0, 160)}` : ''}`)
      .join(' | ');
  assert.equal(running(), false, `the turn should end within ${TURN_MS / 1000} s; the room shows: ${seen()}`);
  const said = store
    .items(thread.id)
    .filter((i) => i.kind === 'agent')
    .map((i) => i.text)
    .join('\n');
  return { ...f, answered, said };
}

const landed = (bare) => {
  try {
    git(bare, 'rev-parse', '--verify', '-q', 'refs/heads/e2e');
    return true;
  } catch {
    return false; // rev-parse --verify exits 1 when the branch isn’t there
  }
};
const pushCard = (cards) => cards.find((c) => c.tool === 'Bash' && /git push origin HEAD:refs\/heads\/e2e/.test(c.input?.command ?? ''));

for (const [backend, skip] of [
  ['claude-code', why],
  ['agent-sdk', sdkWhy],
]) {
  test(`#817 ${backend} in Auto: the approving hooks don’t run, the push waits on a card, and no answers no`, {
    skip,
    timeout: TURN_MS + 60_000,
  }, async (t) => {
    const r = await pushTurn(t, backend, 'auto');
    assert.ok(pushCard(r.answered), `a permission card for the push should show; the agent said: ${r.said.slice(0, 500)}`);
    assert.equal(landed(r.bare), false, 'refs/heads/e2e should not be on the remote');
    assert.equal(existsSync(r.markers.user), false, 'the user settings’ hook should not run');
    assert.equal(existsSync(r.markers.project), false, 'the project settings’ hook should not run');
  });
}

// One control per adapter, so neither adapter's “the hooks don't run” can pass because the fixture's hooks never load.
for (const [backend, skip] of [
  ['claude-code', why],
  ['agent-sdk', sdkWhy],
]) {
  test(`#817 control: ${backend} in Run everything, Postbox keeps the person’s hooks, so the fixture’s hooks run`, {
    skip,
    timeout: TURN_MS + 60_000,
  }, async (t) => {
    const r = await pushTurn(t, backend, 'bypass');
    assert.equal(existsSync(r.markers.user), true, `the user settings’ hook should run; the agent said: ${r.said.slice(0, 500)}`);
    assert.equal(existsSync(r.markers.project), true, 'the project settings’ hook should run');
  });
}

test('#817 the fixture copies only the allowlisted model settings from the person’s user settings', () => {
  const mine = {
    env: {
      AWS_REGION: 'us-west-2',
      AWS_PROFILE: 'p',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_MODEL: 'm',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h',
      ANTHROPIC_BEDROCK_BASE_URL: 'https://b',
      ANTHROPIC_DEFAULT_API_KEY_MODEL: 'k',
      ANTHROPIC_API_KEY: 'sk-secret',
      AWS_SECRET_ACCESS_KEY: 's',
      AWS_SESSION_TOKEN: 't',
      GITHUB_TOKEN: 'g',
      CLAUDE_CONFIG_DIR: '/elsewhere',
    },
    awsAuthRefresh: 'refresh',
    apiKeyHelper: 'helper',
    hooks: { PreToolUse: [] },
    permissions: { allow: ['Bash'] },
    model: 'opus',
  };
  assert.deepEqual(modelSettings(mine), {
    awsAuthRefresh: 'refresh',
    apiKeyHelper: 'helper',
    env: {
      AWS_REGION: 'us-west-2',
      AWS_PROFILE: 'p',
      CLAUDE_CODE_USE_BEDROCK: '1',
      ANTHROPIC_MODEL: 'm',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h',
      ANTHROPIC_BEDROCK_BASE_URL: 'https://b',
    },
  });
  assert.deepEqual(modelSettings(null), {});
});
