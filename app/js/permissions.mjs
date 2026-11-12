// The permissions panel (#66): what one agent may do in one conversation, and why, without a terminal. Reached from
// the conversation’s ⋯ › Permissions…, the persona editor, and /permissions in the composer. It shows:
// - the mode, which is the persona’s, for every conversation;
// - the rules, in Claude Code’s order (deny, ask, allow), each with where it comes from: your user settings, the
//   project’s shared settings, this folder’s local settings, this conversation, or the persona’s Tools;
// - the folders it may work in, and its MCP servers;
// - an effective view: type a call, see which rule decides it.
// The server reads and writes the settings files (GET /api/permissions, POST /api/permissions/…), so a rule made
// here shows in the CLI’s /permissions, and the reverse.

import { BACKEND_NAMES } from '/shared/agent-facts.mjs';
import { decide } from '/shared/permission-match.mjs';
import { api, client, sessionsOf } from './client.mjs';
import { fill, h, icon } from './dom.mjs';
import { checkField } from './hosts-parts.mjs';
import { hooksSection } from './permission-hooks.mjs';
import { mcpSection } from './permission-mcp.mjs';
import { MODES } from './run-choice.mjs';
import { capsOf, openFolderPicker } from './sheets.mjs';
import { keepFocus, openDialog, say, toast } from './ui.mjs';

export { MODES } from './run-choice.mjs';

const S = () => client.state;

/** What a folder in the panel is to the agent: where it works, the project’s, read only (#338), or where it came from. */
function folderLabel(f) {
  if (f.source === 'folder') return 'Where it works';
  if (f.source === 'project') return 'The project’s folder';
  if (f.source === 'read') return 'Read only, in this conversation';
  return `From ${SOURCE[f.source]}`;
}

const SOURCE = {
  user: 'your user settings',
  project: 'the project’s shared settings',
  local: 'this folder’s local settings',
  conversation: 'this conversation',
  host: 'Postbox, for its host',
  tools: 'the persona’s Tools',
  publishing: '“Can publish outside Postbox” is off',
  writes: 'Postbox’s check on writes outside it',
  postbox: 'Postbox’s own tools',
  folder: 'where it works',
};
const FILE = { user: '~/.claude/settings.json', project: '.claude/settings.json', local: '.claude/settings.local.json' };
const BEHAVIOR = { deny: 'Deny', ask: 'Ask', allow: 'Allow' };
// The tool picker, with an example for each, from Claude Code’s rule syntax (shared/permission-match.mjs).
const TOOLS = [
  ['Bash', 'npm test:*', 'A command, a prefix with :*, or a glob: npm test:*, git * main'],
  ['Read', './src/**', 'Paths: ./src/** (here), /docs/** (the folder’s root), ~/.zshrc, //tmp/x'],
  ['Edit', './src/**', 'Covers Edit, Write and NotebookEdit. Paths as for Read.'],
  ['WebFetch', 'domain:example.com', 'A site: domain:example.com, or domain:*.example.com'],
  ['WebSearch', '', 'Every web search; it takes no pattern.'],
  ['Agent', 'Explore', 'A subagent by name: Explore, general-purpose'],
  ['mcp', 'mcp__github__create_issue', 'A server’s tools: mcp__github, or one tool: mcp__github__create_issue'],
];
const EXAMPLES = ['Bash(npm test)', 'WebFetch(https://example.com/x)', 'Read(src/a.js)', 'mcp__github__create_issue'];

/**
 * For an agent on a host (#120): the rules listed are this computer’s files, and its Claude Code reads the host’s.
 * @param {any} view  permissionsView’s
 */
