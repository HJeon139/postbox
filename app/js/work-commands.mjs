// The Work view’s commands (#132): every command the agents ran, how it ended, and its output when you open it, with
// the words and glyphs the pane’s rows share. Moved from app/js/work.mjs.

import { commandLabel } from '/shared/work-list.mjs';
import { client } from './client.mjs';
import { h, timeOf } from './dom.mjs';
import { backgroundNote } from './work-hosts.mjs';
import { dur, section, who } from './work-sections.mjs';

const S = () => client.state;

export const COMMAND_WORDS = {
  running: 'Running',
  done: 'Exit 0',
  failed: 'Failed',
  denied: 'Refused',
  stopped: 'Stopped',
  background: 'Running in the background',
  unknown: 'Didn’t report how it ended',
};
export const GLYPH = { running: 'running', done: 'done', failed: 'failed', denied: 'failed', stopped: 'failed', background: 'running', unknown: 'unknown' };

/**
 * Every command in s, the view’s summary, as items that open on their output.
 * @param {any} s
 * @param {{ threadId: string, item: Function, load: Function, loaded: Map<string, any>, win: Function }} view  the view’s
 *   conversation, its item(), its requests and what they returned, and its windows (app/js/work-window.mjs)
 */
export function commandsSection(s, { threadId, item, load, loaded, win }) {
  // In the order they ran, so the newest are at the end (#618).
  const ids = { idOf: (c) => c.id, elId: (c) => `wsum-${c.id}` };
  const { items, above, below } = win('commands', s.commands, { ...ids, newest: 'end', before: 'earlier command', after: 'later command' });
  return section(
    'work-commands',
    'Commands',
    s.commands.length,
    above,
    s.commands.length
      ? h(
          'div.work-items',
          items.map((c) =>
            item(
              c.id,
              `cmd-${c.state}`,
              [
                h(`span.g.g-${GLYPH[c.state] ?? 'done'}`, { role: 'img', 'aria-label': COMMAND_WORDS[c.state] ?? c.state }),
                c.description ? h('span.work-cmd-line', c.description) : h('code.work-cmd-line', `$ ${commandLabel(c, folders(threadId, c))}`),
                h(
                  'span.small.work-exit',
                  { class: c.state === 'failed' || c.state === 'denied' ? 'bad' : '' },
                  c.state === 'failed' && c.exit != null ? `Exit ${c.exit}` : (COMMAND_WORDS[c.state] ?? c.state),
                  c.ms ? ` · ${dur(c.ms)}` : '',
                ),
                c.background ? h('span.work-tag', 'Background') : null,
                h('span.small.dim.work-who', who(c)),
              ],
              () => commandBody(c, { threadId, load, loaded }),
            ),
          ),
        )
      : h('p.empty-note', 'No commands yet.'),
    below,
  );
}

/** Folders a command’s leading `cd` may name: the project’s and its agent’s, as the turn’s list leaves out. */
const folders = (threadId, c) => [S().projects?.[S().threads[threadId]?.projectId]?.folder, S().personas?.[S().sessions?.[c.sessionId]?.personaId]?.folder];
function commandBody(c, { threadId, load, loaded }) {
  const key = `out:${c.id}`;
  if (c.state !== 'running' && c.output?.sha256) load(`${key}:${c.output.sha256}`, `/api/threads/${threadId}/work/commands/${c.id}/output`, 'text');
  const out = c.output?.sha256 ? loaded.get(`${key}:${c.output.sha256}`) : '';
  return [
    h('pre.md-code.work-cmd-full', h('code', c.command)),
    h('p.small.dim', `Started ${timeOf(c.startedAt)}${c.who ? ` by the subagent ${c.who}` : ''}.`),
    c.keptRunning
      ? h(
          'p.small.dim',
          c.leftRunning
            ? 'You kept it running when you stopped its agent.'
            : c.state === 'stopped'
              ? `You kept it running when you stopped its agent, then ${c.stoppedBy === 'you' ? 'you' : 'Postbox'} stopped it.`
              : 'You kept it running when you stopped its agent. It has ended; Postbox saw its process go, not its exit.',
        )
      : c.leftRunning
        ? h('p.small.dim', 'It was still running in the background when the turn ended, so Postbox didn’t see it end.')
        : null,
    c.endedInBackground ? h('p.small.dim', backgroundNote(c)) : null,
    c.output?.cut ? h('p.small.dim', 'Earlier output was cut: this is the last 4 MB.') : null,
    c.state === 'running'
      ? h('p.small.dim', 'Its output shows here when it ends.')
      : !c.output?.sha256
        ? h('p.small.dim', 'No output.')
        : out === undefined
          ? h('p.small.dim', 'Loading the output…')
          : typeof out === 'object'
            ? h('p.small.dim', `The output didn’t load: ${out.error}`)
            : h('pre.md-code.cmd-out', { tabindex: '0', 'aria-label': `Output of ${c.command.split('\n')[0]}` }, h('code', out)),
  ];
}
