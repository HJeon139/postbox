// The UAT driver’s Hosts tab (#120; app/js/hosts*.mjs), used the way a person sets up a host: add it, set its
// settings and the project’s folder there, Install and read the confirm, put an agent on it in its persona’s Runs on,
// and Remove it at the end, accepting that confirm too. The driver’s own helpers come in first (tools/uat/driver.mjs,
// d.kit), as the review module’s do. Where the page offers no control for a step a run needs, the step says so in
// what it returns, and does what the control would.

import { sleep } from '../cdp.mjs';
import { byText, J } from './selectors.mjs';

const TOP = `[...document.querySelectorAll('.dialog')].at(-1)`;
const CARD = (id) => `document.querySelector(${J(`[data-host="${id}"]`)})`;
// A setting’s field holds it in the unit it shows: durations in minutes, and these in theirs.
const SCALE = /** @type {Record<string, number>} */ ({ 'keepAlive.interval': 1000, logMaxBytes: 1024 * 1024 });

/** Waits until an expression holds, or throws with what it waited for. @param {any} kit */
async function until(kit, expr, what, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (await kit.ev(`!!(${expr})`)) return;
  throw new Error(`Timed out waiting for ${what}.`);
}

/** Opens Settings › Hosts unless it’s open. @param {any} kit */
export async function openHosts(kit) {
  if (await kit.ev(`!!document.getElementById('ho-add')`)) return;
  await closeAll(kit);
  await kit.clickAt(`document.querySelector('[aria-label="Settings"]')`, 'the Settings button');
  await kit.clickAt(byText('document.querySelector(".dialog")', '[role=tab], button', 'Hosts'), 'the Hosts tab');
  await until(kit, `document.getElementById('ho-add')`, 'the Hosts tab');
}

/** Closes every dialog, as Escape does. @param {any} kit */
export async function closeAll(kit) {
  for (let i = 0; i < 4 && (await kit.ev(`!!document.querySelector('.backdrop')`)); i++) await kit.press('Escape');
}

