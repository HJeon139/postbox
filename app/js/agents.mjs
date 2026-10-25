// The agents in a conversation (#105): one row each in the sidebar with its ring, name, state, what it runs with and its
// open asks, and a quick panel behind each row and each ring in the
// top bar. The panel changes the model, effort, permission mode and tools in two clicks, without a command, and
// says the scope of each: model and effort are this conversation’s, mode and tools the persona’s, everywhere.
//
// Under each row, the room’s agent tree (#121), in agent-tree.mjs: where the agent’s turn is when it’s in a side or
// topic thread, then the subagents at work in its turn (#73), its only children (#228), each under the one that
// started it, with what it was asked and what it’s doing now, a line each, without hover.

import { BACKEND_NAMES, chipEffort, chipModel, shortModel } from '/shared/agent-facts.mjs';
import { factsOf, isMock, mockMarker } from './agent-facts.mjs';
import { paintSubagents, subagentsOf, treeEntry, treeOf, treeSig } from './agent-tree.mjs';
import { api, busy, client, hrefOf, itemsOf, sessionsOf, stopSession } from './client.mjs';
import { fill, h, syncList } from './dom.mjs';
import { panelShown, panelWhileNeeds } from './needs-nav.mjs';
import { openAsksEl } from './open-asks.mjs';
import { MODES, openPermissions } from './permissions.mjs';
import { ringFor, stateWord } from './ring.mjs';
import { capsOf, EFFORT_NAMES, modeHelp, modelsFor, openSettings } from './sheets.mjs';
import { keepFocus, navigate, openDialog, say, toast } from './ui.mjs';

export { subagentNow } from './agent-tree.mjs';

const S = () => client.state;

// ── The section ─────────────────────────────────────────────────────────────────────────

/**
 * The Agents section for a conversation, in the sidebar: the conversation’s pool, one row per agent, since each has
 * one session there (#228). It keeps itself up to date as agents join, leave, change state or change what they run with.
 * @param {string} threadId
 */
export function agentsSection(threadId) {
  const headId = `agents-head-${threadId}`;
  const list = h('ul.agent-rows', { 'aria-labelledby': headId });
  const el = h('section.agents-sec', h('div.rail-sec', h('h2.label', { id: headId }, 'Agents')), list);
  const paint = () => {
    const ses = sessionsOf(threadId).filter((x) => !x.archived);
    el.hidden = !ses.length;
    syncList(
      list,
      ses,
      (se) => se.id,
      (se) => agentRow(se),
      (n, se) => paintRow(n, se),
    );
  };
  paint();
  const off = client.on((ch) => {
    if (ch.type === 'session' && ch.data.threadId !== threadId && S().threads[ch.data.threadId]?.parentId !== threadId) return;
    if (['session', 'thread', 'persona', 'load', 'remove'].includes(ch.type)) paint();
  });
  return { el, destroy: off };
}

/**
 * Who is in a topic thread, in one line for its panel (#228): the agent it started with, and the ones that answered
 * there. Each answers from its one session in the conversation, so the thread has no list of agents of its own.
 * @param {string} threadId
 */
export function inThreadLine(threadId) {
  const el = h('p.small.dim');
  const paint = () => {
    const said = itemsOf(threadId).filter((i) => i.kind === 'agent' && i.handle);
    const names = [...new Set([S().threads[threadId]?.woke, ...said.map((i) => i.handle)].filter(Boolean))].map((x) => `@${x}`);
    const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
    const text = list ? `${list} ${names.length > 1 ? 'are' : 'is'} in this thread.` : 'No agent is in this thread yet. @-mention one to bring it in.';
    if (el.textContent !== text) el.textContent = text;
  };
  paint();
  const off = client.on((ch) => {
    if (['item.add', 'thread', 'load'].includes(ch.type)) paint();
  });
  return { el, destroy: off };
}

