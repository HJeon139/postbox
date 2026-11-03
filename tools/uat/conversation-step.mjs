// The UAT runner’s conversation action (#722 to #725): the tester deletes the conversation that’s open, presses its
// Undo, starts a second conversation or opens one, through the UI as a person does. Each writes when it happened into
// facts.probes.conversation, with the deleted conversation’s agents and the end of its Undo window, for
// turn-in-deleting-conversation (tools/uat/checks-assets.mjs). Also a restart of Postbox in a run without hosts.
// Kept out of tools/uat-run.mjs and tools/uat/driver.mjs, to keep those files to their size.

import { js, sleep } from '../browser.mjs';
import { byText } from './selectors.mjs';

/** The conversation the page shows, from its address. @param {any} ev */
const openThread = async (ev) => /#\/t\/([^/?]+)/.exec(String(await ev('location.hash')))?.[1] ?? null;

/** The handles of the agents in a conversation and its topic and side threads, which its delete stops. */
function handlesIn(state, threadId) {
  const ids = new Set(
    Object.values(state.threads ?? {})
      .filter((t) => t.id === threadId || t.parentId === threadId)
      .map((t) => t.id),
  );
  return Object.values(state.sessions ?? {})
    .filter((se) => ids.has(se.threadId))
    .map((se) => se.handle);
}

/** The newest Undo toast for this conversation’s delete, as an expression. */
const undoButton = (title) =>
  byText(`[...document.querySelectorAll('#toasts-bottom .toast')].filter((t) => t.textContent.includes(${js(title)})).at(-1)`, 'button', 'Undo');

/** Opens a conversation by its rail row, as a person goes back to it. */
async function openRow({ kit }, threadId, what) {
  await kit.clickAt(`document.querySelector(${js(`.rail a.row[data-thread="${threadId}"]`)})`, what);
  await kit.page.waitFor(`!!document.getElementById('composer-input')`, { label: 'the composer' });
}

/**
 * Presses Undo on a conversation’s delete, and opens it again.
 * @returns {Promise<string>}
 */
async function undo({ d, api, facts }, del) {
  const { kit } = d;
  if (!(await kit.ev(`!!${undoButton(del.title)}`))) return `There was no Undo for “${del.title}” on screen: its 10 seconds had passed.`;
  await kit.clickAt(undoButton(del.title), 'Undo on the delete’s toast');
  const at = Date.now();
  facts.probes.conversation.push({ do: 'undo', at, threadId: del.threadId });
  for (let i = 0; i < 20 && (await api('/api/state')).state.threads[del.threadId]?.deleting; i++) await sleep(250);
  await openRow(d, del.threadId, `“${del.title}” in the rail`);
  return `Pressed Undo ${((at - del.at) / 1000).toFixed(1)} s after the delete, and opened “${del.title}” again.`;
}

/** Deletes the conversation that’s open, through its menu and the confirm, then presses Undo after undo_after seconds. */
async function remove(ctx, a) {
  const { d, api, facts } = ctx;
  const threadId = await openThread(d.kit.ev);
  const state = (await api('/api/state')).state;
  const t = state.threads?.[threadId];
  if (!t) throw new Error('No conversation is open to delete.');
  const room = t.kind === 'room';
  await d.kit.clickAt(`document.querySelector(${js(`[aria-label="Actions for ${t.title}"]`)})`, 'the conversation’s menu');
  await d.kit.clickAt(byText('document', '.menu .mi, [role=menuitem]', `Delete ${room ? 'room' : 'conversation'}`), 'Delete in its menu');
  await d.kit.clickAt(byText('document.querySelector(".dialog")', 'button.danger', `Delete ${room ? 'room' : 'conversation'}`), 'the confirm’s Delete');
  const at = Date.now();
  let until = null;
  for (let i = 0; i < 20 && !until; i++) {
    until = (await api('/api/state')).state.threads[threadId]?.deleting ?? null;
    if (!until) await sleep(100);
  }
  if (!until) throw new Error(`“${t.title}” wasn’t marked as being deleted after its confirm.`);
  const del = { do: 'delete', at, threadId, title: t.title, handles: handlesIn(state, threadId), until };
  facts.probes.conversation.push(del);
  const said = `Deleted “${t.title}”; its Undo runs out ${((until - at) / 1000).toFixed(1)} s from now.`;
  if (a.undo_after === undefined || a.undo_after === null) return said;
  const wait = Math.max(0, Number(a.undo_after) || 0) * 1000 - (Date.now() - at);
  if (wait > 0) await sleep(wait);
  return `${said} ${await undo(ctx, del)}`;
}

/** Starts another conversation in the open one’s project, with these agents, and opens it. */
async function start({ d, api, facts }, a) {
  const state = (await api('/api/state')).state;
  const from = state.threads?.[await openThread(d.kit.ev)];
  const project = state.projects?.[from?.projectId]?.name;
  if (!project) throw new Error('Open a conversation first: a new one starts in its project.');
  const handles = (a.agents ?? []).map((x) => String(x).replace(/^@/, ''));
  if (!handles.length) throw new Error('A new conversation needs its agents, such as agents: ["researcher"].');
  const title = String(a.title ?? 'Second conversation');
  const threadId = /#\/t\/([^/?]+)/.exec(String(await d.newConversation(project, title, handles)))?.[1] ?? null;
  facts.probes.conversation.push({ do: 'new', at: Date.now(), threadId, title });
  return `Started “${title}” with ${handles.map((x) => `@${x}`).join(', ')}, and it’s open.`;
}

/** Opens a conversation by its title in the rail. */
async function open({ d, api }, a) {
  const state = (await api('/api/state')).state;
  const t = Object.values(state.threads ?? {}).find((x) => x.title === a.title && !x.parentId);
  if (!t) throw new Error(`There’s no conversation “${a.title}” to open.`);
  await openRow(d, t.id, `“${t.title}” in the rail`);
  return `Opened “${t.title}”.`;
}

/**
 * The conversation action, by its `conversation`: delete {undo_after?}, undo, new {agents, title?} or open {title}.
 * @param {{ d: any, api: any, facts: any }} ctx @param {any} a  the tester’s action, or an interrupt’s
 * @returns {Promise<string>}
 */
export async function conversationStep(ctx, a) {
  ctx.facts.probes.conversation ??= [];
  const kind = a.conversation;
  if (kind === 'delete') return remove(ctx, a);
  if (kind === 'new') return start(ctx, a);
  if (kind === 'open') return open(ctx, a);
  if (kind === 'undo') {
    const del = ctx.facts.probes.conversation.filter((x) => x.do === 'delete').at(-1);
    if (!del) throw new Error('Nothing was deleted to undo.');
    return undo(ctx, del);
  }
  throw new Error(`A conversation action is delete, undo, new or open, not “${kind}”.`);
}

/** restart-postbox in a run without hosts: stops Postbox, starts it on the same data, and reloads the page. */
export async function localRestart({ postbox, page, log }, spec) {
  if (spec.fault !== 'restart-postbox') throw new Error(`A run without --host can only restart Postbox, not ${spec.fault}.`);
  const downMs = await postbox.restart();
  await page.reload();
  const said = `Restarted Postbox on the same data. It was down ${(downMs / 1000).toFixed(1)} s.`;
  log(`fault restart-postbox: ${said}`);
  return said;
}
