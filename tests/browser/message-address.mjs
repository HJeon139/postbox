// What the #168 specs share (message-address.spec.mjs and message-address-pane.spec.mjs): a long room, and whether a
// message has been gone to.

import * as arrange from '../arrange.mjs';

/** A room of 60 messages with @researcher, the first far above the end. @param {any} app @param {string} title */
export function longRoom(app, title) {
  const { rt } = app;
  const projectId = Object.values(rt.store.state.projects)[0].id;
  const t = rt.createThread({ projectId, title, personaIds: [arrange.persona(rt, 'researcher').id] });
  const [se] = arrange.sessionsIn(rt, t.id);
  const items = [];
  for (let i = 0; i < 60; i++)
    items.push(
      i % 2
        ? arrange.post(rt, t.id, { kind: 'agent', sessionId: se.id, handle: 'researcher', text: `Reply ${i}: ${'what it found. '.repeat(12)}`, status: 'done' })
        : arrange.post(rt, t.id, { kind: 'user', text: `Message ${i}: carry on.` }),
    );
  return { t, se, items };
}

/** Whether the message is drawn in view, and focus is in it. */
export const landed = (page, id) =>
  page.evaluate((key) => {
    const node = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (!node) return 'not drawn';
    const r = node.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return 'not in view';
    return node.contains(document.activeElement) ? 'landed' : 'not focused';
  }, id);

/** Whether the message is what’s on top at its own middle, not under Work or anything else. */
export const uncovered = (page, id) =>
  page.evaluate((key) => {
    const r = document.querySelector(`[data-key="${CSS.escape(key)}"]`)?.getBoundingClientRect();
    return Boolean(r) && !!document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20))?.closest(`[data-key="${CSS.escape(key)}"]`);
  }, id);