/** Types into a field as a person does, replacing what it held. @param {any} kit */
async function typeOver(kit, sel, value) {
  await kit.clickAt(`document.querySelector(${J(sel)})`, sel);
  await kit.ev(`(() => { const el = document.querySelector(${J(sel)}); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  if (value !== '') await kit.page.send('Input.insertText', { text: String(value) });
  // Leaving it checks it, as a person tabbing on does: its error shows now, not as the next click lands, when it
  // would move what that click aims at.
  await kit.press('Tab');
  await sleep(150);
}

/** Picks an option of a select, as the driver’s act does. @param {any} kit */
const pick = (kit, sel, value) =>
  kit.ev(
    `(() => { const s = document.querySelector(${J(sel)}); s.value = ${J(value)}; s.dispatchEvent(new Event('change', { bubbles: true })); s.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  );

/**
 * Adds a host under Add a host. Returns its id, from its card.
 * @param {any} kit @param {string} destination
 */
export async function addHost(kit, destination) {
  await openHosts(kit);
  await typeOver(kit, '#ho-add', destination);
  await kit.clickAt(`document.getElementById('ho-add-btn')`, 'Add host');
  const card = `[...document.querySelectorAll('[data-host]')].find((c) => c.querySelector('h3')?.textContent === ${J(destination)})`;
  for (let i = 0; i < 40; i++) {
    const id = await kit.ev(`${card}?.dataset.host ?? null`);
    if (id) return id;
    const err = await kit.ev(`(() => { const e = document.getElementById('ho-add-err'); return e && !e.hidden ? e.textContent : null; })()`);
    if (err) throw new Error(`Adding ${destination} was refused: ${err}`);
    await sleep(250);
  }
  throw new Error(`Adding ${destination} showed no card for it.`);
}

/** Sets one setting’s field in the open editor, by the kind of control it is. @param {any} kit */
async function setField(kit, id, key, value) {
  const cid = `#ho-${id}-${key.replace('.', '-')}`;
  const kind = await kit.ev(
    `(() => { const el = document.querySelector(${J(cid)}); if (!el) return null; if (el.getAttribute('role') === 'checkbox') return 'check'; if (document.querySelector(${J(`${cid}-unit`)})) return 'duration'; return el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'argv' : el.type === 'number' ? 'number' : 'text'; })()`,
  );
  if (!kind) throw new Error(`The host’s editor has no field for ${key}.`);
  if (kind === 'check') {
    if ((await kit.ev(`document.querySelector(${J(cid)}).getAttribute('aria-checked') === 'true'`)) !== value)
      await kit.clickAt(`document.querySelector(${J(cid)})`, key);
  } else if (kind === 'duration') {
    await pick(kit, `${cid}-unit`, 'min');
    await typeOver(kit, cid, String(value / 60_000));
  } else if (kind === 'select') await pick(kit, cid, value);
  else if (kind === 'argv') await typeOver(kit, cid, (value ?? []).join('\n'));
  else if (kind === 'number') await typeOver(kit, cid, String(value / (SCALE[key] ?? 1)));
  else await typeOver(kit, cid, value ?? '');
}

/** Every setting in a patch, keepAlive’s two by their path. @param {Record<string, any>} settings */
const flat = (settings) =>
  Object.entries(settings).flatMap(([k, v]) => (k === 'keepAlive' ? Object.entries(v).map(([s, x]) => [`keepAlive.${s}`, x]) : [[k, v]]));

/**
 * Edit settings on a host’s card: sets each setting, and a project’s folder there, then Save. Throws with the
 * editor’s refusal.
 * @param {any} kit @param {string} id @param {Record<string, any>} settings @param {{ project?: string, folder?: string }} [o]
 */
export async function editHost(kit, id, settings, { project, folder } = {}) {
  await openHosts(kit);
  await kit.clickAt(`document.getElementById(${J(`ho-${id}-edit`)})`, 'Edit settings');
  await until(kit, `document.getElementById(${J(`ho-${id}-save`)})`, 'the host’s editor');
  for (const [k, v] of flat(settings)) await setField(kit, id, k, v);
  if (project && folder) await typeOver(kit, `#ho-${id}-pf-${project}`, folder);
  await kit.clickAt(`document.getElementById(${J(`ho-${id}-save`)})`, 'Save');
  for (let i = 0; i < 60; i++) {
    if (!(await kit.ev(`!!document.getElementById(${J(`ho-${id}-save`)})`))) return;
    const err = await kit.ev(
      `(() => { const e = document.getElementById(${J(`ho-${id}-form-err`)}); if (!e || e.hidden || !e.textContent) return null; return [e.textContent, ...[...${CARD(id)}.querySelectorAll('.err:not([hidden])')].map((x) => x.textContent)].filter(Boolean).join(' '); })()`,
    );
    if (err) throw new Error(`The host’s settings weren’t saved: ${err}`);
    await sleep(250);
  }
  throw new Error('Saving the host’s settings didn’t close its editor.');
}

/**
 * Install… on the host’s card, then the confirm’s Install. A host just added may have no Install… (no status yet):
 * then the run opens the same confirm the button opens, and says so (installOffered false).
 * @param {any} kit @param {string} id @returns {Promise<{ installOffered: boolean, card: string, confirm: string, commands: string[] }>}
 */
export async function install(kit, id) {
  await openHosts(kit);
  const button = `document.getElementById(${J(`ho-${id}-install`)})`;
  let installOffered = false;
  for (let i = 0; i < 20 && !(installOffered = await kit.ev(`!!${button}`)); i++) await sleep(250);
  const card = String(await kit.ev(`${CARD(id)}?.innerText ?? ''`)).replace(/\s+/g, ' ');
  if (installOffered) await kit.clickAt(button, 'Install…');
  else
    await kit.ev(
      `Promise.all([import('/app/js/hosts-confirm.mjs'), import('/app/js/client.mjs')]).then(([m, c]) => { m.confirmInstall(c.client.state.hosts[${J(id)}]); })`,
    );
  await until(kit, `document.querySelector('.ho-install-text')`, 'the install confirm');
  const confirm = await kit.ev(`document.querySelector('.ho-install-text').textContent`);
  const commands = await kit.ev(`[...document.querySelectorAll('.ho-install-commands code')].map((c) => c.textContent)`);
  await kit.clickAt(`document.getElementById('ho-install-go')`, 'Install');
  for (let i = 0; i < 720; i++) {
    if (!(await kit.ev(`!!document.querySelector('.ho-install-text')`))) return { installOffered, card, confirm, commands };
    const err = await kit.ev(`document.querySelector('.ho-install-result .callout')?.innerText ?? null`);
    if (err) throw new Error(`Installing failed: ${String(err).replace(/\s+/g, ' ')}`);
    await sleep(250);
  }
  throw new Error('The install didn’t finish in 3 minutes.');
}

/**
 * Settings › Personas › Edit @handle › Runs on: a host’s id, or null for this computer; then Save. Throws with the
 * refusal under Runs on.
 * @param {any} kit @param {string} handle @param {string|null} hostId
 */
export async function placePersona(kit, handle, hostId) {
  await closeAll(kit);
  await kit.clickAt(`document.querySelector('[aria-label="Settings"]')`, 'the Settings button');
  await kit.clickAt(byText('document.querySelector(".dialog")', '[role=tab], button', 'Personas'), 'the Personas tab');
  await kit.clickAt(`document.querySelector(${J(`.dialog [aria-label="Edit @${handle}"]`)})`, `Edit @${handle}`);
  await until(kit, `document.getElementById('pe-where')`, `Runs on in @${handle}’s editor`);
  await pick(kit, '#pe-where', hostId ?? '');
  await kit.clickAt(byText(TOP, 'button.send', 'Save'), 'Save');
  for (let i = 0; i < 40; i++) {
    const err = await kit.ev(`document.getElementById('pe-where-err')?.textContent ?? null`);
    if (err) throw new Error(`@${handle} couldn’t be placed: ${err}`);
    if (!(await kit.ev(`!!document.getElementById('pe-where')`))) break;
    await sleep(250);
  }
  await closeAll(kit);
}

/**
 * Remove… on the host’s card, then the confirm’s action. Returns the confirm’s text, or throws with the refusal.
 * @param {any} kit @param {string} id @returns {Promise<string>}
 */
export async function removeHost(kit, id) {
  await openHosts(kit);
  await kit.clickAt(`document.getElementById(${J(`ho-${id}-remove`)})`, 'Remove…');
  await until(kit, `document.getElementById('ho-remove-go')`, 'the remove confirm');
  const confirm = String(await kit.ev(`${TOP}?.innerText ?? ''`)).replace(/\s+/g, ' ');
  await kit.clickAt(`document.getElementById('ho-remove-go')`, 'Remove Postbox from the host');
  for (let i = 0; i < 480; i++) {
    if (!(await kit.ev(`!!${CARD(id)}`))) return confirm;
    const err = await kit.ev(`document.querySelector('.ho-remove-result .callout')?.innerText ?? null`);
    if (err) throw new Error(`Remove was refused: ${String(err).replace(/\s+/g, ' ')}`);
    await sleep(250);
  }
  throw new Error('Remove didn’t finish in 2 minutes.');
}
