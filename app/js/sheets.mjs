// Dialogs: new agent, new conversation, settings (appearance, personas, projects, connection), the command
// palette, the delete confirm, and the project folder picker.

import { codexDefault, modelName } from '/shared/agent-facts.mjs';
import { mockMarker } from './agent-facts.mjs';
import { api, client, sessionsOf, threadsOf } from './client.mjs';
import { ago, fill, h, icon, plural } from './dom.mjs';
import { hostsPanel } from './hosts.mjs';
import { openPermissions } from './permissions.mjs';
import { placeField, saveRefused } from './sheets-place.mjs';
import { connect } from './sheets-settings.mjs';
import { keepFocus, navigate, openDialog, toast, undoToast } from './ui.mjs';

const S = () => client.state;
const toolsInProject = (projectId) =>
  new Set(
    Object.values(S().sessions)
      .filter((se) => S().threads[se.threadId]?.projectId === projectId)
      .flatMap((se) => S().personas[se.personaId]?.tools ?? []),
  );

// ── Backend, model and permissions ──────────────────────────────────────────────────────
// Shared by the new-agent sheet and the persona editor. A persona runs on the mock, on Claude Code (the
// claude CLI you’re signed in to), on the Agent SDK, on the Kiro CLI (#117) or on the Antigravity CLI (#143); real
// backends take a model and a permission mode.

const BACKENDS = [
  ['claude-code', 'Claude Code', 'Runs the claude CLI you’re signed in to.'],
  ['agent-sdk', 'Agent SDK', 'Runs the Claude Agent SDK in Postbox’s server.'],
  ['kiro-cli', 'Kiro CLI', 'Runs the kiro-cli you’re signed in to. It can’t ask you: what would need asking is refused.'],
  ['antigravity-cli', 'Antigravity CLI', 'Runs the agy CLI you’re signed in to, with Gemini models. It can’t ask you: what would need asking is refused.'],
  ['codex', 'Codex', 'Runs the Codex app-server with your local Codex sign-in and configuration.'],
  ['mock', 'Mock agent', 'Scripted replies for trying Postbox out.'],
];
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
/** What a backend can do (server/adapters/adapter.mjs, capabilities), as /api/state serves it (#117). */
export const capsOf = (backend) => client.config.backends?.[backend] ?? {};
/** The models to suggest for a backend: the ones it reported, else Claude’s. */
export const modelsFor = (backend) => capsOf(backend).models ?? MODELS;
// The levels come from the server (server/adapters/setup.mjs, EFFORT_LEVELS); these are their names.
export const EFFORT_NAMES = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };
const PERMISSIONS = [
  ['auto', 'Auto', 'A safety check approves routine actions; it asks you only when it can’t decide.'],
  ['ask', 'Ask me', 'It asks before running commands or changing files.'],
  ['acceptEdits', 'Accept edits', 'It edits files in its folders freely, and asks before running commands.'],
  ['bypass', 'Run everything', 'It never asks. Use it only in a folder you can lose.'],
];
// Backends that read the permission modes their own way. The Kiro and Antigravity CLIs run headless, where every ask
// is a refusal (server/adapters/kiro-cli.mjs and antigravity-cli.mjs); Codex maps the modes onto its sandbox and
// approval policy (server/adapters/codex.mjs). The permissions panel uses them too (app/js/permissions.mjs).
const BACKEND_MODES = /** @type {Record<string, Record<string, string>>} */ ({
  'kiro-cli': {
    auto: 'Kiro has no safety check, so this is Ask me: it reads in its folders and runs a few read-only commands, such as git status, and refuses the rest.',
    ask: 'It reads in its folders and runs a few read-only commands, such as git status, and refuses the rest: it can’t ask you.',
    acceptEdits: 'It edits files in its folders freely, and refuses commands that would need asking.',
  },
  'antigravity-cli': {
    auto: 'Antigravity’s auto mode: it edits and runs commands in its sandbox, and a safety check decides the rest. Where your account doesn’t offer it, this is Ask me.',
    ask: 'It reads in its folders and refuses edits and commands that would need asking: it can’t ask you.',
    acceptEdits: 'It edits files in its folders freely, and refuses commands that would need asking.',
  },
  codex: {
    auto: 'Codex uses a workspace-write sandbox with network access off; requests outside it need approval. Auto and Accept edits have the same Codex permissions.',
    ask: 'Codex uses a read-only sandbox. It requests approval before a command can go beyond it.',
    acceptEdits: 'Codex uses a workspace-write sandbox with network access off; requests outside it need approval.',
    bypass: 'Codex runs with full filesystem and network access and no approval prompts.',
  },
});
/** The effort an Antigravity model id names (gemini-3.8-flash-high runs at high), or null (server/adapters/antigravity-cli.mjs). */
const effortNamedBy = (backend, model) => (backend === 'antigravity-cli' ? (/-(low|medium|high)$/.exec(String(model ?? ''))?.[1] ?? null) : null);
/** What a permission mode means on a backend: its own words where it reads the modes differently. */
export const modeHelp = (backend, [id, , help]) => BACKEND_MODES[backend]?.[id] ?? help;
export const defaultBackend = () => BACKENDS.map(([id]) => id).find((id) => (client.config.adapters ?? []).includes(id)) ?? 'mock';

function seg(label, options, value, onPick) {
  return h(
    'div.seg',
    { role: 'radiogroup', 'aria-label': label },
    options.map(([id, name]) =>
      h(
        'button',
        {
          type: 'button',
          role: 'radio',
          'aria-checked': String(value === id),
          onclick: () => onPick(id),
        },
        name,
      ),
    ),
  );
}

/**
 * A labeled checkbox with help text under it, in the sheet’s .check style. Space or Enter toggles it.
 * @param {{ id: string, label: string, help: string, on: boolean, onToggle: (on: boolean) => void }} opts
 */
function checkField({ id, label, help, on, onToggle }) {
  return h(
    'div.field.span',
    h(
      'span.check',
      {
        id,
        role: 'checkbox',
        tabindex: '0',
        'aria-checked': String(on),
        'aria-describedby': `${id}-help`,
        style: { alignSelf: 'flex-start' },
        onclick: (e) => {
          on = !on;
          e.currentTarget.setAttribute('aria-checked', String(on));
          onToggle(on);
        },
        onkeydown: (e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.click();
          }
        },
      },
      h('span.box'),
      h('span', label),
    ),
    h('span.help', { id: `${id}-help` }, help),
  );
}

// What an MCP server’s status and scope say, from GET /api/mcp-servers (server/adapters/mcp-config.mjs).
export const MCP_STATUS = {
  connected: 'Connected',
  failed: 'Couldn’t connect',
  'needs-auth': 'Needs sign-in',
  pending: 'Starting',
  disabled: 'Turned off in your Claude Code settings',
  'not-started': 'Not started yet',
};
export const MCP_SCOPE = {
  user: 'your settings',
  project: 'this project',
  local: 'your settings for this folder',
  plugin: 'plugin',
  'claude.ai': 'claude.ai connector',
};