/** One agent’s row: a button that opens its quick panel, and its open asks under it. */
function agentRow(se) {
  const button = h('button.agent-btn', {
    type: 'button',
    id: `agent-row-${se.id}`,
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
    onclick: () => openAgentPanel(se.id, button),
  });
  // Its ring is made once and kept, so its animation keeps running; the words beside it repaint.
  const ring = ringFor(se, 'sm');
  ring.dataset.session = se.id;
  button.append(h('span.ring-slot', { 'aria-hidden': 'true' }, ring), h('span.name'));
  const n = h(
    'li.agent-row',
    button,
    h('div.agent-asks', openAsksEl(se, true), panelWhileNeeds(se, button, openAgentPanel)),
    h('ul.agent-subs', { 'aria-label': `Where @${se.handle} is at work, and its subagents` }),
  );
  paintRow(n, se, true);
  return n;
}

function paintRow(n, se, fresh = false) {
  const f = factsOf(se);
  const runs = f.mock ? '' : `${chipModel(f)} · ${chipEffort(f)}`;
  const joined = joinedWhy(se);
  const sig = JSON.stringify([se.handle, f.mock, se.state, runs, joined]);
  ringFor(se, 'sm', n.querySelector('.agent-btn pb-ring'));
  const tree = treeOf(se);
  const subagents = subagentsOf(se);
  const subs = n.querySelector('.agent-subs');
  subs.hidden = !tree.length && !subagents.length;
  if (fresh || subs.dataset.sig !== treeSig(tree)) {
    subs.dataset.sig = treeSig(tree);
    subs.replaceChildren(...tree.map(treeEntry), ...subs.querySelectorAll(':scope > li.subagent'));
  }
  paintSubagents(subs, tree.length, subagents, se);
  if (!fresh && n.dataset.sig === sig) return;
  n.dataset.sig = sig;
  fill(
    n.querySelector('.agent-btn .name'),
    h('span', h('b', `@${se.handle}`), mockMarker(se), h('span.agent-state', ` · ${stateWord(se.state).toLowerCase()}`)),
    runs ? h('span.sub', runs) : null,
    joined ? h('span.sub', joined) : null,
  );
}

/**
 * Why an agent the person never added is in the conversation: another agent woke it, or they @-mentioned it, in a side
 * thread, and it joined to answer (#110). null for one the person added.
 */
export function joinedWhy(se) {
  if (!se.joinedBy) return null;
  return se.joinedBy === 'you' ? 'Joined when you @-mentioned it in a side thread' : `Joined when @${se.joinedBy} woke it`;
}

// ── The quick panel ─────────────────────────────────────────────────────────────────────

// Each tool switch says what turning it off means (#104): the agent can’t tell you, and the panel is where you look.
const QUICK_TOOLS = [
  ['shell', 'Shell', 'Off: it can’t run commands. It can still read and search files.'],
  ['web.fetch', 'Web', 'Off: it can’t fetch pages or search the web.'],
  ['agents.outside', 'Agents outside Postbox', 'Off: it can’t message, schedule or start agents outside Postbox.'],
];

/**
 * Opens an agent’s quick panel, beside the row or ring it came from (a full sheet in a narrow window).
 * @param {string} sessionId @param {HTMLElement | null} [from]
 */
