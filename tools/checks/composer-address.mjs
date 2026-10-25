// A headless Chrome check of whom the composer says a message reaches, typed as a person types:
//   • a draft that opens with an agent’s name and “:” or “,”, in a room where another agent spoke last, shows “Did you
//     mean @critic?”, whose one click adds the @; a name later in the draft, or the last speaker’s own, shows nothing
//     (#134, the rule the end-to-end tester uses);
//   • topic and side threads say who an unaddressed message goes to, “Replying to @x”, as the conversation does (#134);
//   • a draft that @-mentions an agent says it wakes that one, and not the agent it would otherwise go to (#107).
//
//   node tools/checks/composer-address.mjs
//
// It starts its own server with the demo seed (mock agents) on a fresh data folder in the temp directory.
// PB_PORT and PB_CHROME_PORT move it (5310 and 10610 by default), so sessions working in parallel don’t collide.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../../server/index.mjs';
import { js, launch, sleep } from '../cdp.mjs';
import { finish, ports, record } from '../harness.mjs';

const { PORT, CHROME_PORT } = await ports(5310, 10610);

process.env.POSTBOX_BACKENDS = 'mock';
const dataDir = await mkdtemp(join(tmpdir(), 'pb-check-composer-address-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const page = await launch({ port: CHROME_PORT });
const { rt, store } = app;

const settle = () => page.evaluate('new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 60)); setTimeout(r, 250); })');
const persona = (handle) => Object.values(store.state.personas).find((p) => p.handle === handle);
const text = (expr) => page.evaluate(`(${expr})?.textContent.replace(/\\s+/g, ' ').trim() ?? ''`);
const HINT = (input) => `document.querySelector('#${input}')?.closest('.composer').querySelector('.hint')`;
/** Empties a composer and types into it, as a keyboard’s text input does. */
async function typeIn(input, value) {
  await page.evaluate(`(() => { const t = document.querySelector('#${input}'); t.focus(); t.select(); })()`);
  await page.send('Input.insertText', { text: value });
  await settle();
}
async function click(expr) {
  const r = await page.evaluate(
    `(() => { const el = ${expr}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`Nothing to click: ${expr}`);
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: type === 'mouseMoved' ? 'none' : 'left', clickCount: 1 });
  await settle();
}
async function check(name, fn) {
  try {
    await fn();
    record(true, name);
  } catch (e) {
    record(false, name, e.message);
  }
}
const expect = (ok, what) => {
  if (!ok) throw new Error(what);
};
async function open(hash) {
  await page.synced(store.state.seq);
  await page.evaluate(`location.hash = ${js(hash)}`);
  await settle();
}

// A room where @researcher spoke last.
const room = rt.createThread({
  projectId: Object.keys(store.state.projects)[0],
  title: 'Address checks',
  personaIds: [persona('critic').id, persona('researcher').id],
});
const researcher = rt.sessionsIn(room.id).find((x) => x.handle === 'researcher');
const said = rt.addItem(room.id, {
  kind: 'agent',
  sessionId: researcher.id,
  personaId: researcher.personaId,
  handle: 'researcher',
  text: 'Revision 3 is up.',
  status: 'done',
});
rt.putThread({ ...store.state.threads[room.id], lastSpeaker: researcher.id });

await page.size(1280, 900);
await page.goto(`${app.origin}/#/t/${room.id}`);
await page.waitFor(`document.querySelector('#composer-input')`, { label: 'the composer' });
await settle();

await check('#134 “critic: …” shows “Did you mean @critic?”, and its click adds the @', async () => {
  await typeIn('composer-input', 'critic: what’s your biggest concern?');
  const hint = await text(HINT('composer-input'));
  expect(hint.includes('Did you mean @critic?'), `The hint reads “${hint}”`);
  expect(hint.includes('Replying to @researcher'), `The hint doesn’t say who it goes to: “${hint}”`);
  await click(`${HINT('composer-input')}.querySelector('.did-you-mean')`);
  const value = await page.evaluate(`document.querySelector('#composer-input').value`);
  expect(value === '@critic: what’s your biggest concern?', `The draft reads “${value}”`);
  expect(await page.evaluate(`document.activeElement?.id === 'composer-input'`), 'Focus didn’t go back to the composer');
  const after = await text(HINT('composer-input'));
  expect(!after.includes('Did you mean'), `The hint still asks: “${after}”`);
});

await check('#134 by keyboard: the suggestion is announced, keeps focus while the page repaints, and Enter adds the @', async () => {
  await typeIn('composer-input', '  critic, one question');
  const live = await page.evaluate(`document.querySelector('#live')?.textContent ?? ''`);
  expect(live.startsWith('Did you mean @critic?'), `The live region says “${live}”`);
  await page.evaluate(`${HINT('composer-input')}.querySelector('.did-you-mean').focus()`);
  // Anything an agent does repaints the composer.
  rt.updateSession(researcher.id, { currentStep: 'Reading revision 3' });
  await page.synced(store.state.seq);
  await settle();
  expect(await page.evaluate(`!!document.activeElement?.closest('.did-you-mean')`), 'Focus left the suggestion when the composer repainted');
  const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter, text: '\r', unmodifiedText: '\r' });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
  await settle();
  const value = await page.evaluate(`document.querySelector('#composer-input').value`);
  expect(value === '  @critic, one question', `The draft reads “${value}”`);
});

await check('#134 “Researcher, …” to the last speaker, and a name later in the draft, show no hint', async () => {
  for (const draft of ['Researcher, did you fix it?', 'What did the critic find?', 'the critics agree']) {
    await typeIn('composer-input', draft);
    const hint = await text(HINT('composer-input'));
    expect(!hint.includes('Did you mean'), `“${draft}” shows “${hint}”`);
  }
  await typeIn('composer-input', '');
});

await check('#107 replying while mentioning another agent says it wakes that one, not the last speaker', async () => {
  await typeIn('composer-input', '@critic what do you make of revision 3?');
  const hint = await text(HINT('composer-input'));
  expect(hint.includes('Wakes @critic, not @researcher (last speaker)'), `The hint reads “${hint}”`);
  expect(!hint.includes('Replying to'), `The hint still says it replies to the last speaker: “${hint}”`);
  await typeIn('composer-input', '@critic and @researcher, both of you');
  const both = await text(HINT('composer-input'));
  expect(both.includes('Wakes @critic, @researcher') && !both.includes(', not '), `The hint reads “${both}”`);
  await typeIn('composer-input', '');
});

await check('#134 a topic thread says who an unaddressed message goes to', async () => {
  const { threadId } = rt.startTopic(room.id, said.id);
  await open(`#/t/${room.id}/side/${threadId}`);
  await page.waitFor(`document.querySelector('#side-input')`, { label: 'the topic composer' });
  const hint = await text(HINT('side-input'));
  expect(hint.includes('Replying to @researcher'), `The topic hint reads “${hint}”`);
  await typeIn('side-input', 'critic, is this right?');
  const asked = await text(HINT('side-input'));
  expect(asked.includes('Did you mean @critic?'), `The topic hint reads “${asked}”`);
  await typeIn('side-input', '');
});

await check('#134 a side thread says who an unaddressed message goes to', async () => {
  rt.agentWake(researcher.id, 'critic', 'Check revision 3.');
  for (let i = 0; i < 100 && (rt.turns.size || rt.exiting.size); i++) await sleep(100);
  const side = Object.values(store.state.threads).find((x) => x.kind === 'side' && x.parentId === room.id);
  await open(`#/t/${room.id}/side/${side.id}`);
  await page.waitFor(`document.querySelector('#side-input')`, { label: 'the side thread composer' });
  const hint = await text(HINT('side-input'));
  expect(hint.includes('Replying to @critic'), `The side thread hint reads “${hint}”`);
});

await check('no errors in the page', async () => expect(!page.logs.length, page.logs.join('; ')));

await page.close?.();
await app.close();
await rm(dataDir, { recursive: true, force: true });
finish();