/**
 * Your MCP servers (#59): each one found, with its status from the agent’s latest turn and a checkbox that’s on by
 * default. Unticked, it goes in st.mcpOff and doesn’t load for this agent. st.mcpServers holds the list once it
 * arrives (null while it loads).
 * @param {any} st @param {() => void} paint @param {{ idp: string, personaId?: string|null, projectId?: string|null }} opts
 */
function mcpField(st, paint, { idp, personaId = null, projectId = null }) {
  if (st.mcpServers === undefined) {
    st.mcpServers = null;
    const q = new URLSearchParams({ ...(personaId ? { personaId } : {}), ...(projectId ? { projectId } : {}) });
    api(`/api/mcp-servers?${q}`, undefined, 'GET').then(
      (r) => {
        st.mcpServers = r.servers ?? [];
        paint();
      },
      (e) => {
        st.mcpServers = { error: e.message };
        paint();
      },
    );
  }
  const list = st.mcpServers;
  const off = new Set(st.mcpOff);
  const body =
    st.usesHostSetup === false
      ? h('span.help', 'It’s isolated, so only Postbox’s own server loads, not yours.')
      : list === null
        ? h('span.help', 'Looking for your MCP servers…')
        : !Array.isArray(list)
          ? h('span.err', icon('warn'), `Couldn’t list your MCP servers: ${list.error}`)
          : !list.length
            ? h('span.help', 'None found in your Claude Code setup. Postbox’s own server always loads.')
            : h(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' } },
                list.map((m, i) =>
                  h(
                    'span.check',
                    {
                      id: `${idp}-mcp-${i}`,
                      role: 'checkbox',
                      tabindex: '0',
                      'aria-checked': String(!off.has(m.name)),
                      'data-server': m.name,
                      onclick: (e) => {
                        if (off.has(m.name)) off.delete(m.name);
                        else off.add(m.name);
                        st.mcpOff = [...off];
                        e.currentTarget.setAttribute('aria-checked', String(!off.has(m.name)));
                      },
                      onkeydown: (e) => {
                        if (e.key === ' ' || e.key === 'Enter') {
                          e.preventDefault();
                          e.currentTarget.click();
                        }
                      },
                    },
                    h('span.box'),
                    h('span.mono', m.name),
                    h('span.small.dim', [MCP_STATUS[m.status] ?? m.status, MCP_SCOPE[m.scope]].filter(Boolean).join(' · ')),
                  ),
                ),
              );
  return h(
    'fieldset.field.span',
    { style: { border: 0, padding: 0, margin: 0 } },
    h('legend.label', 'MCP servers'),
    body,
    st.usesHostSetup !== false && Array.isArray(list) && list.length
      ? h('span.help', 'Yours load as in your terminal. Untick one to keep it from loading for this agent. The status is from its latest turn.')
      : null,
  );
}

/**
 * Fields for st.backend, st.model, st.effort, st.permissionMode, st.folder, st.usesHostSetup, st.mcpOff and
 * st.canPublish.
 * idp prefixes element ids; personaId and projectId say whose MCP servers to list.
 */
