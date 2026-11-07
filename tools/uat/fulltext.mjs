// What the tester reads of a long item, and when it may approve one (UC03 recovery action 6). The screen’s innerText is
// cut to 3,000 characters by the driver and 1,800 by observe, silently, and a design review is longer: the tester
// approved designs whose last items it never saw. So a block waiting on the tester, and the agent message just before
// it, are shown from Postbox’s own record, whole up to FULL_CAP; any item shown in part says so and names a file in
// the run folder with all of it, which the read_full action reads back; and an approval is refused while the tester
// says an item is unread or was shown only part of the block or its message.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Characters of an item the tester sees when it isn’t waiting on it, as before. */
export const SHOWN_CAP = 1800;
/** Characters of a waiting block, or its message, shown whole. */
export const FULL_CAP = 60_000;
/** Characters of an item the driver reads off the screen (tools/uat/driver.mjs items()). */
export const SCREEN_CAP = 3000;

const lines = (s) => String(s ?? '');

/**
 * An item’s full text from Postbox’s record. A review’s content is numbered by line, as the tester’s review comments
 * address it; a block’s options and fields are listed by label.
 * @param {any} item
 */
export function recordText(item) {
  if (!item) return '';
  if (item.kind !== 'block') return lines(item.text);
  const b = item.block ?? {};
  const parts = [b.title, b.prompt, b.statement, b.body].filter(Boolean).map(lines);
  if (b.type === 'review' && typeof b.content === 'string')
    parts.push(
      b.content
        .split('\n')
        .map((l, i) => `${i + 1}: ${l}`)
        .join('\n'),
    );
  else if (typeof b.content === 'string') parts.push(b.content);
  if (typeof b.code === 'string') parts.push(b.code);
  if (Array.isArray(b.columns) && Array.isArray(b.rows))
    parts.push(
      [b.columns.map((c) => c.label ?? c.id).join(' | '), ...b.rows.map((r) => b.columns.map((c) => String(r.cells?.[c.id] ?? '')).join(' | '))].join('\n'),
    );
  if (Array.isArray(b.options)) parts.push(b.options.map((o) => `- ${o.label}`).join('\n'));
  if (Array.isArray(b.fields)) parts.push(b.fields.map((f) => `- ${f.label}`).join('\n'));
  if (Array.isArray(b.facts)) parts.push(b.facts.map((f) => `- ${f.label}: ${f.value}`).join('\n'));
  return parts.join('\n\n');
}

/** Every item in Postbox’s state, with the list it sits in. */
function located(state, key) {
  for (const list of Object.values(state?.items ?? {})) {
    const i = (list ?? []).findIndex((x) => x?.id === key);
    if (i >= 0) return { item: list[i], list, i };
  }
  return null;
}

/** A block still waiting on the person, and the agent message just before it in the same turn, are read whole. */
function waitingOrItsMessage(state, key) {
  const at = located(state, key);
  if (!at) return { item: null, waiting: false };
  const isWaiting = (x) => x?.kind === 'block' && !x.answered && !x.withdrawn;
  if (isWaiting(at.item)) return { item: at.item, waiting: true };
  const next = at.list[at.i + 1];
  const message = at.item.kind === 'agent' && isWaiting(next) && next.sessionId === at.item.sessionId;
  return { item: at.item, waiting: message };
}

/**
 * The text of one item for the tester’s observation, and what it was cut to.
 * @param {{ key: string, label: string, screenText: string, state: any, dir: string, cuts: Map<string, any> }} o
 *   cuts: item key → { shown, total, path }, kept for approvalRefusal; read_full clears an entry
 * @returns {{ text: string, log: string | null }}
 */
export function fullView({ key, label, screenText, state, dir, cuts }) {
  const { item, waiting } = waitingOrItsMessage(state, key);
  const record = recordText(item);
  const n = (x) => x.toLocaleString('en-US');
  if (screenText.length >= SCREEN_CAP && record.length <= screenText.length) {
    cuts.set(key, { label, shown: screenText.length, total: null, path: null, full: null });
    return {
      text: `${screenText}…\n(shown ${n(screenText.length)} of more than ${n(SCREEN_CAP)} characters; Postbox’s record doesn’t hold the rest, so ask the agent for it)`,
      log: `full text: ${label} shown ${screenText.length} of more than ${SCREEN_CAP} characters, no record to read`,
    };
  }
  const full = record.length > screenText.length ? record : screenText;
  const cap = waiting ? FULL_CAP : SHOWN_CAP;
  const source = waiting ? full : screenText;
  if (source.length <= cap && (waiting || full.length <= SHOWN_CAP)) {
    cuts.delete(key);
    return { text: source, log: waiting ? `full text: ${label} shown whole, ${full.length} characters` : null };
  }
  const folder = join(dir, 'fulltext');
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `${label}-r${item?.revision ?? 1}.md`);
  writeFileSync(path, full);
  const shown = Math.min(cap, source.length);
  cuts.set(key, { label, shown, total: full.length, path, full });
  return {
    text: `${source.slice(0, shown)}…\n(shown ${n(shown)} of ${n(full.length)} characters; full text: ${relative(dir, path)}; read it with the read_full action on ${label})`,
    log: `full text: ${label} shown ${shown} of ${full.length} characters, ${relative(dir, path)}`,
  };
}

