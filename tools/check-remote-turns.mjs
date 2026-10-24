// A headless Chrome check of agents whose turns run on a host (#120, the plan’s L6), with axe at 1280 px:
// - the agents list and each ring say where an agent runs, when Postbox last heard from the host, and the
//   connection in words: Connected, Reconnecting, Disconnected (working) and Disconnected (idle) (G3);
// - the transcript shows each turn state in words: “Sign-in needed on <host>” and “Interrupted on <host>”, each with
//   Resume, which goes through the runtime’s resumeRemote and starts with why the last turn stopped; a hung turn’s
//   note; Lost, with no Retry; a stop the host hasn’t confirmed; and a replayed reply once, not twice;
// - permission cards a host ended say how: expired with nobody answering, canceled by the agent, or ended unrecorded;
// - a Kiro CLI turn on a host shows its warning as a notice, and a `!` command says it ran on this computer.
// Stop, the agent’s panel, the `!` hint, the persona sheet’s Runs on, and 375 px are tools/check-remote-stop.mjs.
//
//   node tools/check-remote-turns.mjs
//
// It starts its own Postbox with a fake host manager and the seeded states, as tools/remote-turns-kit.mjs sets them
// up. PB_PORT and PB_CHROME_PORT move it (4600 and 9800 by default).

import assert from 'node:assert/strict';
import { C, delivered, HUNG, hosts, rt, ses, store } from './remote-turns-kit.mjs';
import { axe, check, click, end, itemOf, page, q, ringLabel, row, text, until } from './remote-turns-page.mjs';

await check('#120 G3 the agents list says each remote agent’s host, when it was last heard from, and the connection in words', async () => {
  assert.match(await row('coder'), /On host\.example\.com · Connected · last heard from 2 min ago/);
  assert.match(await row('tester'), /On gpu\.example\.com · Reconnecting · last heard from 5 min ago/);
  assert.match(await row('builder'), /On build\.example\.com · Disconnected \(working\) · last heard from 40 min ago/);
  assert.match(await row('builder'), /Lost: Postbox can’t reach build\.example\.com, and the turn may still run there/);
  assert.match(await row('idler'), /On build\.example\.com · Disconnected \(idle\) · last heard from 40 min ago/);
  assert.match(await row('coder'), /Sign-in needed on host\.example\.com/);
  assert.match(await row('stopper'), /Stopping on host\.example\.com: Postbox waits for the host to confirm/);
  // Codex’s `auto`, and a Claude model a Codex persona kept, read as Codex’s default.
  assert.match(await row('cx'), /Codex’s default · medium effort/);
  assert.doesNotMatch(await row('cx'), /Opus/);
});

await check('#120 G3 each ring’s label says where its agent runs and the connection, not by color alone', async () => {
  assert.match(
    await ringLabel('builder'),
    /^@builder: Idle, \d+% of context used; on build\.example\.com, disconnected \(working\), last heard from 40 min ago$/,
  );
  assert.match(await ringLabel('coder'), /; on host\.example\.com, connected, last heard from 2 min ago$/);
  // A change to the host’s status reaches the rings and the rows without a session change.
  hosts.set(C.id, { state: 'connected', failure: null, welcome: null, lastHeard: Date.now(), name: C.name });
  await page.waitFor(
    `[...document.querySelectorAll('.agent-row')].some((n) => /On gpu\\.example\\.com · Connected · last heard from just now/.test(n.innerText) && /connected, last heard from just now/.test(n.querySelector('pb-ring svg').getAttribute('aria-label')))`,
    { label: 'the tester’s row and ring, connected' },
  );
});