function backendFields(st, paint, { idp, fixedBackend = false, personaId = null, projectId = null }) {
  // One that isn’t on this computer can still run on a host, when there is one and it says how (#120).
  const hosts = Object.values(S().hosts ?? {});
  const onHost = (id) => Boolean(capsOf(id).remote) && hosts.length > 0;
  const local = new Set(client.config.adapters ?? ['mock']);
  const available = new Set(BACKENDS.map(([id]) => id).filter((id) => local.has(id) || onHost(id)));
  const real = st.backend !== 'mock';
  const perm = PERMISSIONS.find(([id]) => id === st.permissionMode) ?? PERMISSIONS[0];
  return [
    // A dropdown, as Effort is: four backends side by side wrapped their names onto two lines in a half-width
    // field. One this computer can’t run stays in the list, disabled, so you can see it exists.
    h(
      'div.field',
      fixedBackend ? h('span.label', 'Backend') : h('label.label', { for: `${idp}-b` }, 'Backend'),
      fixedBackend
        ? h('span', BACKENDS.find(([id]) => id === st.backend)?.[1] ?? st.backend)
        : h(
            'div.select-wrap',
            h(
              'select.select',
              {
                id: `${idp}-b`,
                'aria-describedby': `${idp}-b-help`,
                onchange: (e) => {
                  const id = e.target.value;
                  st.backend = id;
                  // A backend that lists its models gets its first one in place of a model it doesn’t offer: the
                  // Antigravity CLI doesn’t run Claude’s default (#143).
                  const offered = capsOf(id).models;
                  if (id !== 'mock' && (!st.model || st.model === 'mock' || (offered && !offered.includes(st.model))))
                    st.model = offered?.[0] ?? client.config.defaultModel ?? MODELS[0];
                  st.effort = effortNamedBy(id, st.model) ?? st.effort;
                  // Where it runs: only a backend that can run on a host keeps one, and one that isn’t on this
                  // computer gets the first host.
                  if (!capsOf(id).remote) st.remote = null;
                  else if (!local.has(id) && !st.remote) st.remote = hosts[0]?.id ?? null;
                  st.placeError = null;
                  paint();
                },
              },
              BACKENDS.map(([id, name]) =>
                h(
                  'option',
                  { value: id, selected: st.backend === id, disabled: !available.has(id) },
                  local.has(id) ? name : available.has(id) ? `${name} (on a host only)` : `${name} (not on this computer)`,
                ),
              ),
            ),
            icon('down'),
          ),
      h('span.help', { id: `${idp}-b-help` }, BACKENDS.find(([id]) => id === st.backend)?.[2] ?? ''),
    ),
    real && capsOf(st.backend).remote && (hosts.length || !local.has(st.backend))
      ? placeField(st, paint, { idp, hosts, here: local.has(st.backend), name: BACKENDS.find(([id]) => id === st.backend)?.[1] ?? st.backend })
      : null,
    real
      ? h(
          'div.field',
          h('label.label', { for: `${idp}-m` }, 'Model'),
          h('input.input.mono', {
            id: `${idp}-m`,
            value: st.model,
            list: `${idp}-models`,
            spellcheck: 'false',
            oninput: (e) => {
              st.model = e.target.value.trim();
            },
            // A model that names its effort runs at it, so Effort follows (the Gemini room UAT: Medium beside
            // gemini-3.8-flash-high read as a contradiction).
            onchange: () => {
              const named = effortNamedBy(st.backend, st.model);
              if (named && named !== st.effort) {
                st.effort = named;
                paint();
              }
            },
          }),
          h(
            'datalist',
            { id: `${idp}-models` },
            modelsFor(st.backend).map((m) => h('option', { value: m, label: codexDefault(st.backend, m) ? modelName(st.backend, m) : null })),
          ),
          // Codex picks its own model for `auto`: it isn’t one of Claude’s.
          st.backend === 'codex' ? h('span.help', 'auto is Codex’s default: the model your Codex configuration picks.') : null,
        )
      : null,
    // Next to the model, and always passed with it, so your own settings don’t decide it (#60).
    real
      ? h(
          'div.field',
          h('label.label', { for: `${idp}-e` }, 'Effort'),
          h(
            'div.select-wrap',
            h(
              'select.select',
              {
                id: `${idp}-e`,
                'aria-describedby': `${idp}-e-help`,
                onchange: (e) => {
                  st.effort = e.target.value;
                },
              },
              (client.config.effortLevels ?? Object.keys(EFFORT_NAMES)).map((l) =>
                h('option', { value: l, selected: (st.effort ?? client.config.defaultEffort) === l }, EFFORT_NAMES[l] ?? l),
              ),
            ),
            icon('down'),
          ),
          h(
            'span.help',
            { id: `${idp}-e-help` },
            // agy names the effort in most model ids, and refuses --effort for them (server/adapters/antigravity-cli.mjs).
            st.backend === 'antigravity-cli'
              ? 'How much it thinks before it answers. A model whose name ends in -low, -medium or -high runs at that; this applies to one that doesn’t, such as gemini-3.8-flash, up to High.'
              : 'How much it thinks before it answers. Higher is slower and costs more.',
          ),
        )
      : null,
    real
      ? h(
          'div.field.span',
          h('span.label', 'Permissions'),
          seg('Permissions', PERMISSIONS, perm[0], (id) => {
            st.permissionMode = id;
            paint();
          }),
          h('span.help', modeHelp(st.backend, perm)),
        )
      : null,
    real
      ? h(
          'div.field.span',
          h('label.label', { for: `${idp}-f` }, 'Folder'),
          h('input.input.mono', {
            id: `${idp}-f`,
            value: st.folder,
            placeholder: 'The project’s root folder',
            spellcheck: 'false',
            'aria-describedby': `${idp}-f-help`,
            oninput: (e) => {
              st.folder = e.target.value.trim();
            },
          }),
          h('span.help', { id: `${idp}-f-help` }, 'Where it works. Leave it empty to work in the project’s root folder.'),
        )
      : null,
    // What it takes from your own Claude Code (or Kiro) setup (#57). Your output style never applies. A backend that
    // can’t run apart from your setup (the Antigravity CLI) says so rather than offer a switch that does nothing.
    real && capsOf(st.backend).isolation === false
      ? h(
          'div.field.span',
          h('span.label', `Uses your ${BACKENDS.find(([id]) => id === st.backend)?.[1].replace(/ CLI$/, '') ?? st.backend} setup`),
          h('span.help', 'Always: your rules, skills, plugins and MCP servers load, as in your terminal. It can’t run without them.'),
        )
      : null,
    real && capsOf(st.backend).isolation !== false
      ? checkField({
          id: `${idp}-setup`,
          label: st.backend === 'kiro-cli' ? 'Uses your Kiro setup' : st.backend === 'codex' ? 'Uses your Codex setup' : 'Uses your Claude Code setup',
          help:
            st.backend === 'kiro-cli'
              ? 'Your steering, skills, settings, permissions and MCP servers, as in your terminal. Off, it loads only the folder’s .kiro and Postbox’s server.'
              : st.backend === 'codex'
                ? 'Uses your local Codex sign-in, models, instructions and configuration. Off is not available: app-server uses the same Codex home for authentication.'
                : 'Your skills, commands, plugins and permission rules, as in your terminal. Off, it uses only the project’s settings and the folder’s local file, where Always allow saves.',
          on: st.usesHostSetup !== false,
          onToggle: (on) => {
            st.usesHostSetup = on;
            paint();
          },
        })
      : null,
    real && st.backend !== 'codex'
      ? checkField({
          id: `${idp}-publish`,
          label: 'Can publish outside Postbox',
          help: 'Lets it use artifacts, and connectors that post or send. Off, its work stays in the conversation.',
          on: st.canPublish === true,
          onToggle: (on) => {
            st.canPublish = on;
          },
        })
      : null,
    // The list reads Claude Code’s config (server/adapters/mcp-config.mjs): a backend that doesn’t read it (the Kiro
    // CLI) has nothing true to show here.
    real && capsOf(st.backend).permissions !== 'none' ? mcpField(st, paint, { idp, personaId, projectId }) : null,
  ];
}

// What the Tools checklist means on real backends (#5): server/adapters/setup.mjs, TOOL_RULES, and kiro-cli.mjs, KIRO_TOOL_RULES.
// A backend that can’t turn a tool off for one agent (capabilities.tools: 'none', the Antigravity CLI) only tells it.
const toolsHelp = (backend) =>
  capsOf(backend).tools === 'none'
    ? 'This backend can’t turn a tool off for one agent: an unticked one is only a request, which the agent is told. Its permissions still apply.'
    : 'On Claude Code, the Agent SDK and the Kiro CLI, an unticked tool is turned off. A ticked one still follows its permissions.';

// ── New agent ───────────────────────────────────────────────────────────────────────────

