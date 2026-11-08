// What an app shows when it hits a script error, and asking its agent to fix it. An app that drew something keeps
// running, with a strip under it that names the error; one that drew nothing gets a card in its place (#964).

import { api, client } from './client.mjs';
import { h, icon } from './dom.mjs';
import { toast } from './ui.mjs';

/**
 * The card in a crashed app’s place: what happened, the error, Reload and Ask to fix.
 * @param {(lines: any[], height?: number) => HTMLElement} placeholder  mountApp’s placeholder
 * @param {{ app: any, owner: string, msg: string, reload: () => void }} what
 */
export function crashCard(placeholder, { app, owner, msg, reload }) {
  return placeholder(
    [
      h('span.row-flex', { style: { color: 'var(--text)' } }, h('span.g.g-failed', { 'aria-hidden': 'true' }), h('b', `${app.title} stopped working`)),
      h('span', `It hit a script error and was shut down. Nothing outside the app was affected. Reload it, or ask ${owner} to fix it.`),
      h('code.mono', { style: { color: 'var(--text)' } }, msg),
      h(
        'span.row-flex',
        h('button.btn.sm', { type: 'button', onclick: reload }, icon('retry', 'i-sm'), 'Reload app'),
        h('button.btn.sm', { type: 'button', onclick: () => askToFix(app, msg) }, `Ask ${owner} to fix it`),
      ),
    ],
    220,
  );
}

/**
 * The strip under an app that hit a script error after it drew. It stays hidden until the first error, and shows
 * the latest one.
 * @param {{ app: any, owner: string, reload: () => void }} what
 * @returns {{ el: HTMLElement, show: (msg: string) => void }}
 */
export function errorStrip({ app, owner, reload }) {
  let msg = '';
  const code = h('code.mono');
  const el = h(
    'div.app-error',
    { hidden: true, role: 'status' },
    icon('warn'),
    h('span', `${app.title} hit a script error and is still running. Parts of it may not work: `, code),
    h(
      'span.row-flex',
      h('button.btn.sm', { type: 'button', onclick: reload }, icon('retry', 'i-sm'), 'Reload app'),
      h('button.btn.sm', { type: 'button', onclick: () => askToFix(app, msg) }, `Ask ${owner} to fix it`),
    ),
  );
  const show = (m) => {
    msg = m;
    code.textContent = m;
    el.hidden = false;
  };
  return { el, show };
}

function askToFix(app, msg) {
  const se = client.state.sessions[app.sessionId];
  if (!se) return;
  api(`/api/threads/${app.threadId}/messages`, { text: `@${se.handle} the ${app.title} app stopped working: \`${msg}\`. Please fix it.` }).catch((e) =>
    toast({ title: 'That didn’t send', text: e.message, level: 'blocking' }),
  );
}