await check('#120 the turn states read in words in the transcript: Sign-in needed and Interrupted with Resume, hung, Lost', async () => {
  assert.match(
    await text(`${itemOf('coder')}.querySelector('.host-callout')`),
    /^Sign-in needed on host\.example\.com · Sign in there, then resume @coder\. Resume it once you’ve signed in\. Resume$/,
  );
  assert.match(
    await text(`${itemOf('fixer')}.querySelector('.host-callout')`),
    /^Interrupted on host\.example\.com · The agent’s process there ended without finishing its turn\. It was interrupted again after Postbox resumed it, so it waits for you\. Resume$/,
  );
  assert.equal(await text(`${itemOf('watcher')}.querySelector('.stopped-tag')`), HUNG);
  assert.match(
    await text(`${itemOf('builder')}.querySelector('.host-callout')`),
    /^Lost: Postbox can’t reach build\.example\.com · The connection to build\.example\.com gave up\. The turn may still be running there\. Postbox attaches to it again once the host is back\.$/,
  );
  // Retry would start over on the host, not resume: it isn’t offered for any of them.
  assert.equal(await page.evaluate(`[...document.querySelectorAll('.host-callout button')].some((b) => /Retry/.test(b.textContent))`), false);
  assert.match(
    await text(q('.host-turns')),
    /^@stopper · Stopping on host\.example\.com: Postbox asked it to stop, and waits for the host to confirm\. It may still run there until then\.$/,
  );
});

await check('#120 a replayed reply shows once, with its name, and a Kiro turn’s warning is a notice above it', async () => {
  const scouts = await page.evaluate(
    `[...document.querySelectorAll('.transcript .item')].filter((n) => !n.hidden).filter((n) => /I read the README|@scout/.test(n.innerText)).length`,
  );
  assert.equal(scouts, 1, 'one reply from @scout');
  assert.equal(await page.evaluate(`!!${itemOf('scout')}.querySelector('.who')`), true, 'it names its speaker');
  assert.match(
    await text(`${itemOf('scout')}.querySelector('.host-notice')`),
    /^Other users on the host can read this message Kiro CLI takes its message as a command-line argument/,
  );
  assert.equal(await page.evaluate(`${itemOf('scout')}.querySelector('.host-notice').getAttribute('role')`), 'note');
  // The notice isn’t folded into the steps, and isn’t counted as a tool.
  assert.equal(await text(`${itemOf('scout')}.querySelector('details.activity summary')`), 'Read 1 file · 0.0 s in tools');
});

await check('#120 permission cards a host ended say how: nobody answered in time, canceled by the agent, or ended unrecorded', async () => {
  const notes = await page.evaluate(`[...document.querySelectorAll('.transcript .block.answered .answered-note')].map((n) => n.textContent.trim())`);
  assert.deepEqual(notes, ['Expired: nobody answered in time', 'Canceled by the agent', 'Ended: Postbox couldn’t save the expiry']);
});

await check('#120 a ! command run while the agent works on a host says it ran on this computer, once', async () => {
  assert.equal(await text(q('.cmd-block .cmd-where')), 'Ran on this computer, not on host.example.com.');
  assert.equal(await text(q('.cmd-block .cmd-out')), 'On branch main');
});

await check('#120 axe finds no violations in the room at 1280 px', async () => {
  assert.deepEqual(await axe(), []);
});

await check('#120 Resume calls the runtime’s resume, which starts with why the last turn stopped, and Resume goes', async () => {
  const before = delivered.length;
  await click(`${itemOf('coder')}.querySelector('.host-callout button')`);
  await until(() => delivered.length > before, 'the resumed turn');
  const d = delivered.at(-1);
  assert.equal(d.remote, true, 'it ran through the remote path');
  assert.match(
    d.context.join('\n'),
    /^\[Postbox\] Your last turn on host\.example\.com stopped before it finished, because the sign-in on that host had run out\./,
  );
  assert.match(d.text, /The person asked you to resume/);
  await page.waitFor(
    `![...document.querySelectorAll('.host-callout button')].some((b) => b.getAttribute('aria-label') === 'Resume @coder on host.example.com')`,
    {
      label: 'Resume to go',
    },
  );
  await until(() => !rt.turns.has(ses.coder.id), 'the turn to end');
  assert.equal(store.state.sessions[ses.coder.id].remoteTurn.state, 'done');
});

await end();
