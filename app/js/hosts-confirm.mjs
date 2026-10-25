// What the Hosts tab (app/js/hosts.mjs) asks before it acts on a host (#120): installing Postbox there, in
// describeInstall’s words; taking the host over from another Postbox; and removing it, there and then here. Each is an
// alert dialog whose action says what it does, and a refusal shows in it with its next step.

import { api, client } from './client.mjs';
import { fill, h, icon, plural } from './dom.mjs';
import { withCode } from './hosts-parts.mjs';
import { openDialog, say, toast } from './ui.mjs';

const S = () => client.state;

/** Why an install failed, and what to do next. @param {any} e */
const installFailed = (e) =>
  h(
    'div.callout',
    icon('warn'),
    h(
      'div.grow',
      { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 } },
      h('b', { style: { overflowWrap: 'anywhere' } }, e.message),
      e.next ? h('p', { style: { margin: 0, overflowWrap: 'anywhere' } }, withCode(e.next)) : null,
    ),
  );

/** The install confirm’s Install, which installs and says how it went. @param {any} host @param {HTMLElement} result @param {() => void} close */
function installGo(host, result, close) {
  const go = h(
    'button.btn.send',
    {
      type: 'button',
      id: 'ho-install-go',
      onclick: async () => {
        go.disabled = true;
        go.textContent = 'Installing…';
        fill(result);
        try {
          const r = await api(`/api/hosts/${host.id}/install`, {});
          close();
          toast({
            title: r.installed === false ? `This Postbox was already on ${host.name}` : `Installed Postbox on ${host.name}`,
            text: 'Postbox connects when an agent’s turn there needs it.',
          });
        } catch (e) {
          fill(result, installFailed(e));
          go.disabled = false;
          go.textContent = 'Install again';
        }
      },
    },
    'Install',
  );
  return go;
}

/** Installing writes on both computers, so it says what it writes, in describeInstall’s words, then installs. @param {any} host */
export const confirmInstall = async (host) => {
  let about;
  try {
    about = await api(`/api/hosts/${host.id}/install`, undefined, 'GET');
  } catch (e) {
    toast({ title: `Couldn’t get ready to install on ${host.name}`, text: e.message, level: 'blocking' });
    return;
  }
  const result = h('div.ho-install-result', { role: 'alert' });
  const go = installGo(host, result, () => dlg.close());
  const dlg = openDialog({
    title: `Install Postbox on ${host.name}?`,
    role: 'alertdialog',
    body: [
      h('p.ho-install-text', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 } }, about.text),
      about.commands?.length
        ? h(
            'details.ho-install-commands',
            h('summary.small', { style: { cursor: 'pointer' } }, 'The commands ssh runs there'),
            about.commands.map((/** @type {string} */ c) =>
              h('code', { style: { display: 'block', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap', marginTop: '6px' } }, c),
            ),
          )
        : null,
      result,
    ],
    foot: [h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), go],
    initialFocus: () => go,
  });
  // The steps can be longer than a small window: the body scrolls, so it takes focus to scroll by keyboard.
  dlg.dialog.querySelector('.d-body')?.setAttribute('tabindex', '0');
};

/** Another Postbox drives the host: taking over disconnects it, so it says so first. @param {any} host */
export const confirmTakeover = (host) => {
  const go = h(
    'button.btn.send',
    {
      type: 'button',
      id: 'ho-takeover-go',
      onclick: () =>
        api(`/api/hosts/${host.id}/retry`, { takeover: true })
          .then(() => {
            dlg.close();
            say(`Taking over ${host.name}`);
          })
          .catch((e) => toast({ title: `Couldn’t take over ${host.name}`, text: [e.message, e.next].filter(Boolean).join(' '), level: 'blocking' })),
    },
    'Take over',
  );
  const dlg = openDialog({
    title: `Take over ${host.name}?`,
    role: 'alertdialog',
    body: [
      h(
        'p',
        { style: { margin: 0 } },
        `Another Postbox is connected to ${host.name} and driving it, such as Postbox on another computer of yours. Only one Postbox can drive a host at a time.`,
      ),
      h(
        'p',
        { style: { margin: 0 } },
        `Taking over disconnects the other one: it stops following its turns on ${host.name}, and can’t start new ones there until it takes over again. Turns already running there keep running.`,
      ),
    ],
    foot: [h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), go],
    initialFocus: () => go,
  });
};

