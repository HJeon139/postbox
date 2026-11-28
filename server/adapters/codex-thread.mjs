import { cleanSaid } from '../../shared/text-parts.mjs';
import { agentSkills } from './agent-plugin.mjs';
import { POSTBOX_SERVER } from './setup.mjs';
import { POSTBOX_SKILLS, postboxSkillsOn } from './skill-config.mjs';
import { toolsDown } from './tools-down.mjs';

/**
 * Gives this turn’s app-server Postbox’s skills (agent-plugin.mjs) as an extra skills root, which that process holds
 * only in memory: nothing is written to ~/.codex or the project. Checked with codex-cli 0.167.0: after
 * skills/extraRoots/set, skills/list named postbox:visual-explainer from agent-plugin/skills, before any thread, and no
 * file in ~/.codex changed. A Codex without the method answers with an error, and the turn goes on without them. A
 * turn on a host gets none: the folder is on this computer. A root is a whole folder, so a persona that turned any of
 * Postbox’s skills off gets none of them (#207). Says whether Codex took them.
 * @param {(method: string, params?: any) => Promise<any>} request
 * @param {{ remote?: boolean, env?: NodeJS.ProcessEnv, persona?: any }} [turn]
 */
export async function addPostboxSkills(request, { remote = false, env = process.env, persona = null } = {}) {
  const allOn = postboxSkillsOn(persona).length === POSTBOX_SKILLS.length;
  const root = remote || !allOn ? null : agentSkills(env);
  if (!root) return false;
  return request('skills/extraRoots/set', { extraRoots: [root] }).then(
    () => true,
    () => false,
  );
}

// Postbox’s skills go on the app-server first, so the thread it opens has them.
// #587: Codex can return a thread id before any rollout exists. Only the recorded missing-rollout resume error
// permits a fresh thread; a failed fork must not silently discard the checkpoint the person requested.
export async function openCodexThread(ctx, request, { sourceThreadId, fork, cwd, model, openConfig }) {
  await addPostboxSkills(request, { remote: Boolean(ctx.remote), persona: ctx.persona });
  const start = () => request('thread/start', { cwd, ...(model ? { model } : {}), ...openConfig });
  if (fork?.turnId && sourceThreadId)
    return { opened: await request('thread/fork', { threadId: sourceThreadId, lastTurnId: fork.turnId, excludeTurns: true, ...openConfig }), fresh: false };
  if (!sourceThreadId) return { opened: await start(), fresh: false };
  try {
    // Without excludeTurns the answer holds the thread's whole history: past a host's 8 MiB line it never arrives (#1705).
    return { opened: await request('thread/resume', { threadId: sourceThreadId, cwd, excludeTurns: true, ...openConfig }), fresh: false };
  } catch (error) {
    // -32600 is a generic invalid request, with no missing-rollout discriminator. Match the recorded text and exact
    // thread id deliberately: a broader regex would discard saved history on unrelated resume errors (#587).
    if (ctx.signal.aborted || error.code !== -32600 || error.message !== `no rollout found for thread id ${sourceThreadId}`) throw error;
    const cleared = { codexThreadId: null, fork: null, forkFrom: null };
    Object.assign(ctx.state, cleared);
    ctx.saveState(cleared);
    return { opened: await start(), fresh: true };
  }
}

// Codex refuses a thread whose required MCP server can’t start (checked with codex-cli 0.167.0, 10 Nov): thread/start
// answers -32603, “… required MCP servers failed to initialize: postbox: handshaking with MCP server failed: …”, with
// several hundred characters of transport detail after it, and sends no startupStatus for the server (#1162). Only
// an entry of that list counts, at its start or after “; ”, not “postbox:” inside another server’s detail.
// lint-allow regex: its only variable part is POSTBOX_SERVER, a constant (“postbox”).
const REQUIRED_FAILED = new RegExp(`required MCP servers failed to initialize: (?:[^;]*; )*${POSTBOX_SERVER}:`);
export const SAID_MAX = 400; // of Codex’s error shown to the person, as for Kiro’s (#489): its transport detail runs long

/**
 * When Codex refused the thread because Postbox’s server didn’t start, a failed step and an error that says so;
 * any other error as it was.
 * @param {any} ctx @param {any} err
 */
export function codexRefusal(ctx, err) {
  if (!REQUIRED_FAILED.test(String(err?.message ?? ''))) return err;
  const said = cleanSaid(String(err.message), SAID_MAX);
  toolsDown(ctx, `Codex couldn’t start Postbox’s tool server, which it needs, so it didn’t start the turn. Codex said: “${said}”`, { ran: false });
  return Object.assign(
    new Error('Postbox’s tools didn’t load: Codex couldn’t start Postbox’s tool server, so it didn’t start this turn. Retry to try again.'),
    // It never reached the agent, though its step opened the turn’s reply (store-outage.mjs, neverReached; #1904).
    { cause: err, notReached: true },
  );
}

/**
 * Codex’s refusal of a request as the person reads it: its words cleaned and cut, as other harnesses’ errors are
 * (#1905, #1938), keeping its JSON-RPC code and the error as Codex gave it in `cause`. Only at the turn’s edge, after
 * the checks that read Codex’s exact words (openCodexThread’s missing rollout, codexRefusal). Anything else as it was.
 * @param {any} err
 */
export function codexSaid(err) {
  if (typeof err?.code !== 'number' || typeof err.message !== 'string') return err;
  return Object.assign(new Error(cleanSaid(err.message, SAID_MAX)), { code: err.code, cause: err });
}

/**
 * Fails the requests a turn is waiting on when a host leaves out a line of Codex's output as too long to send
 * (server/remote/process-receive.mjs's 'cut'). Until the turn starts, Codex's lines are its answers and a few short
 * notices, so the lost line was one of those answers: without this, its request waits for good while the app-server
 * holds the thread, and every later turn on it is refused as "already has an active writer" (#1705). A local
 * app-server never emits 'cut'.
 * @param {import('node:events').EventEmitter} child @param {Map<number, { method: string }>} pending
 * @param {(err: Error) => void} fail @param {() => boolean} opening whether the turn hasn't started yet
 */
export function failOnCutAnswer(child, pending, fail, opening) {
  child.on('cut', ({ offset, next }) => {
    if (!opening() || pending.size === 0) return;
    const methods = [...new Set([...pending.values()].map((x) => x.method))].join(', ');
    fail(new Error(`Codex’s answer to ${methods} was ${next - offset} bytes, too long to send from the host, so the turn didn’t start. Retry to try again.`));
  });
}
