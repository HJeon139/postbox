// show_block: a block or an app the turn shows (Runtime.toolsFor binds it). An app id the session already holds is a
// new version of it (updateApp, server/apps.mjs); an id that names another session's app gets a fresh one.

import { validateBlock } from '../shared/catalog.mjs';
import { appReceipt } from './app-check-status.mjs';
import { OUTCOME_LATER } from './blocks.mjs';
import { newId } from './store.mjs';
import { wokeOf } from './turn-marks.mjs';

/** @typedef {import('./agent-files.mjs').AppFile} AppFile */

/**
 * @param {import('./runtime.mjs').Runtime} rt @param {string} sessionId
 * @param {{ turn: any, se: () => any, threadId: () => string, endSegment: () => void, tools: any }} ctx  the turn's
 *   tools as toolsFor made them, for update_app
 * @param {{ block: any }} args @param {{ files?: AppFile[] }} [given]  data files Postbox read for show_app (#54)
 */
export function showBlock(rt, sessionId, { turn, se, threadId, endSegment, tools }, { block }, given = {}) {
  // An outcome reports what came of an answer (#94). On a new block it would show under whatever the person
  // answers, even Cancel, so it’s refused here and only taken by update_block once the block is answered.
  if (block && typeof block === 'object' && Object.hasOwn(block, 'outcome'))
    return { ok: false, message: OUTCOME_LATER(String(block.id ?? 'this block'), 'The block wasn’t shown.') };
  const v = validateBlock(block, { imageOrigins: rt.config.imageOrigins });
  // App ids are global. Yours already: it’s a new version. Another agent’s: yours gets a fresh id, and
  // theirs (its versions and saved state) is left alone.
  /** @type {string | null} */
  let renamed = null;
  if (v.ok && v.block.type === 'app' && rt.s.apps[v.block.id]) {
    const { id, code, permissions, title } = /** @type {any} */ (v.block);
    if (rt.s.apps[id].sessionId === sessionId) return tools.update_app({ id, code, permissions, title }, given);
    renamed = newId(String(id).slice(0, 40));
    v.block = { ...v.block, id: renamed };
  }
  // Any other id names one block of this session in this conversation, answered or not, so an answer to it,
  // and an update or outcome by it, always means that block (#125). Showing it again is refused, not turned
  // into an update: an update can reopen a block the person answered.
  if (v.ok && v.block.type !== 'app') {
    const id = v.block.id;
    const shown = rt.store.items(threadId()).find((x) => x.kind === 'block' && x.valid && x.sessionId === sessionId && x.block.id === id);
    // An app’s id can’t take a block’s update, so that case only asks for a new id.
    if (shown?.block.type === 'app') return { ok: false, message: `${id} is the id of your app “${shown.block.title ?? id}”. Pick a new id for this block.` };
    if (shown) return { ok: false, message: `Block ${id} is already shown. Use update_block to change it, or pick a new id.` };
  }
  endSegment();
  const it = rt.addItem(
    threadId(),
    v.ok
      ? {
          kind: 'block',
          sessionId,
          handle: se().handle,
          turnId: turn?.id ?? null,
          valid: true,
          block: v.block,
          answered: false,
          ...wokeOf(turn),
        }
      : {
          kind: 'block',
          sessionId,
          handle: se().handle,
          turnId: turn?.id ?? null,
          valid: false,
          raw: block,
          errors: v.errors,
          reason: v.reason,
          fallback: v.fallback,
        },
  );
  if (v.ok && v.block.type === 'app') rt.registerApp(sessionId, v.block, it.id, threadId(), given.files ?? []);
  return v.ok
    ? v.block.type === 'app'
      ? appReceipt(
          rt.s.apps[v.block.id],
          renamed ? `That app id was taken, so it’s shown as ${renamed}. Use that id to update it.` : `Shown app ${v.block.id}.`,
        )
      : { ok: true, message: `Shown block ${v.block.id}.` }
    : { ok: false, message: `The block was invalid, so the person sees its fallback text. Problems: ${v.errors.join(' ')}` };
}
