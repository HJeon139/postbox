// Where a persona’s turns run (#120), in the new agent and persona sheets (app/js/sheets.mjs): this computer, or one
// of the hosts, for a backend that can run on a host, with what the host’s daemon found of its CLI there, whether it’s
// signed in there (#1608), and the server’s refusal when a save that moves it fails.

import { client } from './client.mjs';
import { h, icon } from './dom.mjs';
import { loginCommand, signInOf } from './host-signins.mjs';
import { command } from './hosts-parts.mjs';
import { toast } from './ui.mjs';

const S = () => client.state;

/**
 * Runs on (#120): this computer, or one of the hosts (state.hosts), for a backend that can run on a host
 * (capabilities.remote). One that isn’t on this computer (capabilities.local false) is offered only for a host.
 * Before you save, it says what the host’s daemon reported about the backend’s CLI there, and when the host says the
 * CLI isn’t signed in there (#1608), the command to run there; the server checks again, and its refusal shows here too
 * (st.placeError). A sign-out is a warning, not a refusal: the host’s status can be wrong, and the person decides.
 * @param {any} st @param {() => void} paint @param {{ idp: string, hosts: any[], here: boolean, name: string }} o  name: the backend’s
 */
export function placeField(st, paint, { idp, hosts, here, name }) {
  const host = st.remote ? S().hosts?.[st.remote] : null;
  const welcome = st.remote ? S().hostStatus?.[st.remote]?.welcome : null;
  const found = Array.isArray(welcome?.harnesses) ? welcome.harnesses.find((x) => x?.name === st.backend) : undefined;
  const missing = host && Array.isArray(welcome?.harnesses) && !found?.path;
  const login = host && !missing && signInOf(host.id, st.backend) === 'signed-out' ? loginCommand(st.backend) : null;
  const help = !hosts.length
    ? `${name} isn’t on this computer. Add a host under Settings, Hosts, to run it there.`
    : host
      ? `Its turns run on ${host.name}, over your own ssh; Postbox and its tools stay on this computer.${here ? '' : ` ${name} isn’t on this computer, so it runs only on a host.`}`
      : 'Its turns run here. A host runs them on another machine, over your own ssh.';
  return h(
    'div.field',
    hosts.length ? h('label.label', { for: `${idp}-where` }, 'Runs on') : h('span.label', 'Runs on'),
    hosts.length
      ? h(
          'div.select-wrap',
          h(
            'select.select',
            {
              id: `${idp}-where`,
              // Its errors and its sign-in warning are read with it; an error marks it invalid.
              'aria-describedby': [
                `${idp}-where-help`,
                missing ? `${idp}-where-missing` : '',
                login ? `${idp}-where-signin` : '',
                st.placeError ? `${idp}-where-err` : '',
              ]
                .filter(Boolean)
                .join(' '),
              'aria-invalid': missing || st.placeError ? 'true' : null,
              onchange: (e) => {
                st.remote = e.target.value || null;
                st.placeError = null;
                paint();
              },
            },
            h('option', { value: '', selected: !st.remote, disabled: !here }, here ? 'This computer' : `This computer (${name} isn’t here)`),
            hosts.map((x) => h('option', { value: x.id, selected: st.remote === x.id }, x.name)),
          ),
          icon('down'),
        )
      : h('span', 'No host yet'),
    h('span.help', { id: `${idp}-where-help` }, help),
    missing ? missingNote(idp, name, host, found) : null,
    login ? signInNote(idp, name, host, login) : null,
    st.placeError ? h('span.err', { role: 'alert', id: `${idp}-where-err` }, icon('warn'), st.placeError) : null,
  );
}

/**
 * The backend’s CLI wasn’t found on the host it picks, as the host’s daemon said, with where it looked.
 * @param {string} idp @param {string} name @param {any} host @param {any} found
 */
const missingNote = (idp, name, host, found) =>
  h(
    'span.err',
    { id: `${idp}-where-missing` },
    icon('warn'),
    `${name} wasn’t found on ${host.name}${found?.looked?.length ? `: Postbox’s daemon looked in ${found.looked.join(', ')}` : ''}. Install it there, or set its path in the host’s settings.`,
  );

/**
 * The host says the backend’s CLI isn’t signed in there (#1608): a warning, as the host’s card shows it, not an error,
 * with the command that signs it in, to copy and run on the host. The field is described by its words alone.
 * @param {string} idp @param {string} name @param {any} host @param {string} login
 */
const signInNote = (idp, name, host, login) =>
  h(
    'div.callout.warn.pe-signin',
    icon('warn'),
    h(
      'div.grow',
      { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 } },
      h(
        'p',
        { id: `${idp}-where-signin`, style: { margin: 0 } },
        `${name} isn’t signed in on ${host.name}, so this agent’s turns there would stop until it is. Run ${login} on ${host.name}:`,
      ),
      command(login),
    ),
  );

/**
 * A persona sheet’s save that failed: when where it runs changed, the server’s refusal (a host without that CLI, a
 * turn under way) shows under Runs on. Anything else is a toast.
 * @param {any} e @param {any} run  the sheet’s values @param {any} p  the persona @param {() => void} paintRun @param {HTMLElement} runBox
 */
export function saveRefused(e, run, p, paintRun, runBox) {
  if (run.backend !== (p.backend ?? 'mock') || (run.remote ?? null) !== (p.remote?.hostId ?? null)) {
    run.placeError = e.message;
    paintRun();
    if (!runBox.querySelector('#pe-where-err')) toast({ title: 'Couldn’t save', text: e.message, level: 'blocking' });
    else runBox.querySelector('#pe-where')?.focus();
  } else toast({ title: 'Couldn’t save', text: e.message, level: 'blocking' });
}
