// show_block: a block or an app the turn shows (Runtime.toolsFor binds it). An app id the session already holds is a
// new version of it (updateApp, server/apps.mjs); an id that names another session's app gets a fresh one.

import { notShown } from '../shared/block-examples.mjs';
import { ASKING, validateBlock } from '../shared/catalog.mjs';
import { PERSON } from '../shared/review-comments.mjs';
import { appReceipt } from './app-check-status.mjs';
import { withAppIntent, withIntentNote } from './app-intent.mjs';
import { registerApp } from './apps.mjs';
import { OUTCOME_LATER } from './block-update.mjs';
import { otherAuthor } from './review-authors.mjs';
import { newId } from './store.mjs';
import { wokeOf } from './turn-marks.mjs';

/** @typedef {import('./agent-files.mjs').AppFile} AppFile */

/**
 * @param {import('./app-service.mjs').Apps} apps @param {string} sessionId
 * @param {{ turn: any, se: () => any, threadId: () => string, endSegment: () => void, tools: any }} ctx  the turn's
 *   tools as toolsFor made them, for update_app
 * @param {{ block: any }} args @param {{ files?: AppFile[], held?: boolean }} [given]  data files Postbox read for show_app
 *   (#54), or a review’s images (#780); held is set once an item takes the images (keptIfShown)
 */
export function showBlock(apps, sessionId, { turn, se, threadId, endSegment, tools }, { block }, given = {}) {
  // An outcome reports what came of an answer (#94). On a new block it would show under whatever the person
  // answers, even Cancel, so it’s refused here and only taken by update_block once the block is answered.
  if (block && typeof block === 'object' && Object.hasOwn(block, 'outcome'))
    return { ok: false, message: OUTCOME_LATER(String(block.id ?? 'this block'), 'The block wasn’t shown.') };
  // An app’s intent is never why it’s refused (#995): trimmed and cut as show_app does.
  // A new review’s comments are its agent’s (#1143, #1208): only the person’s answer writes one in their name, and
  // review_block one in another agent’s.
  const other = block?.type === 'review' ? otherAuthor(block, se().handle) : null;
  if (other !== null) return { ok: false, message: otherAuthorText(other, se().handle) };
  const saidIntent = block?.type === 'app' ? block.intent : undefined;
  block = withAppIntent(block);
  const v = validateBlock(block, { imageOrigins: apps.config.imageOrigins });
  // An agent’s invalid block is refused outright (#1319): an item would stay as a broken card, and agents retry at
  // once, often under a new id, so each try left another. Only a block this Postbox can’t read but a newer host’s
  // catalog took, of a type or version it doesn’t know, still shows its fallback.
  if (!v.ok && !(turn?.remote && NEWER.has(v.reason))) return { ok: false, message: notShown(v.errors, block) };
  // App ids are global. Yours already: it’s a new version. Another agent’s: yours gets a fresh id, and
  // theirs (its versions and saved state) is left alone.
  /** @type {string | null} */
  let renamed = null;
  if (v.ok && v.block.type === 'app' && apps.store.pending.app(v.block.id)) {
    const { id, code, permissions, title } = /** @type {any} */ (v.block);
    if (apps.store.pending.app(id).sessionId === sessionId) return tools.update_app({ id, code, permissions, title, intent: saidIntent }, given);
    renamed = newId(String(id).slice(0, 40));
    v.block = { ...v.block, id: renamed };
  }
  // Any other id names one block of this session in this conversation, answered or not, so an answer to it,
  // and an update or outcome by it, always means that block (#125). Showing it again is refused, not turned
  // into an update: an update can reopen a block the person answered.
  const again = v.ok && v.block.type !== 'app' ? shownAgain(apps, sessionId, threadId(), v.block.id) : null;
  if (again) return again;
  endSegment();
  // A review’s images (#780), read and checked before the call reached here, stay with the item.
  const files = v.ok && v.block.type === 'review' && given.files ? { files: given.files } : {};
  const it = apps.threads.addItem(threadId(), { ...blockItem(sessionId, se, turn, block, v), ...files });
  if (v.ok && ASKING.has(v.block.type)) apps.bus.emit('block.asking', { se: se(), item: it, threadId: threadId() });
  if (files.files) given.held = true; // the item holds them, so keptIfShown keeps their blobs (#828)
  if (v.ok && v.block.type === 'app') registerApp(apps, sessionId, v.block, it.id, threadId(), given.files ?? []);
  // The app’s first version holds its data files, so keptIfShown keeps their blobs (#1702).
  if (v.ok && v.block.type === 'app' && given.files) given.held = true;
  if (v.ok && v.block.type === 'app') {
    const shown = renamed ? `That app id was taken, so it’s shown as ${renamed}. Use that id to update it.` : `Shown app ${v.block.id}.`;
    return withIntentNote(appReceipt(apps.store.pending.app(v.block.id), shown), saidIntent);
  }
  return v.ok
    ? { ok: true, message: `Shown block ${v.block.id}.` }
    : { ok: false, message: `This Postbox can’t read that block, so the person sees its fallback text: ${v.errors.join(' ')}` };
}

/** Why a block a newer host took can still fail here: validateBlock’s reasons for a type or version it doesn’t know. */
const NEWER = new Set(['unknown-type', 'newer-version']);

/** The refusal when this session already showed a block with this id in the thread, or null. */
function shownAgain(apps, sessionId, threadId, id) {
  const shown = apps.store.pending.items(threadId).find((x) => x.kind === 'block' && x.valid && x.sessionId === sessionId && x.block.id === id);
  // An app’s id can’t take a block’s update, so that case only asks for a new id.
  if (shown?.block.type === 'app') return { ok: false, message: `${id} is the id of your app “${shown.block.title ?? id}”. Pick a new id for this block.` };
  if (shown) return { ok: false, message: `Block ${id} is already shown. Use update_block to change it, or pick a new id.` };
  return null;
}

/** The item show_block adds: the valid block, or what was sent with why it was refused, which shows its fallback. */
function blockItem(sessionId, se, turn, block, v) {
  const by = { kind: 'block', sessionId, handle: se().handle, turnId: turn?.id ?? null };
  return v.ok
    ? { ...by, valid: true, block: v.block, answered: false, ...wokeOf(turn) }
    : { ...by, valid: false, raw: block, errors: v.errors, reason: v.reason, fallback: v.fallback };
}

/** Why show_block refused a review with a comment in another name. @param {string} other @param {string} handle */
function otherAuthorText(other, handle) {
  let what = `a comment in another name (author “${other}”)`;
  if (other === PERSON) what = 'a comment in the person’s name (author “you”): only their answer writes one';
  if (!other) what = 'a comment with no author';
  return `A review can’t be shown with ${what}. Its comments are yours, as @${handle}; another agent comments with review_block. The block wasn’t shown.`;
}