export function openNewAgent({ threadId = null, projectId: pid = null, preset = null, onCreated = null } = {}) {
  const t = threadId ? S().threads[threadId] : null;
  const projectId = t?.projectId ?? pid ?? Object.keys(S().projects)[0];
  const bps = Object.values(S().boilerplates);
  const st = {
    bp: preset ? null : (bps[1]?.id ?? bps[0]?.id),
    handle: preset?.handle ?? '',
    instructions: preset?.instructions ?? bps[1]?.instructions ?? '',
    description: preset?.description ?? bps[1]?.description ?? '',
    tools: new Set(preset?.tools ?? bps[1]?.tools ?? []),
    where: threadId ? 'join' : 'new',
    backend: defaultBackend(),
    model: client.config.defaultModel ?? 'claude-opus-5-5',
    effort: client.config.defaultEffort ?? 'medium',
    permissionMode: 'auto',
    usesHostSetup: true,
    canPublish: false,
    mcpOff: [],
    folder: '',
    remote: null,
    placeError: null,
    saveBp: false,
    error: null,
  };
  if (st.backend === 'codex' && !modelsFor(st.backend).includes(st.model) && modelsFor(st.backend).length) st.model = modelsFor(st.backend)[0];
  const have = toolsInProject(projectId);
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
  // Each change repaints the sheet; focus stays on the control you used (#26).
  const paint = () => keepFocus(body, repaint);
  const repaint = () => {
    fill(
      body,
      preset
        ? null
        : h(
            'div.field',
            h('span.label', 'Start from'),
            h(
              'div.chips',
              { role: 'radiogroup', 'aria-label': 'Boilerplate' },
              bps.map((b) =>
                h(
                  'button.chip',
                  {
                    type: 'button',
                    role: 'radio',
                    'aria-checked': String(st.bp === b.id),
                    class: st.bp === b.id ? 'on' : '',
                    onclick: () => {
                      st.bp = b.id;
                      st.instructions = b.instructions;
                      st.description = b.description;
                      st.tools = new Set(b.tools);
                      paint();
                    },
                  },
                  b.name,
                ),
              ),
            ),
          ),
      h(
        'div.form-grid',
        h(
          'div.field',
          h('label.label', { for: 'na-h' }, 'Name'),
          h(
            'div.row-flex',
            { style: { gap: 0 } },
            h('span.pill', { style: { height: '32px', borderRadius: '6px 0 0 6px' } }, '@'),
            h('input.input', {
              id: 'na-h',
              value: st.handle,
              style: { borderRadius: '0 6px 6px 0' },
              'aria-describedby': 'na-h-help',
              oninput: (e) => {
                st.handle = e.target.value.replace(/^@/, '');
              },
            }),
          ),
          h('span.help', { id: 'na-h-help' }, '2–24 letters, digits, - or _'),
        ),
        ...backendFields(st, paint, { idp: 'na', projectId }),
        h(
          'div.field.span',
          h('label.label', { for: 'na-d' }, 'What it does'),
          h('input.input', {
            id: 'na-d',
            value: st.description,
            oninput: (e) => {
              st.description = e.target.value;
            },
          }),
        ),
        h(
          'div.field.span',
          h('label.label', { for: 'na-i' }, 'Instructions'),
          h(
            'textarea.textarea',
            {
              id: 'na-i',
              style: { minHeight: '88px' },
              oninput: (e) => {
                st.instructions = e.target.value;
              },
            },
            st.instructions,
          ),
        ),
      ),
      st.backend === 'codex'
        ? h('p.help', 'Codex app-server does not expose Postbox’s per-agent Tools checklist; this backend reports that capability as unavailable.')
        : h(
            'fieldset',
            { style: { border: 0, padding: 0, margin: 0 } },
            h('legend.label', 'Tools'),
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' } },
              S().config ? null : null,
              (client.config.knownTools ?? []).map(([id, label]) => {
                const on = st.tools.has(id);
                return h(
                  'span.check',
                  {
                    role: 'checkbox',
                    tabindex: '0',
                    'aria-checked': String(on),
                    onclick: () => {
                      if (on) st.tools.delete(id);
                      else st.tools.add(id);
                      paint();
                    },
                    onkeydown: (e) => {
                      if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault();
                        e.currentTarget.click();
                      }
                    },
                  },
                  h('span.box'),
                  h('span.mono', id),
                  h(
                    'span.small',
                    { style: { color: on && !have.has(id) ? 'var(--accent)' : 'var(--dim)' } },
                    on && !have.has(id) ? 'New grant · no agent in this project has it yet' : label,
                  ),
                );
              }),
            ),
            st.backend === 'mock' ? null : h('span.help', toolsHelp(st.backend)),
          ),
      h(
        'div.field',
        h('span.label', 'Where it works'),
        h(
          'div',
          { role: 'radiogroup', 'aria-label': 'Where it works', style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
          threadId
            ? whereOpt(
                'join',
                `Join this ${t.kind === 'topic' ? 'topic thread' : t.kind === 'side' ? 'side thread' : 'conversation'}`,
                `${t.kind === 'thread' ? `“${t.title}” becomes a room` : `It joins ${t.kind === 'room' ? 'the room ' : ''}“${t.title}”`}. It gets the recent messages and a short brief.`,
              )
            : null,
          whereOpt('new', `New conversation in ${S().projects[projectId]?.name}`, 'Starts fresh. @ it from anywhere to bring it in.'),
        ),
      ),
      st.error ? h('span.err', { role: 'alert' }, icon('warn'), st.error) : null,
    );
  };
  const whereOpt = (v, title, sub) =>
    h(
      'button.btn',
      {
        type: 'button',
        role: 'radio',
        'aria-checked': String(st.where === v),
        style: { height: 'auto', justifyContent: 'flex-start', padding: '10px 12px', borderColor: st.where === v ? 'var(--accent)' : null },
        onclick: () => {
          st.where = v;
          paint();
        },
      },
      h('span', { style: { textAlign: 'left', whiteSpace: 'normal' } }, h('b', title), h('span.small.dim', { style: { display: 'block' } }, sub)),
    );
  paint();
  const create = async () => {
    try {
      const p = await api('/api/personas', {
        handle: st.handle,
        description: st.description,
        instructions: st.instructions,
        tools: [...st.tools],
        backend: st.backend,
        model: st.backend === 'mock' ? 'mock' : st.model,
        ...(st.backend === 'mock' ? {} : { effort: st.effort }),
        permissionMode: st.permissionMode,
        ...(st.backend === 'mock' ? {} : { usesHostSetup: st.usesHostSetup, canPublish: st.canPublish, mcpOff: st.mcpOff }),
        folder: st.folder,
        // Where it runs (#120): null for this computer.
        remote: st.backend !== 'mock' && st.remote ? { hostId: st.remote } : null,
        saveAsBoilerplate: st.saveBp,
        join: st.where === 'join' ? { threadId } : { projectId, title: `With @${st.handle}` },
      });
      dlg.close();
      toast({ title: `Created @${p.handle}` });
      onCreated?.(p);
      if (st.where === 'new')
        setTimeout(() => {
          const nt = threadsOf(projectId).find((x) => sessionsOf(x.id).some((se) => se.personaId === p.id));
          if (nt) navigate(`#/t/${nt.id}`);
        }, 200);
    } catch (e) {
      st.error = e.message;
      paint();
      body.querySelector('#na-h')?.focus();
    }
  };
  const saveBp = h(
    'span.check',
    {
      role: 'checkbox',
      tabindex: '0',
      'aria-checked': 'false',
      style: { marginRight: 'auto' },
      onclick: (e) => {
        st.saveBp = !st.saveBp;
        e.currentTarget.setAttribute('aria-checked', String(st.saveBp));
      },
      onkeydown: (e) => {
        if (e.key === ' ') {
          e.preventDefault();
          e.currentTarget.click();
        }
      },
    },
    h('span.box'),
    h('span.small', 'Save as a boilerplate'),
  );
  const dlg = openDialog({
    title: preset ? `Edit @${preset.handle} before creating it` : 'New agent',
    sub: `Starts a new session in ${S().projects[projectId]?.name}. You can edit it later under Personas.`,
    size: 'lg',
    body,
    foot: [
      saveBp,
      h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h('button.btn.send', { type: 'button', onclick: create }, 'Create agent'),
    ],
    initialFocus: () => body.querySelector('#na-h'),
  });
}

// ── New conversation ────────────────────────────────────────────────────────────────────

/**
 * A new conversation: a direct message with one agent, or a room with several. Picking a second agent makes
 * it a room; { room: true } starts with that intent and asks for at least two.
 */