export function openAgentPanel(sessionId, from = null) {
  const first = S().sessions[sessionId];
  if (!first) return;
  const t = S().threads[first.threadId];
  const where = t?.kind === 'topic' ? 'this thread' : t?.kind === 'side' ? 'this side thread' : 'this conversation';
  let status = '';
  /** @type {{ close: () => void, dialog: HTMLElement } | null} */
  let dlg = null;
  const body = h('div.qp');
  const title = h('span');
  const sub = h('span');
  const done = (text) => {
    status = text;
    say(text);
    paint();
  };
  const failed = (e) => toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' });

  const paint = () => {
    const se = S().sessions[sessionId];
    if (!se || se.archived) {
      dlg?.close();
      return;
    }
    const p = S().personas[se.personaId] ?? {};
    const f = factsOf(se);
    const mock = isMock(se);
    fill(title, `@${se.handle}`, mockMarker(se));
    fill(sub, `${stateWord(se.state)} · ${se.ctx ?? 0}% of context used · ${mock ? BACKEND_NAMES.mock : (BACKEND_NAMES[f.backend] ?? f.backend)}`);
    keepFocus(body, () =>
      fill(
        body,
        h(
          'div.qp-asks',
          openAsksEl(se, true, () => dlg?.close()),
        ),
        // This conversation’s: the session’s snapshot, as /model and /effort set it.
        mock
          ? h('p.help', 'A mock agent runs scripted replies, so it has no model, effort or permission mode to change.')
          : section(
              `In ${where}`,
              `From its next turn, as /model and /effort set them.`,
              choice(
                'Model',
                where,
                [...new Set([...modelsFor(f.backend), f.setModel])].map((m) => [m, shortModel(m)]),
                f.setModel,
                (id, name) =>
                  api(`/api/sessions/${se.id}/run`, { model: id }).then(
                    (r) => done(`Model: ${name} for @${se.handle} in ${where}, ${r.now ? 'from now: its running turn changed too' : 'from its next turn'}.`),
                    failed,
                  ),
              ),
              choice(
                'Effort',
                where,
                (client.config.effortLevels ?? Object.keys(EFFORT_NAMES)).map((l) => [l, EFFORT_NAMES[l] ?? l]),
                f.setEffort,
                (id, name) =>
                  api(`/api/sessions/${se.id}/run`, { effort: id }).then(
                    (r) =>
                      done(
                        `Effort: ${name.toLowerCase()} for @${se.handle} in ${where}, ${r.now ? 'from now: its running turn changed too' : 'from its next turn'}.`,
                      ),
                    failed,
                  ),
              ),
            ),
        // The persona’s, in every conversation it’s in.
        section(
          `For @${se.handle} everywhere`,
          'Its persona: every conversation it’s in, from their next turns.',
          mock ? null : modeChoice(se, p, done, failed),
          h(
            'div.field',
            h('span.label', 'Tools'),
            h(
              'div.qp-tools',
              QUICK_TOOLS.filter(([id]) => (client.config.knownTools ?? []).some(([k]) => k === id)).map(([id, name, off]) =>
                toolSwitch(se, p, id, name, off, done, failed),
              ),
            ),
          ),
          h(
            'div.row-flex.wrap',
            !mock && capsOf(f.backend).permissions !== 'none'
              ? h(
                  'button.btn.sm',
                  { type: 'button', onclick: () => handOff(() => openPermissions({ threadId: se.threadId, sessionId: se.id })) },
                  'Rules, folders and MCP…',
                )
              : null,
            h('button.btn.sm', { type: 'button', onclick: () => handOff(() => openSettings('personas', se.personaId)) }, 'Edit persona…'),
          ),
        ),
        // Announced once by say(); a live region here would be read again on every repaint.
        status ? h('p.small.perm-status', status) : null,
        h(
          'div.qp-actions',
          h(
            'button.btn.sm',
            {
              type: 'button',
              // Not while it’s already stopping (#126): it says so in the row and the panel’s line, and Stop is pressed once.
              disabled: !busy(se),
              onclick: () =>
                stopSession(se).then(
                  // With background jobs running, Stop asks in the conversation whether to stop them too (#129): go there.
                  (r) => (r?.ask ? handOff(() => navigate(hrefOf(se.threadId))) : done(`Stopping @${se.handle}.`)),
                  failed,
                ),
            },
            'Stop',
          ),
          mock
            ? null
            : h(
                'button.btn.sm',
                {
                  type: 'button',
                  disabled: busy(se),
                  onclick: () =>
                    api(`/api/threads/${se.threadId}/agent-command`, { sessionId: se.id, text: '/compact' }).then(
                      () => handOff(() => say(`@${se.handle} is compacting its context.`)),
                      failed,
                    ),
                },
                'Compact',
              ),
          h(
            'button.btn.sm',
            {
              type: 'button',
              onclick: () =>
                api(`/api/sessions/${se.id}/archive`, {}).then(
                  () =>
                    handOff(() => {
                      toast({ title: `Archived @${se.handle}’s session`, action: { label: 'Restore', run: () => api(`/api/sessions/${se.id}/restore`, {}) } });
                      // Its row has gone, so focus has nowhere to go back to: the composer, as after acting in a block.
                      if (document.activeElement === document.body) document.getElementById('composer-input')?.focus();
                    }),
                  failed,
                ),
            },
            'Archive',
          ),
        ),
      ),
    );
  };
  /** Closes the panel (focus goes back to its row or ring), then does what the button leads to. */
  const handOff = (next) => {
    dlg?.close();
    next();
  };
  paint();
  dlg = openDialog({
    title,
    sub,
    body: [body],
    size: 'quick',
    anchor: from,
    onClose: () => {
      off();
      panelShown(sessionId, false);
    },
    // The model’s choice, or for a mock agent its first tool.
    initialFocus: () => body.querySelector('[role=radiogroup] [aria-checked="true"]') ?? body.querySelector('[role=switch]'),
  });
  const off = client.on((ch) => {
    const mine = ch.type === 'session' ? ch.data.id === sessionId : ['item.add', 'item.patch'].includes(ch.type) ? ch.data?.threadId === first.threadId : true;
    if (mine && ['session', 'persona', 'load', 'item.add', 'item.patch'].includes(ch.type)) paint();
  });
  panelShown(sessionId, true);
}