/** What a backend that doesn’t read Claude Code’s rules or MCP config honors instead (the Kiro CLI, #117). */
function backendNote(p) {
  const intro = `${p.handle} runs on ${BACKEND_NAMES[p.backend] ?? p.backend}, which doesn’t read Claude Code’s rules or MCP servers.`;
  if (p.backend === 'codex')
    return `${intro} Ask me uses read-only; Auto uses workspace-write, with network on if it may fetch the web, and Codex’s reviewer judges what the sandbox stops; Accept edits uses workspace-write with network off; Run everything has full access and no approval prompts. Of its Tools, only Web counts, for network in Auto. Always allow on its card saves a Codex rule: a matching command then runs outside Codex’s sandbox, with no card, in every Codex session on this computer.`;
  // Antigravity’s Auto runs what its Tools allow (#416), so they decide there, and its mode decides in the others.
  if (p.backend === 'antigravity-cli')
    return `${intro} In Auto its Tools decide what runs with no card, and in Ask me and Accept edits its mode decides what asks first.`;
  if (capsOf(p.backend).tools === 'none') return `${intro} Its mode decides what it may do.`;
  return `${intro} Its mode and its Tools decide what it may do.`;
}

/** Which rule decides a call, in words: a deny, ask or allow rule, or, when none covers it, the mode. */
function verdictOf(v, part, mode, handle) {
  const rule = h('code', v.rule);
  if (v.decision === 'deny') return [h('b', 'Refused'), ' by the deny rule ', rule, ` from ${SOURCE[v.source]}`, part, '.'];
  if (v.decision === 'ask') return [h('b', 'Asks you'), ': the ask rule ', rule, ` from ${SOURCE[v.source]}`, part, '.'];
  if (v.decision === 'allow') return [h('b', 'Runs'), ': the allow rule ', rule, ` from ${SOURCE[v.source]}.`];
  const outcome = { outcome: '', runs: 'it runs', asks: `${handle} asks you`, decides: 'auto mode’s safety check decides, and asks you if it can’t' }[
    v.outcome
  ];
  return ['No rule covers it', part, `, so ${mode} mode decides: `, h('b', outcome ?? ''), '.'];
}

/** Where a listed rule comes from, in words: a host rule names its host. @param {{ source: string, host?: string }} r */
const fromOf = (r) => (r.source === 'host' ? `Postbox, for ${r.host}` : SOURCE[r.source]);

function hostNote({ persona: p, readsRules }) {
  if (!readsRules || !p.host) return null;
  const user = p.usesHostSetup ? ', and your ~/.claude/settings.json there' : '';
  return h(
    'p.help',
    `${p.handle} runs on ${p.host}, where Claude Code reads the agent folder’s settings files there${user}, not the ones listed here from this computer. Its mode, its Tools, this conversation’s rules and what you always allowed from its cards there still apply.`,
  );
}

/**
 * Opens the panel. In a room, it starts on the agent the composer replies to, and offers the others.
 * @param {{ threadId?: string|null, sessionId?: string|null, personaId?: string|null, projectId?: string|null, focus?: 'mcp'|'folders'|null }} who
 */