export function openNewThread(projectId, { room = false } = {}) {
  const personas = Object.values(S().personas).filter((p) => !p.retired);
  const picked = new Set(room ? [] : personas.slice(0, 1).map((p) => p.id));
  const title = h('input.input', { id: 'nt-title', placeholder: room ? 'What will the room work on?' : 'What’s it about?' });
  const list = h('div.chips', { role: 'group', 'aria-label': 'Agents' });
  const err = h('div');
  const startBtn = h('button.btn.send', { type: 'button', onclick: () => create() });
  const paint = () => keepFocus(list, repaint);
  const repaint = () => {
    list.replaceChildren(
      ...personas.map((p) =>
        h(
          'button.chip',
          {
            type: 'button',
            'aria-pressed': String(picked.has(p.id)),
            class: picked.has(p.id) ? 'on' : '',
            onclick: () => {
              if (picked.has(p.id)) picked.delete(p.id);
              else picked.add(p.id);
              paint();
            },
          },
          `@${p.handle}`,
        ),
      ),
    );
    startBtn.textContent = picked.size > 1 ? `Start a room with ${picked.size} agents` : 'Start conversation';
  };
  paint();
  const create = async () => {
    if (!picked.size || (room && picked.size < 2)) {
      err.replaceChildren(h('span.err', { role: 'alert' }, icon('warn'), room ? 'Pick at least two agents for a room.' : 'Pick an agent.'));
      return;
    }
    try {
      const t = await api('/api/threads', {
        projectId,
        title: title.value.trim() || (picked.size > 1 ? 'New room' : 'New conversation'),
        personaIds: [...picked],
      });
      dlg.close();
      navigate(`#/t/${t.id}`);
    } catch (e) {
      err.replaceChildren(h('span.err', { role: 'alert' }, icon('warn'), e.message));
    }
  };
  const dlg = openDialog({
    title: room ? 'New room' : 'New conversation',
    sub: `${S().projects[projectId]?.name ?? ''} · ${room ? 'Several agents in one conversation. The last to speak answers anything not addressed with @.' : 'One agent, or pick more to make a room.'}`,
    body: [h('div.field', h('label.label', { for: 'nt-title' }, 'Name'), title), h('div.field', h('span.label', 'With'), list), err],
    foot: [h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), startBtn],
  });
}

/** Deletes a conversation or room, after saying what goes and what stays. */
export function confirmDeleteThread(threadId) {
  const t = S().threads[threadId];
  if (!t) return;
  const ses = sessionsOf(threadId);
  const items = S().items[threadId] ?? [];
  const apps = Object.values(S().apps).filter((a) => a.threadId === threadId).length;
  const topics = Object.values(S().threads).filter((x) => x.parentId === threadId).length;
  const room = t.kind === 'room';
  const li = (ok, text) =>
    h('li', h(`span.i.i-${ok ? 'check' : 'x'}.i-sm`, { style: { color: ok ? 'var(--good)' : 'var(--alert-ink)' }, 'aria-hidden': 'true' }), h('span', text));
  const dlg = openDialog({
    title: `Delete the ${room ? 'room' : 'conversation'} “${t.title}”?`,
    sub: S().projects[t.projectId]?.name,
    role: 'alertdialog',
    body: [
      h(
        'div.field',
        h('span.label', 'This erases'),
        h(
          'ul.what-goes',
          li(false, `${plural(items.length, 'message')}, ${plural(apps, 'app')} and ${plural(topics, 'topic thread')} off it`),
          li(false, `The ${plural(ses.length, 'session')} in it, and their context: ${ses.map((x) => `@${x.handle}`).join(', ') || 'no agents'}`),
        ),
      ),
      h(
        'div.field',
        h('span.label', 'This stays'),
        h('ul.what-goes', li(true, 'The personas and their other sessions'), li(true, `Files in ${S().projects[t.projectId]?.folder ?? 'the project folder'}`)),
      ),
      h('p.small.dim', 'You’ll have 10 seconds to undo.'),
    ],
    foot: [
      h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h(
        'button.btn.danger',
        {
          type: 'button',
          onclick: () =>
            api(`/api/threads/${threadId}`, null, 'DELETE')
              .then((r) => {
                dlg.close();
                navigate(`#/p/${t.projectId}`);
                undoToast({
                  text: `Deleted “${t.title}”`,
                  until: r.until,
                  onUndo: () => api(`/api/threads/${threadId}/undo-delete`, {}).catch((e) => toast({ title: 'Too late to undo', text: e.message })),
                });
              })
              .catch((e) => toast({ title: 'Couldn’t delete it', text: e.message, level: 'blocking' })),
        },
        `Delete ${room ? 'room' : 'conversation'}`,
      ),
    ],
  });
}

/** Renames a conversation or room. */
export function openRename(threadId) {
  const t = S().threads[threadId];
  const input = h('input.input', { id: 'rn-title', value: t?.title ?? '' });
  const save = () =>
    api(`/api/threads/${threadId}`, { title: input.value }, 'PATCH')
      .then(() => dlg.close())
      .catch((e) => toast({ title: 'Couldn’t rename it', text: e.message, level: 'blocking' }));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save();
  });
  const dlg = openDialog({
    title: `Rename the ${t?.kind === 'room' ? 'room' : 'conversation'}`,
    body: [h('div.field', h('label.label', { for: 'rn-title' }, 'Name'), input)],
    foot: [h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button.btn.send', { type: 'button', onclick: save }, 'Rename')],
    initialFocus: () => input,
  });
}

// ── Delete confirm ──────────────────────────────────────────────────────────────────────

export function confirmDelete(se) {
  const t = S().threads[se.threadId];
  const items = S().items[se.threadId] ?? [];
  const room = sessionsOf(se.threadId).length > 1;
  const apps = Object.values(S().apps).filter((a) => a.sessionId === se.id).length;
  const blocks = items.filter((i) => i.kind === 'block' && i.sessionId === se.id).length;
  const li = (ok, text) =>
    h('li', h(`span.i.i-${ok ? 'check' : 'x'}.i-sm`, { style: { color: ok ? 'var(--good)' : 'var(--alert-ink)' }, 'aria-hidden': 'true' }), h('span', text));
  const dlg = openDialog({
    title: `Delete @${se.handle}’s session?`,
    sub: `${S().projects[t?.projectId]?.name} · ${t?.title}`,
    role: 'alertdialog',
    body: [
      h(
        'div.field',
        h('span.label', 'This erases'),
        h(
          'ul.what-goes',
          room
            ? [
                li(false, `@${se.handle}’s session and its context, including ${plural(se.compactions ?? 0, 'compaction summary', 'compaction summaries')}`),
                li(false, `${plural(apps, 'app')} it wrote`),
              ]
            : [
                li(false, `The conversation: ${plural(items.length, 'item')}, including ${plural(blocks, 'block')} and ${plural(apps, 'app')}`),
                li(false, `@${se.handle}’s context for this session`),
              ],
        ),
      ),
      h(
        'div.field',
        h('span.label', 'This stays'),
        h(
          'ul.what-goes',
          li(true, `The @${se.handle} persona and its other sessions`),
          room ? li(true, `Its past messages in this room, marked “(deleted)”`) : null,
          li(true, `Files in ${S().projects[t?.projectId]?.folder ?? 'the project folder'}`),
        ),
      ),
      h('p.small.dim', 'You’ll have 10 seconds to undo. To keep the conversation but stop the session, archive it instead.'),
    ],
    foot: [
      h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h(
        'button.btn',
        {
          type: 'button',
          onclick: () => {
            dlg.close();
            api(`/api/sessions/${se.id}/archive`, {}).then(() => toast({ title: `Archived @${se.handle}’s session` }));
          },
        },
        'Archive instead',
      ),
      h(
        'button.btn.danger',
        {
          type: 'button',
          onclick: async () => {
            dlg.close();
            try {
              const r = await api(`/api/sessions/${se.id}`, undefined, 'DELETE');
              const { afterDelete } = await import('./shell.mjs');
              afterDelete(se, r.until);
              if (location.hash.includes(se.threadId) && !room) navigate('#/');
            } catch (e) {
              toast({ title: 'Couldn’t delete', text: e.message, level: 'blocking' });
            }
          },
        },
        icon('trash', 'i-sm'),
        'Delete session',
      ),
    ],
    initialFocus: () => null,
  });
  dlg.dialog.querySelector('.d-foot .btn')?.focus();
}