/** A group of settings with one scope, said in its heading. */
function section(heading, help, ...fields) {
  const id = `qp-${Math.random().toString(36).slice(2, 8)}`;
  return h('section.qp-sec', { 'aria-labelledby': id }, h('h3.qp-head', { id }, heading), h('p.help', help), ...fields);
}

/**
 * Segmented choices, named with their scope so a screen reader hears it on each: “Model, in this conversation”.
 * One Tab stop per group: the arrow keys move within it, and Enter or Space picks, since each pick changes the agent.
 */
function choice(label, where, list, value, onPick) {
  const move = (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const radios = [...e.currentTarget.querySelectorAll('[role=radio]')];
    radios[(radios.indexOf(document.activeElement) + step + radios.length) % radios.length]?.focus();
  };
  return h(
    'div.field',
    h('span.label', label),
    h(
      'div.seg.seg-wrap',
      { role: 'radiogroup', 'aria-label': `${label}, in ${where}`, onkeydown: move },
      list.map(([id, name]) =>
        h(
          'button',
          { type: 'button', role: 'radio', 'aria-checked': String(id === value), tabindex: id === value ? '0' : '-1', onclick: () => onPick(id, name) },
          name,
        ),
      ),
    ),
  );
}

function modeChoice(se, p, done, failed) {
  const value = p.permissionMode ?? 'auto';
  return [
    choice(
      'Permission mode',
      `every conversation @${se.handle} is in`,
      MODES.map(([id, name]) => [id, name]),
      value,
      (id, name) =>
        api('/api/permissions/mode', { personaId: se.personaId, mode: id }).then(
          (r) =>
            done(
              `Permission mode: ${name} for @${se.handle} in every conversation, ${r.now.includes(se.handle) ? 'from now: its running turn changed too' : 'from their next turns'}.`,
            ),
          failed,
        ),
    ),
    // In the backend’s own words where it reads the modes differently (Kiro, Codex), as the persona sheet says it.
    h('span.help', modeHelp(p.backend, MODES.find(([id]) => id === value) ?? MODES[0])),
  ];
}

/** A tool as a switch, on the persona: on means not denied; the permission mode still decides (TOOL_RULES). */
function toolSwitch(se, p, id, name, off, done, failed) {
  const on = (p.tools ?? []).includes(id);
  const helpId = `qp-tool-${id.replace(/\W/g, '-')}`;
  return h(
    'div.qp-tool',
    h(
      'button.qp-switch',
      {
        type: 'button',
        role: 'switch',
        'aria-checked': String(on),
        'aria-label': `${name}, for @${se.handle} everywhere`,
        'aria-describedby': helpId,
        onclick: () => {
          // From the persona as it is now, not as it was when the panel painted: another switch may have changed it.
          const now = S().personas[se.personaId]?.tools ?? [];
          const was = now.includes(id);
          const tools = was ? now.filter((x) => x !== id) : [...now, id];
          api(`/api/personas/${se.personaId}`, { tools }, 'PATCH').then(
            () => done(`${name}: ${was ? 'off' : 'on'} for @${se.handle} in every conversation, from their next turns.`),
            failed,
          );
        },
      },
      h('span.track', { 'aria-hidden': 'true' }),
      h('span', name),
      h('span.dim.small', { 'aria-hidden': 'true' }, on ? 'On' : 'Off'),
    ),
    h('span.help', { id: helpId }, off),
  );
}
