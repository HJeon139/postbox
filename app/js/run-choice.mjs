// /mode, /model and /effort’s choice for one agent (#67), and the permission modes’ names and words, which the
// permissions panel (app/js/permissions.mjs, which re-exports both) and the persona sheet use too. Moved out of
// permissions.mjs.

import { api, busy, client, sessionsOf } from './client.mjs';
import { fill, h } from './dom.mjs';
import { EFFORT_NAMES, modelsFor } from './sheets.mjs';
import { keepFocus, openDialog, say, toast } from './ui.mjs';

const S = () => client.state;

// The same names and words as the persona sheet’s Permissions field (sheets.mjs).
export const MODES = [
  ['auto', 'Auto', 'A safety check approves routine actions; it asks you only when it can’t decide.'],
  ['ask', 'Ask me', 'It asks before running commands or changing files.'],
  ['acceptEdits', 'Accept edits', 'It edits files in its folders freely, and asks before running commands.'],
  ['bypass', 'Run everything', 'It never asks. Use it only in a folder you can lose.'],
];

/**
 * /mode, /model and /effort (#67): segmented choices for one agent in a conversation, without a turn. The mode is the
 * persona’s; the model and the effort are this conversation’s (its session’s snapshot). Each says when it applies:
 * now, on a running Agent SDK turn that could change, else from the agent’s next turn.
 * @param {'mode'|'model'|'effort'} kind @param {{ threadId: string, sessionId?: string|null }} where
 */
export function openRunChoice(kind, { threadId, sessionId = null }) {
  const t = S().threads[threadId];
  const agents = sessionsOf(threadId).filter((x) => !x.archived && S().personas[x.personaId]?.backend !== 'mock');
  let current = (sessionId && agents.find((x) => x.id === sessionId)?.id) ?? agents.find((x) => x.id === t?.lastSpeaker)?.id ?? agents[0]?.id ?? null;
  let status = '';
  const body = h('div.perm-panel');
  const title = { mode: 'Permission mode', model: 'Model', effort: 'Effort' }[kind];
  const choices = () => {
    const se = S().sessions[current];
    const p = S().personas[se.personaId];
    if (kind === 'mode') return { list: MODES.map(([id, name]) => [id, name]), value: p.permissionMode ?? 'auto' };
    if (kind === 'model') {
      const value = se.personaSnapshot?.model ?? p.model;
      return { list: [...new Set([...modelsFor(p.backend), value])].map((m) => [m, m]), value };
    }
    const levels = client.config.effortLevels ?? Object.keys(EFFORT_NAMES);
    return { list: levels.map((l) => [l, EFFORT_NAMES[l] ?? l]), value: se.personaSnapshot?.effort ?? p.effort ?? client.config.defaultEffort };
  };
  const pick = async (id, name) => {
    const se = S().sessions[current];
    try {
      const r =
        kind === 'mode' ? await api('/api/permissions/mode', { personaId: se.personaId, mode: id }) : await api(`/api/sessions/${se.id}/run`, { [kind]: id });
      const now = kind === 'mode' ? r.now.includes(se.handle) : r.now;
      const scope = kind === 'mode' ? ', in every conversation' : ' in this conversation';
      status = now
        ? `@${se.handle} uses ${name}${scope}, from now: its running turn changed too.`
        : `@${se.handle} uses ${name}${scope}, from its next turn${busy(se) ? '; Claude Code can’t change a turn that’s running' : ''}.`;
      say(status);
    } catch (e) {
      toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' });
    }
    paint();
  };
  const paint = () =>
    keepFocus(body, () => {
      if (!current) return fill(body, h('p.help', 'Only Claude Code and Agent SDK agents have a mode, a model and an effort to change.'));
      const { list, value } = choices();
      fill(
        body,
        agents.length > 1
          ? h(
              'div.field',
              h('span.label', 'Agent'),
              h(
                'div.seg',
                { role: 'radiogroup', 'aria-label': 'Agent' },
                agents.map((se) =>
                  h(
                    'button',
                    {
                      type: 'button',
                      role: 'radio',
                      'aria-checked': String(se.id === current),
                      onclick: () => {
                        current = se.id;
                        status = '';
                        paint();
                      },
                    },
                    `@${se.handle}`,
                  ),
                ),
              ),
            )
          : null,
        h(
          'div.field',
          h('span.label', title),
          h(
            'div.seg.seg-wrap',
            { role: 'radiogroup', 'aria-label': title },
            list.map(([id, name]) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(id === value), onclick: () => pick(id, name) }, name)),
          ),
        ),
        status ? h('p.small.perm-status', { role: 'status' }, status) : null,
        kind === 'mode' ? h('span.help', MODES.find(([id]) => id === value)?.[2] ?? '') : null,
      );
    });
  paint();
  openDialog({
    title,
    sub: t ? `In “${t.title}”` : '',
    body: [body],
    initialFocus: () => body.querySelector(`[aria-label="${title}"] [aria-checked="true"]`) ?? body.querySelector('button'),
  });
}