// ── Settings ────────────────────────────────────────────────────────────────────────────

export function openSettings(tab = 'appearance', personaId = null) {
  let cur = tab;
  // What the server answered for Archive idle conversations: the page may not have heard the change yet (#101).
  let archiveDays = null;
  const tabs = h('div.tabs', { role: 'tablist' });
  const panel = h('div', { role: 'tabpanel', style: { display: 'flex', flexDirection: 'column', gap: '12px' } });
  // The tabs and the panel repaint together; focus stays on the tab or control you used (#26).
  const paint = () => keepFocus(tabs.parentElement, repaint);
  const repaint = () => {
    tabs.replaceChildren(
      ...[
        ['appearance', 'Appearance'],
        ['personas', 'Personas'],
        ['projects', 'Projects'],
        ['hosts', 'Hosts'],
        ['connect', 'Backends'],
      ].map(([id, label]) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': String(cur === id),
            onclick: () => {
              cur = id;
              paint();
            },
          },
          label,
        ),
      ),
    );
    fill(panel, ...{ appearance, personas, projects, hosts: () => [hostsPanel()], connect }[cur]());
  };
  const appearance = () => {
    const pref = S().settings.theme ?? 'system';
    return [
      h(
        'div.field',
        h('span.label', 'Mode'),
        h(
          'div.seg',
          { role: 'radiogroup', 'aria-label': 'Mode' },
          [
            ['system', 'System'],
            ['light', 'Light'],
            ['dark', 'Dark'],
          ].map(([v, l]) =>
            h(
              'button',
              { type: 'button', role: 'radio', 'aria-checked': String(pref === v), onclick: () => api('/api/settings', { theme: v }, 'PUT').then(paint) },
              l,
            ),
          ),
        ),
      ),
      h('p.small.dim', 'System follows your computer’s setting. The choice is saved in Postbox, so it follows you to other browsers.'),
    ];
  };
  const personas = () => {
    const list = Object.values(S().personas);
    const editing = personaId && S().personas[personaId];
    // Between the list and a persona’s form, focus goes to the form’s first field, and back to its Edit button.
    if (editing)
      return personaForm(editing, () => {
        personaId = null;
        paint();
        document.getElementById(`pe-edit-${editing.id}`)?.focus();
      });
    return [
      h(
        'ul.list-rows',
        list.map((p) =>
          h(
            'li',
            h('b', `@${p.handle}`),
            mockMarker(p),
            h('span.small.dim.grow', p.retired ? 'Retired' : p.description),
            p.remote?.hostId ? h('span.small.dim', `On ${S().hosts?.[p.remote.hostId]?.name ?? 'a removed host'}`) : null,
            h('span.small.dim', `v${p.version ?? 1}`),
            h(
              'button.btn.sm',
              {
                type: 'button',
                id: `pe-edit-${p.id}`,
                'aria-label': `Edit @${p.handle}`,
                onclick: () => {
                  personaId = p.id;
                  paint();
                  document.getElementById('pe-d')?.focus();
                },
              },
              'Edit',
            ),
          ),
        ),
      ),
      h(
        'div.row-flex',
        h(
          'button.btn',
          {
            type: 'button',
            onclick: () => {
              dlg.close();
              openNewAgent({});
            },
          },
          icon('plus'),
          'New agent',
        ),
      ),
      h('p.small.dim', 'Edits apply to new sessions. Running sessions keep the version they started with.'),
    ];
  };
  const personaForm = (p, back) => {
    const tools = new Set(p.tools);
    const run = {
      backend: p.backend ?? 'mock',
      // A Codex persona kept from before `auto` may name a Claude model, which Codex ignores: it reads as its default.
      model: p.backend === 'codex' && codexDefault(p.backend, p.model) ? 'auto' : p.model,
      remote: p.remote?.hostId ?? null,
      placeError: null,
      effort: p.effort ?? client.config.defaultEffort ?? 'medium',
      permissionMode: p.permissionMode ?? 'auto',
      folder: p.folder ?? '',
      usesHostSetup: p.usesHostSetup !== false,
      canPublish: p.canPublish === true,
      mcpOff: [...(p.mcpOff ?? [])],
    };
    const runBox = h('div.form-grid');
    const paintRun = () => keepFocus(runBox, () => fill(runBox, backendFields(run, paintRun, { idp: 'pe', personaId: p.id })));
    paintRun();
    const desc = h('input.input', { id: 'pe-d', value: p.description });
    const ins = h('textarea.textarea', { id: 'pe-i', style: { minHeight: '100px' } }, p.instructions);
    return [
      h('button.btn.sm.ghost', { type: 'button', onclick: back, style: { alignSelf: 'flex-start' } }, icon('back', 'i-sm'), 'All personas'),
      h('b', `@${p.handle}`),
      h('div.field', h('label.label', { for: 'pe-d' }, 'What it does'), desc),
      h('div.field', h('label.label', { for: 'pe-i' }, 'Instructions'), ins),
      runBox,
      run.backend === 'codex'
        ? h('p.help', 'Codex app-server does not expose Postbox’s per-agent Tools checklist.')
        : h(
            'div.field',
            h('span.label', 'Tools'),
            h(
              'div.chips',
              (client.config.knownTools ?? []).map(([id]) =>
                h(
                  'button.chip.sm',
                  {
                    type: 'button',
                    'aria-pressed': String(tools.has(id)),
                    class: tools.has(id) ? 'on' : '',
                    onclick: (e) => {
                      if (tools.has(id)) tools.delete(id);
                      else tools.add(id);
                      e.currentTarget.classList.toggle('on');
                      e.currentTarget.setAttribute('aria-pressed', String(tools.has(id)));
                    },
                  },
                  id,
                ),
              ),
            ),
            run.backend === 'mock' ? null : h('span.help', toolsHelp(run.backend)),
          ),
      // Its rules, folders and MCP servers, with where each comes from (#66), over this sheet.
      p.backend && p.backend !== 'mock'
        ? h(
            'div.row-flex',
            h('button.btn.sm', { type: 'button', id: 'pe-perms', onclick: () => openPermissions({ personaId: p.id }) }, icon('gear', 'i-sm'), 'Permissions…'),
            h('span.help', 'Its rules, with where each comes from, and which rule decides a call.'),
          )
        : null,
      h(
        'div.row-flex',
        h(
          'button.btn.send',
          {
            type: 'button',
            onclick: () =>
              api(
                `/api/personas/${p.id}`,
                {
                  description: desc.value,
                  instructions: ins.value,
                  tools: [...tools],
                  backend: run.backend,
                  remote: run.backend !== 'mock' && run.remote ? { hostId: run.remote } : null,
                  ...(run.backend === 'mock'
                    ? {}
                    : {
                        model: run.model,
                        effort: run.effort,
                        permissionMode: run.permissionMode,
                        folder: run.folder,
                        usesHostSetup: run.usesHostSetup,
                        canPublish: run.canPublish,
                        mcpOff: run.mcpOff,
                      }),
                },
                'PATCH',
              )
                .then(() => {
                  toast({
                    title: `Saved @${p.handle}`,
                    text:
                      run.backend !== (p.backend ?? 'mock') ||
                      (run.remote ?? null) !== (p.remote?.hostId ?? null) ||
                      run.permissionMode !== (p.permissionMode ?? 'auto') ||
                      run.usesHostSetup !== (p.usesHostSetup !== false) ||
                      run.canPublish !== (p.canPublish === true) ||
                      String(run.mcpOff) !== String(p.mcpOff ?? []) ||
                      String([...tools].sort()) !== String([...(p.tools ?? [])].sort())
                        ? 'Where it runs, its permissions and its tools apply to its conversations from their next turn; other changes apply to new sessions.'
                        : 'New sessions use this version.',
                  });
                  back();
                })
                // Where it runs changed: the server’s refusal shows under Runs on (#120).
                .catch((e) => saveRefused(e, run, p, paintRun, runBox)),
          },
          'Save',
        ),
        h(
          'button.btn',
          { type: 'button', onclick: () => api(`/api/personas/${p.id}`, { retired: !p.retired }, 'PATCH').then(back) },
          p.retired ? 'Bring back' : 'Retire',
        ),
      ),
    ];
  };
  const projects = () => {
    const name = h('input.input', { id: 'pj-n', placeholder: 'Project name' });
    const folder = h('input.input', { id: 'pj-f', placeholder: '/Users/you/Documents/project' });
    return [
      h(
        'ul.list-rows',
        Object.values(S().projects).map((p) => h('li', icon('folder', 'dim'), h('b', p.name), h('span.small.dim.mono.grow', p.folder))),
      ),
      h(
        'div.form-grid',
        h('div.field', h('label.label', { for: 'pj-n' }, 'Name'), name),
        h('div.field', h('label.label', { for: 'pj-f' }, 'Root folder'), folder),
      ),
      h(
        'div.row-flex',
        h(
          'button.btn',
          {
            type: 'button',
            onclick: () =>
              api('/api/projects', { name: name.value, folder: folder.value })
                .then(() => {
                  toast({ title: `Created ${name.value || 'the project'}` });
                  paint();
                })
                .catch((e) => toast({ title: 'Couldn’t create the project', text: e.message, level: 'blocking' })),
          },
          icon('plus'),
          'Create project',
        ),
      ),
      h('p.small.dim', 'The folder bounds the file picker and is where Claude Code sessions start.'),
      // A conversation where nothing has happened for this long archives itself, in every project (#101).
      h(
        'div.field',
        h('span.label', { id: 'pj-archive' }, 'Archive idle conversations'),
        h(
          'div.seg',
          { role: 'radiogroup', 'aria-labelledby': 'pj-archive' },
          [
            [1, 'After 1 day'],
            [3, '3 days'],
            [7, '7 days'],
            [30, '30 days'],
            [0, 'Never'],
          ].map(([v, l]) =>
            h(
              'button',
              {
                type: 'button',
                role: 'radio',
                'aria-checked': String((archiveDays ?? S().settings.archiveAfterDays ?? 7) === v),
                // Marked in place, not repainted: that would clear a project you’re typing in the form above.
                onclick: (e) => {
                  const picked = e.currentTarget;
                  api('/api/settings', { archiveAfterDays: v }, 'PUT')
                    .then((r) => {
                      archiveDays = r.archiveAfterDays;
                      for (const b of picked.parentElement.children) b.setAttribute('aria-checked', String(b === picked));
                    })
                    .catch((err) => toast({ title: 'Couldn’t change it', text: err.message, level: 'blocking' }));
                },
              },
              l,
            ),
          ),
        ),
      ),
      h(
        'p.small.dim',
        'When nothing has happened in a conversation for that long, and nothing waits on you there, it moves to Archived with its agents. Nothing is deleted, and Restore brings it back.',
      ),
    ];
  };
  paint();
  const dlg = openDialog({ title: 'Settings', size: 'lg', body: [tabs, panel] });
}