export function openPermissions({ threadId = null, sessionId = null, personaId = null, projectId = null, focus = null } = {}) {
  const t = threadId ? S().threads[threadId] : sessionId ? S().threads[S().sessions[sessionId]?.threadId] : null;
  const agents = t ? sessionsOf(t.id).filter((x) => !x.retiredFork) : [];
  let current = sessionId ?? (t ? (S().sessions[t.lastSpeaker]?.id ?? agents[0]?.id) : null) ?? null;
  /** @type {any} */
  let view = null;
  let error = '';
  let status = '';
  let mcp = null;
  const draft = { behavior: 'allow', tool: 'Bash', pattern: '', where: 'local', call: '' };
  const body = h('div.perm-panel');

  const target = () => (current ? { sessionId: current } : { personaId, projectId });
  async function load() {
    try {
      const q = new URLSearchParams(Object.entries(target()).filter(([, v]) => v));
      view = await api(`/api/permissions?${q}`, undefined, 'GET');
      error = '';
      if (view.real && view.readsRules) loadMcp();
    } catch (e) {
      error = e.message;
    }
    paint();
  }
  function loadMcp() {
    const q = new URLSearchParams({ personaId: view.persona.id, ...(view.projectId ? { projectId: view.projectId } : {}) });
    api(`/api/mcp-servers?${q}`, undefined, 'GET').then(
      (r) => {
        mcp = r.servers ?? [];
        paint();
      },
      (e) => {
        mcp = { error: e.message };
        paint();
      },
    );
  }
  const paint = () => keepFocus(body, () => fill(body, ...content()));
  /** Runs a change, then reloads the panel and says what happened. */
  const change = async (fn, done) => {
    try {
      const r = await fn();
      status = typeof done === 'function' ? done(r) : done;
      say(status);
    } catch (e) {
      toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' });
    }
    await load();
  };

  function content() {
    if (error) return [h('p.err', icon('warn'), error)];
    if (!view) return [h('p.help', 'Reading its settings…')];
    const p = view.persona;
    return [
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
                      mcp = null;
                      status = '';
                      void load();
                    },
                  },
                  se.handle,
                ),
              ),
            ),
          )
        : null,
      status ? h('p.small.perm-status', { role: 'status' }, status) : null,
      view.real ? hostNote(view) : h('p.help', `${p.handle} is a mock agent. Modes, rules and folders apply to Claude Code and Agent SDK agents.`),
      // A backend that doesn’t read Claude Code’s rules or MCP config (the Kiro CLI, #117) shows only what it honors.
      view.real && !view.readsRules ? h('p.help', backendNote(p)) : null,
      view.readsRules ? rulesSection() : null,
      view.real ? folderSection() : null,
      view.real && view.readsRules ? hooksSection(view, SOURCE) : null,
      view.real && view.readsRules ? mcpSection(p, mcp, change) : null,
      view.real && view.readsRules ? effectiveSection(p) : null,
    ];
  }

  /** Every rule, by behavior, each with its source and whether Postbox may remove it; forDecide: only those that apply. */
  function allRules(forDecide = false) {
    /** @type {Record<'deny'|'ask'|'allow', { rule: string, source: string, root?: string, removable: boolean, hostId?: string, host?: string }[]>} */
    const out = { deny: [], ask: [], allow: [] };
    for (const f of view.files)
      for (const b of /** @type {const} */ (['deny', 'ask', 'allow']))
        for (const rule of f[b]) out[b].push({ rule, source: f.source, root: f.source === 'user' ? view.home : view.folder, removable: f.writable });
    if (view.conversation)
      for (const b of /** @type {const} */ (['deny', 'ask', 'allow']))
        for (const rule of view.conversation[b]) out[b].push({ rule, source: 'conversation', removable: true });
    // Always allow on a host’s card (#120): kept by Postbox for that host, and sent with each turn there. Only the current
    // host’s decide a call; another host’s are listed so they can be removed.
    for (const r of view.hostRules ?? [])
      if (r.current || !forDecide) out.allow.push({ rule: r.rule, source: 'host', hostId: r.hostId, host: r.host, removable: true });
    for (const x of view.tools) if (!x.on) for (const rule of x.rules) out.deny.push({ rule, source: 'tools', removable: false });
    for (const rule of view.publishing) out.deny.push({ rule, source: 'publishing', removable: false });
    for (const rule of view.writes?.rules ?? []) out.ask.push({ rule, source: 'writes', unless: view.writes.unless, removable: false });
    out.allow.push({ rule: 'mcp__postbox', source: 'postbox', removable: false });
    return out;
  }

  function rulesSection() {
    const rules = allRules();
    const p = view.persona;
    const unreadable = view.files.filter((f) => f.error);
    const list = (b) => {
      // The persona’s Tools and the publishing list are many rules with one cause each: one row per cause.
      const own = rules[b].filter((r) => r.source !== 'tools' && r.source !== 'publishing' && r.source !== 'writes' && r.source !== 'postbox');
      const rows = own.map((r) =>
        h(
          'li',
          h('code.perm-rule', r.rule),
          h('span.small.dim.grow', `from ${fromOf(r)}`),
          r.removable && view.real
            ? h(
                'button.btn.sm.ghost',
                {
                  type: 'button',
                  'aria-label': `Remove the ${b} rule ${r.rule} from ${fromOf(r)}`,
                  onclick: () =>
                    change(
                      () =>
                        api('/api/permissions/rules', {
                          ...target(),
                          behavior: b,
                          rule: r.rule,
                          where: r.source === 'conversation' ? 'conversation' : r.source,
                          ...(r.source === 'host' ? { hostId: r.hostId } : {}),
                          remove: true,
                        }),
                      `Removed ${r.rule} from ${fromOf(r)}. It applies from ${p.handle}’s next turn.`,
                    ),
                },
                icon('x', 'i-sm'),
                'Remove',
              )
            : r.source === 'project'
              ? h('span.small.dim', 'Shared with your team')
              : null,
        ),
      );
      if (b === 'deny') {
        for (const x of view.tools.filter((y) => !y.on))
          rows.push(
            h(
              'li',
              h('code.perm-rule', x.rules.join(', ')),
              h('span.small.dim.grow', `from ${SOURCE.tools}: ${x.id} is unticked`),
              h(
                'button.btn.sm',
                {
                  type: 'button',
                  onclick: () =>
                    change(
                      () => api(`/api/personas/${p.id}`, { tools: [...new Set([...(S().personas[p.id]?.tools ?? []), x.id])] }, 'PATCH'),
                      `Ticked ${x.id} for ${p.handle}. It applies from its next turn; the mode still decides each call.`,
                    ),
                },
                `Tick ${x.id}`,
              ),
            ),
          );
        if (view.publishing.length)
          rows.push(
            h(
              'li',
              h('span.grow', h('code.perm-rule', `${view.publishing.slice(0, 3).join(', ')}…`), h('span.small.dim', ` and ${view.publishing.length - 3} more`)),
              h('span.small.dim', `from ${SOURCE.publishing}`),
            ),
          );
      }
      // Writes outside Postbox (#112): many rules with one cause, and what lets a call through without asking.
      if (b === 'ask' && view.writes?.rules.length) rows.push(writesRow(view.writes));
      // In Auto the harness decides writes (harness first), but when it asks about one you asked for, this still applies.
      if (b === 'ask' && (view.writes?.rules.length || p.permissionMode === 'auto')) rows.push(requestedRow(p, change));
      if (b === 'allow')
        rows.push(h('li', h('code.perm-rule', 'mcp__postbox'), h('span.small.dim.grow', `from ${SOURCE.postbox}: they only show things here`)));
      return h(
        'div.perm-list',
        h('h4.label', { id: `perm-${b}` }, BEHAVIOR[b]),
        rows.length ? h('ul.list-rows', { 'aria-labelledby': `perm-${b}` }, rows) : h('p.small.dim', 'None.'),
      );
    };
    return section(
      'Rules',
      h('span.help', 'Claude Code checks deny rules first, then ask, then allow; the mode decides the rest.'),
      ...unreadable.map((f) => h('p.err', icon('warn'), f.error)),
      list('deny'),
      list('ask'),
      list('allow'),
      view.real ? addRule(p) : null,
    );
  }

  function addRule(p) {
    const tool = TOOLS.find(([id]) => id === draft.tool) ?? TOOLS[0];
    const rule = () => {
      const pattern = draft.pattern.trim();
      if (tool[0] === 'mcp') return pattern;
      return pattern ? `${tool[0]}(${pattern})` : tool[0];
    };
    const preview = h('code.perm-rule', rule() || '…');
    const where = [
      ['local', `This folder (${FILE.local})`],
      ...(view.conversation ? [['conversation', 'This conversation only']] : []),
      // The real path: CLAUDE_CONFIG_DIR can move it from ~/.claude.
      ...(p.usesHostSetup ? [['user', `Your user settings (${view.files.find((f) => f.source === 'user')?.file ?? FILE.user})`]] : []),
    ];
    if (!where.some(([id]) => id === draft.where)) draft.where = 'local';
    const select = (id, label, options, key) =>
      h(
        'div.field',
        h('label.label', { for: id }, label),
        h(
          'div.select-wrap',
          h(
            'select.select',
            {
              id,
              onchange: (e) => {
                draft[key] = e.target.value;
                if (key === 'tool') draft.pattern = '';
                paint();
              },
            },
            options.map(([v, l]) => h('option', { value: v, selected: draft[key] === v }, l)),
          ),
          icon('down'),
        ),
      );
    return h(
      'div.perm-add',
      h('h4.label', 'Add a rule'),
      h(
        'div.form-grid',
        select(
          'perm-b',
          'It',
          [
            ['allow', 'Allow'],
            ['ask', 'Ask'],
            ['deny', 'Deny'],
          ],
          'behavior',
        ),
        select(
          'perm-t',
          'Tool',
          TOOLS.map(([id]) => [id, id === 'mcp' ? 'An MCP server or tool' : id]),
          'tool',
        ),
        h(
          'div.field.span',
          h('label.label', { for: 'perm-p' }, tool[0] === 'mcp' ? 'Server or tool' : 'Pattern'),
          h('input.input.mono', {
            id: 'perm-p',
            value: draft.pattern,
            placeholder: tool[1] || 'Leave empty for every use',
            spellcheck: 'false',
            autocomplete: 'off',
            'aria-describedby': 'perm-p-help',
            disabled: tool[0] === 'WebSearch',
            oninput: (e) => {
              draft.pattern = e.target.value;
              preview.textContent = rule() || '…';
            },
          }),
          h('span.help', { id: 'perm-p-help' }, `${tool[2]}${tool[0] === 'mcp' ? '' : ' Leave it empty for every use.'}`),
        ),
        select('perm-w', 'Save in', where, 'where'),
        h(
          'div.field',
          h('span.label', 'Rule'),
          h(
            'div.row-flex',
            preview,
            h(
              'button.btn.send',
              {
                type: 'button',
                onclick: () => {
                  const r = rule();
                  if (!r) return toast({ title: 'Write the rule first', text: 'Name an MCP server or tool, such as mcp__github.' });
                  void change(
                    () => api('/api/permissions/rules', { ...target(), behavior: draft.behavior, rule: r, where: draft.where }),
                    `Added ${r} to ${SOURCE[draft.where]}. It applies from ${p.handle}’s next turn.`,
                  ).then(() => {
                    draft.pattern = '';
                    paint();
                  });
                },
              },
              'Add rule',
            ),
          ),
        ),
      ),
    );
  }

  function folderSection() {
    const se = current ? S().sessions[current] : null;
    const tId = se ? S().threads[se.threadId]?.projectId : view.projectId;
    const path = h('input.input.mono', {
      id: 'perm-dir',
      placeholder: '/full/path/to/a/folder',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-describedby': 'perm-dir-help',
    });
    const add = (p) =>
      change(
        () => api('/api/permissions/folders', { sessionId: current, path: p }),
        (r) => `${view.persona.handle} may work in ${r.path} from its next turn.`,
      );
    return section(
      'Folders',
      h(
        'ul.list-rows',
        view.folders.map((f) =>
          h(
            'li',
            icon('folder', 'dim'),
            h('span.mono.grow.perm-path', f.path),
            h('span.small.dim', folderLabel(f)),
            f.source === 'conversation' || f.source === 'read'
              ? h(
                  'button.btn.sm.ghost',
                  {
                    type: 'button',
                    'aria-label': `Remove ${f.path}`,
                    onclick: () =>
                      change(
                        () => api('/api/permissions/folders', { sessionId: current, path: f.path, remove: true, read: f.source === 'read' }),
                        `Removed ${f.path} from this conversation.`,
                      ),
                  },
                  icon('x', 'i-sm'),
                  'Remove',
                )
              : null,
          ),
        ),
      ),
      se
        ? h(
            'div.row-flex.perm-dir-add',
            h(
              'button.btn.sm',
              { type: 'button', disabled: !tId, onclick: () => openFolderPicker(tId, (rel) => add(rel), { folders: true }) },
              icon('folder', 'i-sm'),
              'Add folder…',
            ),
            h('label.sr-only', { for: 'perm-dir' }, 'A folder’s full path'),
            path,
            h('button.btn.sm', { type: 'button', onclick: () => path.value.trim() && add(path.value.trim()) }, 'Add'),
          )
        : null,
      h(
        'span.help',
        { id: 'perm-dir-help' },
        se ? 'Folders you add here are for this conversation, from the agent’s next turn.' : 'Open the panel from a conversation to add a folder for it.',
      ),
    );
  }

  function effectiveSection(p) {
    const out = h('div.perm-verdict', { role: 'status', 'aria-live': 'polite' });
    const show = () => {
      const call = draft.call.trim();
      if (!call) return fill(out, h('span.small.dim', `Try ${EXAMPLES.join(', ')}.`));
      const v = decide({ call, rules: allRules(true), mode: p.permissionMode, cwd: view.folder ?? '/', home: view.home });
      const part = v.part ? h('span', ' (for ', h('code', v.part), ')') : null;
      const mode = MODES.find(([id]) => id === v.mode)?.[1] ?? v.mode;
      fill(out, h('p', ...verdictOf(v, part, mode, p.handle)));
    };
    show();
    return section(
      'Which rule decides?',
      h(
        'div.field',
        h('label.label', { for: 'perm-call' }, 'A tool call'),
        h('input.input.mono', {
          id: 'perm-call',
          value: draft.call,
          placeholder: 'Bash(npm test)',
          spellcheck: 'false',
          autocomplete: 'off',
          'aria-describedby': 'perm-call-help',
          oninput: (e) => {
            draft.call = e.target.value;
            show();
          },
        }),
      ),
      out,
      h(
        'span.help',
        { id: 'perm-call-help' },
        'Claude Code has the final say: hooks, managed settings and its own checks, such as files outside its folders, can still change the answer.',
      ),
    );
  }

  const section = (title, ...children) => h('section.perm-sec', h('h3.label', title), ...children);

  const se0 = current ? S().sessions[current] : null;
  const whose = se0?.handle ?? (personaId ? (S().personas[personaId]?.handle ?? 'agent') : null);
  const title = whose ? `${whose}’s permissions` : 'Permissions';
  openDialog({
    title,
    sub: t ? `In “${t.title}”` : 'Its rules, in the folder of its latest conversation',
    body: [body],
    size: 'lg',
    initialFocus: () => body.querySelector('[role="radio"][aria-checked="true"], button, input'),
  });
  paint();
  void load().then(() => {
    if (focus) document.getElementById(focus === 'mcp' ? 'perm-mcp' : 'perm-dir')?.scrollIntoView({ block: 'center' });
  });
}