const DESIGN_CHECK = /DESIGN-CHECK:([^\n]*)/i;
// Whether one DESIGN-CHECK item says the tester didn't read it. Words about the tester's own reading count in any item;
// words a design also uses about its data or what the model may see ("partial credit", "incomplete records", "not
// visible to the model") count only in an item that isn't a "yes".
const READING =
  /\b(unread|not read|truncated|cut off|cut short|not fully|can[’']?t see|cannot see|couldn[’']?t (see|read)|didn[’']?t (see|read)|my screen|to me)\b/i;
const AMBIGUOUS = /\b(partial(ly)?|incomplete|not shown|not visible)\b/i;
const unreadItem = (item) => {
  const verdict = /^\s*\d+\s*[:.)-]?\s*([a-z]+)/i.exec(item)?.[1]?.toLowerCase();
  return READING.test(item) || (verdict !== 'yes' && AMBIGUOUS.test(item));
};

/** One DESIGN-CHECK line's items, split at the commas outside parentheses: `["1 yes", "2 no (dropped in v2)", …]`. */
function checkItems(line) {
  const items = [];
  let depth = 0;
  let current = '';
  for (const ch of line) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      items.push(current.trim());
      current = '';
    } else current += ch;
  }
  if (current.trim()) items.push(current.trim().replace(/\.$/, ''));
  return items.filter(Boolean);
}

const refusesPermission = (action, item) =>
  item?.kind === 'permission' && action?.type === 'act' && /^(?:don[’']t allow…|don[’']t allow)$/i.test(String(action.button ?? ''));

/**
 * Why an answer must wait, or null.
 * - Any answer to a waiting block waits while that block, or an item posted since the person’s last message, was shown
 *   in part, whatever the step’s assessment says.
 * - An approval (an approve verdict on a review, or an answer given in a step whose assessment carries a DESIGN-CHECK
 *   line, which the answer sheet writes before approving a plan) also waits while one of that line’s items says the
 *   tester didn’t read or couldn’t see it.
 * @param {{ action: any, assessment: string, key: string | null, state: any, cuts: Map<string, any> }} o
 */
export function approvalRefusal({ action, assessment, key, state, cuts }) {
  if (!key || !['act', 'review'].includes(action?.type)) return null;
  const at = located(state, key);
  if (refusesPermission(action, at?.item)) return null;
  const since = [];
  if (at) for (let i = at.i; i >= 0 && at.list[i]?.kind !== 'user'; i -= 1) since.push(at.list[i].id);
  const unresolved = (k) => {
    const item = located(state, k)?.item;
    return !(item?.kind === 'permission' && item.status !== 'open');
  };
  const cut = (since.length ? since : [key])
    .filter(unresolved)
    .map((k) => cuts.get(k))
    .find(Boolean);
  if (cut) {
    const shown =
      cut.total === null
        ? `${cut.shown.toLocaleString('en-US')} characters and not the rest`
        : `${cut.shown.toLocaleString('en-US')} of ${cut.total.toLocaleString('en-US')} characters`;
    return `You were shown ${shown} of ${cut.label}. ${cut.path ? `Read the rest with the read_full action on ${cut.label}` : 'Ask the agent for the rest, or refuse it by pressing Don’t allow… and then Don’t allow'} before you answer.`;
  }
  const check = DESIGN_CHECK.exec(assessment ?? '');
  const approving = action.type === 'review' ? action.verdict === 'approve' : Boolean(check);
  if (!approving || !check) return null;
  const unread = checkItems(check[1]).find(unreadItem);
  if (unread) return `Your DESIGN-CHECK line marks an item as not read (“${unread}”). Read that item first, or ask the builder for it, then approve.`;
  return null;
}

/**
 * The read_full action: the whole text of an item that was shown in part, which then counts as read.
 * @param {{ key: string, cuts: Map<string, any> }} o
 */
export function readFull({ key, cuts }) {
  const cut = cuts.get(key);
  if (!cut) return 'That item was shown whole; there is nothing more to read.';
  if (cut.total === null || !cut.path)
    return `Postbox’s record doesn’t hold the rest of ${cut.label}. You can safely deny the permission by pressing Don’t allow… and then Don’t allow, or ask the agent to split the command into shorter steps.`;
  cuts.delete(key);
  return `The full text of ${cut.label} (${cut.total.toLocaleString('en-US')} characters):\n\n${cut.full}`;
}