// ── Command palette ─────────────────────────────────────────────────────────────────────

export function openPalette() {
  // Already open: ⌘K again goes back to its field rather than stacking a second palette.
  const open = document.querySelector('.dialog.palette input');
  if (open) return open.focus();
  const input = h('input.input', {
    'aria-label': 'Jump to a conversation, project, agent or action',
    placeholder: 'Jump to a conversation, an agent, or an action…',
    role: 'combobox',
    'aria-controls': 'p-list',
    'aria-expanded': 'true',
    autocomplete: 'off',
  });
  const list = h('ul.p-list', { id: 'p-list', role: 'listbox' });
  let sel = 0;
  const all = () => [
    ...Object.values(S().threads)
      .filter((t) => t.kind !== 'side' && !t.archived)
      .map((t) => ({
        label: t.title,
        sub: `${S().projects[t.projectId]?.name} · ${sessionsOf(t.id)
          .map((s) => '@' + s.handle)
          .join(', ')}`,
        icon: 'thread',
        run: () => navigate(`#/t/${t.id}`),
      })),
    { label: 'Overview', sub: 'All live sessions', icon: 'agent', run: () => navigate('#/') },
    { label: 'New agent', sub: 'From a boilerplate', icon: 'plus', run: () => openNewAgent({}) },
    { label: 'Settings', sub: 'Mode, personas, projects', icon: 'gear', run: () => openSettings() },
    ...['system', 'light', 'dark'].map((m) => ({
      label: `Switch to ${m === 'system' ? 'the system mode' : m + ' mode'}`,
      sub: 'Appearance',
      icon: 'moon',
      run: () => api('/api/settings', { theme: m }, 'PUT'),
    })),
  ];
  const paint = () => {
    const q = input.value.toLowerCase().trim();
    const items = all()
      .filter((x) => !q || `${x.label} ${x.sub}`.toLowerCase().includes(q))
      .slice(0, 12);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    list.replaceChildren(
      ...items.map((x, i) =>
        h(
          'li',
          {
            role: 'option',
            id: `p-${i}`,
            'aria-selected': String(i === sel),
            onclick: () => {
              dlg.close();
              x.run();
            },
          },
          icon(x.icon, 'dim'),
          h('span.grow', x.label, h('span.small.dim', { style: { display: 'block' } }, x.sub)),
        ),
      ),
    );
    input.setAttribute('aria-activedescendant', `p-${sel}`);
    return items;
  };
  input.addEventListener('input', () => {
    sel = 0;
    paint();
  });
  input.addEventListener('keydown', (e) => {
    const items = paint();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      sel = (sel + 1) % items.length;
      paint();
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel - 1 + items.length) % items.length;
      paint();
    }
    if (e.key === 'Enter' && items[sel]) {
      e.preventDefault();
      dlg.close();
      items[sel].run();
    }
  });
  paint();
  const dlg = openDialog({ title: 'Jump to…', body: [input, list], size: 'palette', initialFocus: () => input });
}

