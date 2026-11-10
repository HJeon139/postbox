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
    return { opened: await request('thread/resume', { threadId: sourceThreadId, cwd, ...openConfig }), fresh: false };
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

/**
 * When Codex refused the thread because Postbox’s server didn’t start, a failed step and an error that says so;
 * any other error as it was.
 * @param {any} ctx @param {any} err
 */
export function codexRefusal(ctx, err) {
  if (!REQUIRED_FAILED.test(String(err?.message ?? ''))) return err;
  toolsDown(ctx, 'Codex couldn’t start Postbox’s tool server, which it needs, so it didn’t start the turn.', { ran: false });
  return Object.assign(
    new Error('Postbox’s tools didn’t load: Codex couldn’t start Postbox’s tool server, so it didn’t start this turn. Retry to try again.'),
    {
      cause: err,
    },
  );
}