/** Why a removal was refused, and what to do next. @param {any} e */
const removeFailed = (e) =>
  h(
    'div.callout',
    icon('warn'),
    h(
      'div.grow',
      { style: { display: 'flex', flexDirection: 'column', gap: '6px', minWidth: 0 } },
      h('p', { style: { margin: 0, overflowWrap: 'anywhere' } }, e.message),
      e.next ? h('p.ho-remove-next', { style: { margin: 0, overflowWrap: 'anywhere' } }, withCode(e.next)) : null,
    ),
  );

/**
 * The remove confirm’s action, which removes the host and says how it went.
 * @param {any} host @param {HTMLElement} status @param {{ noToken: boolean, label: string }} o @param {() => void} close
 */
function removeGo(host, status, { noToken, label }, close) {
  const go = h(
    'button.btn.danger',
    {
      type: 'button',
      id: 'ho-remove-go',
      // It names the host, whose name may be long: it wraps rather than run off a narrow window.
      style: { whiteSpace: 'normal', overflowWrap: 'anywhere', height: 'auto', minHeight: '32px', paddingBlock: '6px' },
      onclick: async () => {
        go.disabled = true;
        go.textContent = noToken ? 'Removing…' : `Removing Postbox from ${host.name}…`;
        fill(status);
        try {
          const r = await api(`/api/hosts/${host.id}`, undefined, 'DELETE');
          close();
          // Its card, and the Remove… focus would go back to, are gone.
          document.getElementById('ho-add')?.focus();
          toast({ title: `Removed ${host.name}`, text: r.stopped ? `Stopped ${plural(r.stopped, 'turn')} there first.` : '' });
        } catch (e) {
          fill(status, removeFailed(e));
          go.disabled = false;
          go.textContent = 'Try again';
        }
      },
    },
    icon('trash', 'i-sm'),
    label,
  );
  return go;
}

/**
 * What removing does, said first: what it deletes there (or, with no token here, that it only forgets the host), the
 * agents placed there, and what happens when the host doesn’t confirm.
 * @param {any} host @param {{ noToken: boolean, placed: any[], forgets: string }} o
 */
const removeBody = (host, { noToken, placed, forgets }) => [
  noToken
    ? h(
        'p',
        { style: { margin: 0 } },
        `This computer has no token for ${host.name}, so Postbox can’t reach anything of its own there. It forgets the host here: ${forgets}. Any Postbox files on ${host.name} stay, in ~/.postbox-remote.`,
      )
    : h(
        'p',
        { style: { margin: 0 } },
        `Postbox stops the daemon and every turn still running on ${host.name}, and deletes ~/.postbox-remote there: its code, token, logs and turn records. Then it forgets the host here: ${forgets}. The agents’ working folders there, such as ~/postbox-work/<handle>, stay. Another Postbox that uses ${host.name} loses its access too, since the token goes.`,
      ),
  placed.length
    ? h(
        'p',
        { style: { margin: 0 } },
        `${placed.map((p) => `@${p.handle}`).join(', ')} ${placed.length === 1 ? 'runs' : 'run'} there, and can’t start a turn until you pick another place for ${placed.length === 1 ? 'it' : 'them'}.`,
      )
    : null,
  noToken
    ? null
    : h(
        'p.small.dim',
        { style: { margin: 0 } },
        `If ${host.name} can’t be reached or doesn’t confirm, Postbox keeps the host and its token, so you can try again.`,
      ),
];

/**
 * Removing stops the host’s turns, then removes Postbox from the host (the daemon deletes ~/.postbox-remote), then
 * forgets the host here. A refusal (409) says why, a turn it can’t stop or a host that didn’t confirm, with the next
 * step, and the host stays. One this computer has no token for can only be forgotten here, and says so.
 * @param {any} host
 */
export const confirmRemove = (host) => {
  const placed = Object.values(S().personas).filter((p) => p.remote?.hostId === host.id && !p.retired);
  const folders = Object.values(S().projects).filter((p) => p.hostFolders?.[host.id]).length;
  const st = S().hostStatus?.[host.id] ?? null;
  // No token here (a failure would be the host’s program missing there, which an install fixes).
  const noToken = st?.state === 'not-installed' && !st.failure;
  const label = noToken ? 'Remove host' : `Remove Postbox from ${host.name}`;
  const status = h('div.ho-remove-result', { role: 'alert' });
  const go = removeGo(host, status, { noToken, label }, () => dlg.close());
  const cancel = h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel');
  const forgets = `its settings, ${folders ? plural(folders, 'project folder') : 'its project folders'} there, and its token on this computer`;
  const dlg = openDialog({
    title: `Remove ${host.name}?`,
    role: 'alertdialog',
    body: [...removeBody(host, { noToken, placed, forgets }), status],
    foot: [cancel, go],
    // Cancel first, as for anything that deletes.
    initialFocus: () => cancel,
  });
};