// ── Folder picker ───────────────────────────────────────────────────────────────────────

/**
 * The project folder’s files, to attach one; with folders: true, its folders, to add one an agent may work in (#66).
 * onPick gets the path relative to the project’s folder ("" for the folder itself).
 * @param {string} projectId @param {(path: string) => void} onPick @param {{ folders?: boolean }} [opts]
 */
export function openFolderPicker(projectId, onPick, { folders = false } = {}) {
  const listEl = h('ul.list-rows');
  const where = h('p.small.dim.mono');
  // A folder that won’t open says why here, and the list and Up stay as they were (#28).
  const problem = h('p.err', { role: 'alert', hidden: true });
  const load = async (path) => {
    try {
      const r = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(path)}`).then((x) => x.json());
      if (r.error) throw new Error(r.error);
      problem.hidden = true;
      problem.replaceChildren();
      where.textContent = `${r.root}${r.path ? '/' + r.path : ''}`;
      const pick = (path) => {
        dlg.close();
        onPick(path);
      };
      fill(
        listEl,
        folders
          ? h(
              'li',
              icon('folder', 'dim'),
              h('span.grow', 'This folder'),
              h('button.btn.sm', { type: 'button', onclick: () => pick(r.path) }, 'Add this folder'),
            )
          : null,
        r.path
          ? h('li', h('button.btn.sm.ghost', { type: 'button', onclick: () => load(r.path.split('/').slice(0, -1).join('/')) }, icon('back', 'i-sm'), 'Up'))
          : null,
        ...r.entries
          .filter((e) => !folders || e.dir)
          .map((e) =>
            h(
              'li',
              icon(e.outside ? 'link' : e.dir ? 'folder' : 'file', 'dim'),
              h('span.grow', e.name),
              // A link out of the project’s folder can’t be opened or picked, and says so (#28).
              e.outside
                ? h('span.small.dim', 'Link to outside the project')
                : e.dir
                  ? [
                      h('button.btn.sm', { type: 'button', 'aria-label': `Open ${e.name}`, onclick: () => load(e.path) }, 'Open'),
                      folders ? h('button.btn.sm', { type: 'button', 'aria-label': `Add ${e.name}`, onclick: () => pick(e.path) }, 'Add') : null,
                    ]
                  : h(
                      'button.btn.sm',
                      {
                        type: 'button',
                        'aria-label': `Attach ${e.name}`,
                        onclick: () => pick(e.path),
                      },
                      'Attach',
                    ),
            ),
          ),
        r.entries.some((e) => !folders || e.dir) ? null : h('li.empty-note', folders ? 'No folders in here.' : 'This folder is empty.'),
      );
      // Focus starts on the first entry, and moves to the first entry of each folder you open (#26).
      const buttons = listEl.querySelectorAll('button');
      if (dlg?.dialog.isConnected) /** @type {HTMLElement | undefined} */ (buttons[r.path && buttons.length > 1 ? 1 : 0])?.focus();
    } catch (e) {
      // Nothing listed yet: the error takes the list’s place. Otherwise the list you were in stays.
      if (!listEl.childElementCount) listEl.replaceChildren(h('li.err', e.message));
      else {
        problem.replaceChildren(icon('warn'), e.message);
        problem.hidden = false;
      }
    }
  };
  load('');
  const dlg = openDialog({
    title: folders ? 'Add a folder' : 'Attach from the project folder',
    sub: folders ? 'The agent may work in it from its next turn.' : 'Postbox attaches a reference; nothing is copied.',
    body: [where, problem, listEl],
    size: 'lg',
  });
}

// ── Attach a Claude Code session ────────────────────────────────────────────────────────
// Lists the sessions Claude Code keeps on this computer, newest first. Attaching one makes it an agent in
// a new conversation: Postbox resumes that session when you write to it, and mirrors what you type in a terminal.

export function openAttachSession(projectId) {
  const listEl = h('ul.list-rows', h('li.empty-note', 'Looking for sessions…'));
  const attach = async (s) => {
    try {
      const r = await api('/api/claude-sessions/attach', { claudeSessionId: s.id, projectId });
      dlg.close();
      toast({ title: 'Attached', text: `${s.title} is a conversation now.` });
      setTimeout(() => navigate(`#/t/${r.threadId}`), 200);
    } catch (e) {
      toast({ title: 'Couldn’t attach it', text: e.message, level: 'blocking' });
    }
  };
  fetch('/api/claude-sessions')
    .then((r) => r.json())
    .then(({ sessions, error }) => {
      if (error) throw new Error(error);
      fill(
        listEl,
        sessions.length
          ? sessions.map((s) =>
              h(
                'li',
                icon('thread', 'dim'),
                h(
                  'span.grow',
                  h('b', s.title),
                  h('span.small.dim.mono', { style: { display: 'block' } }, `${s.cwd ?? 'Unknown folder'} · ${ago(s.updatedAt)}`),
                ),
                s.attached
                  ? h('span.small.dim', 'Attached')
                  : h('button.btn.sm', { type: 'button', 'aria-label': `Attach ${s.title}`, onclick: () => attach(s) }, 'Attach'),
              ),
            )
          : h('li.empty-note', 'No Claude Code sessions on this computer yet.'),
      );
    })
    .catch((e) => listEl.replaceChildren(h('li.err', e.message)));
  const dlg = openDialog({
    title: 'Attach a Claude Code session',
    sub: `It joins ${S().projects[projectId]?.name ?? 'this project'} as an agent that works in the session’s folder, with the default permissions.`,
    body: [listEl, h('p.small.dim', 'If the session is still running in a terminal, let it finish before you write to it here.')],
    foot: [h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Close')],
  });
}