/**
 * The ask rules for writes outside Postbox (#112) as one row: many rules with one cause, and what lets a call through
 * without asking. Moved out of openPermissions.
 * @param {{ rules: string[], unless: string[] }} writes
 */
function writesRow(writes) {
  return h(
    'li',
    h(
      'span.grow',
      h('code.perm-rule', `${writes.rules.slice(0, 3).join(', ')}…`),
      h('span.small.dim', ` and ${writes.rules.length - 3} more, from ${SOURCE.writes}`),
      h(
        'span.small.dim',
        `: tools and gh commands that create, change or delete something outside Postbox, and git push. Always allow on a card lets that one tool through${writes.unless.length ? ', and so does “Can publish outside Postbox” for the tools it covers' : ''}.`,
      ),
    ),
  );
}

/**
 * Whether, in Auto, a call the person asked for runs without a card (#296): on unless the persona turns it off.
 * @param {{ id: string, handle: string, allowRequested?: boolean }} p @param {(fn: () => Promise<any>, done: string) => Promise<void>} change
 */
function requestedRow(p, change) {
  return h(
    'li',
    checkField({
      id: 'perm-requested',
      label: 'Writes you asked for run without a card',
      help: `In Auto mode, when Claude Code asks about a write outside Postbox that you asked ${p.handle} for, it runs without a card: one a confirm you confirmed shows word for word, or one your message asks for, as a quick check by Claude Haiku finds. That check sends the call and your message to Anthropic. Each such write leaves a line in the conversation with Stop, five at most a turn. Only plain pushes, gh creates, comments and edits, and tools that create or edit can pass; deletes, merges, force pushes, your own ask rules and Ask me mode always ask.`,
      on: p.allowRequested !== false,
      onToggle: (on) =>
        change(
          () => api(`/api/personas/${p.id}`, { allowRequested: on }, 'PATCH'),
          on ? `Calls you ask ${p.handle} for run without a card.` : `Every call that comes to Postbox asks you first, even one you asked for.`,
        ),
    }),
  );
}
