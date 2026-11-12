// The README’s highlight GIF: about 30 seconds of the loop Postbox is best at, replayed from a real session recorded
// with real agents (tools/demo/showcase/, its README says how): a question; @builder (Claude Code) answering with a live
// app; @critic (Codex) pinning comments to the app’s parts; v2 landing; and the Work view of what changed and what it
// cost. The mock plays the recording, so it costs nothing and needs no agent accounts. It starts its own Postbox in demo
// mode on a port and a temporary data folder of its own, drives a light-theme page at 1280 × 800 with Playwright,
// records it, keeps only the moments that show something, and turns them into a GIF with ffmpeg’s two-pass palette
// (designs/developing.md, “Screenshots”).
//
//   node tools/readme-gif.mjs                      → screenshots/readme/highlight.gif, and the two stills beside it
//   node tools/readme-gif.mjs --port 4734 --keep   keeps the recorded video beside the GIF
//
// ffmpeg must be on PATH, or named by FFMPEG.

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { start } from '../server/index.mjs';
import { client, sleep } from './demo-client.mjs';
import { replay, replayTitle, story } from './demo-showcase.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'screenshots', 'readme');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg('port', 4734));
const KEEP = process.argv.includes('--keep');
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const SIZE = { width: 1280, height: 800 };
// The GIF’s width, frame rate and palette: legible at the README’s width, and under about 6 MB.
const GIF = { width: 880, fps: 8, colors: 40 };

/** The moments to keep, each from the time it starts to the time it ends, in seconds since the recording began. */
const cuts = [];
let began = 0;
const now = () => (Date.now() - began) / 1000;
/** Keeps what the page shows while fn runs. @param {() => Promise<unknown>} fn */
async function keep(fn) {
  const from = now();
  await fn();
  cuts.push([from, now()]);
}

/** Types into the composer a character at a time, as a person does, then sends it. */
async function say(page, text) {
  const box = page.locator('#composer-input');
  await box.click();
  await box.pressSequentially(text, { delay: 6 });
  await box.press('Enter');
}

/** Scrolls the transcript until this element’s top is near the window’s. @param {import('@playwright/test').Locator} at */
const toTop = (at) => at.evaluate((n) => n.scrollIntoView({ block: 'start', behavior: 'smooth' }));

/** An app’s own item, not the copy a review block of it shows: the latest version is the last one in the room. */
const APP = '.app-body:not(.app-review-wrap .app-body)';

/** A replay’s v2, in its own item’s frame. @param {any} st  its story */
const latest = (st) => `${APP} iframe[src*="/${encodeURIComponent(st.turns.build.app.id)}/2?"]`;

/** A wait for an app’s pre-display check to have passed, or shown it with a note. @param {string} id */
const checked = (id) => (/** @type {any} */ x) => ['passed', 'note'].includes(x.apps[id]?.check.status) && x;

/** The opening frame: a finished replay, its v2 app on screen, played off camera first. Returns its room. */
async function opening(page, c, origin) {
  const { thread, story: st } = await replay(c, 'capacity');
  await page.goto(`${origin}/#/t/${thread.id}`);
  await c.until(checked(st.turns.build.app.id), { label: 'the opening app’s check', timeout: 60000 });
  await page.locator(latest(st)).last().waitFor({ timeout: 60000 });
  await toTop(page.locator(APP).last());
  await sleep(2500);
  await keep(() => sleep(2500));
  return thread;
}

/** The question, typed into a new room with @builder and @critic, and @builder’s app answering it. */
async function question(page, c, origin, projectId, st) {
  const s = await c.state();
  const handle = (h) => Object.values(s.personas).find((p) => p.handle === h).id;
  const room = await c.call('/api/threads', { projectId, title: replayTitle(st), personaIds: [handle('builder'), handle('critic')] });
  await page.goto(`${origin}/#/t/${room.id}`);
  await page.locator('#composer-input').waitFor();
  await keep(async () => {
    await say(page, st.ask);
    await page.locator(`${APP} iframe`).first().waitFor({ timeout: 60000 });
    // Slower from here, so @critic’s comments are seen open before @builder resolves them.
    await c.call('/api/demo/speed', { speed: 3 });
    await c.until(checked(st.turns.build.app.id), { label: 'v1’s check', timeout: 60000 });
    await toTop(page.locator(APP).first());
    await sleep(4000);
  });
  return room;
}

/** v2, after @builder resolved @critic’s comments: one click on it, as a person would. */
async function v2Click(page, c, room, st) {
  await c.until((x) => x.apps[st.turns.build.app.id]?.current === 2 && c.idle(x, x.threads[room.id]) && x, { label: 'v2', timeout: 60000 });
  await c.until(checked(st.turns.build.app.id), { label: 'v2’s check', timeout: 60000 });
  const v2 = latest(st);
  await page.locator(v2).last().waitFor({ timeout: 60000 });
  await toTop(page.locator(APP).last());
  await sleep(1500);
  // The leader dies in the middle of a write, and the cluster recovers.
  await keep(async () => {
    // A frame takes the pointer once it’s over it (app/js/apps.mjs), so the pointer moves onto the frame first.
    const button = await page
      .frameLocator(v2)
      .last()
      .getByRole('button', { name: /leader dies mid-write/ })
      .boundingBox();
    if (!button) throw new Error('v2 has no “leader dies mid-write” button on screen.');
    await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2, { steps: 8 });
    await sleep(400);
    await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
    await sleep(6000);
  });
}

/** The scenes, each cut to the part worth seeing. */
async function scenes(page, c, origin) {
  const first = await opening(page, c, origin);
  const st = story('raft');
  const room = await question(page, c, origin, first.projectId, st);
  // @critic’s comments, pinned to the app’s parts in the review block.
  await c.until((x) => c.items(x, x.threads[room.id]).find((i) => i.block?.id === st.turns.critique.blockId)?.block.threads?.length && x, {
    label: '@critic’s comments',
    timeout: 60000,
  });
  await keep(async () => {
    await toTop(page.locator('.rv-pins').first());
    await sleep(5500);
  });
  await c.call('/api/demo/speed', { speed: 0.35 });
  await v2Click(page, c, room, st);
  // The Work view: the file @builder changed, its turns, and what they cost.
  await page.goto(`${origin}/#/t/${room.id}?work`);
  await keep(async () => {
    await page.locator('#wp-title').waitFor();
    await sleep(6000);
  });
}

/** The README’s two stills, each a replay’s v2 cropped to its app, in the light theme at twice the pixels. */
const STILLS = { deps: 'module-graph.png', capacity: 'capacity-plan.png' };

/** Plays each still’s replay in a room of its own and saves its app. */
async function stills(browser, c, origin) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 2600 }, colorScheme: 'light', deviceScaleFactor: 2 });
  await c.call('/api/demo/speed', { speed: 0.1 });
  for (const [key, name] of Object.entries(STILLS)) {
    // An app’s id is the recording’s, so a replay the GIF already played is shown from its room, not played again.
    const st = story(key);
    const played = Object.values((await c.state()).threads).find((t) => t.title === replayTitle(st));
    const thread = played ?? (await replay(c, key, { view: (hash) => page.goto(`${origin}/${hash}`).then(() => {}) })).thread;
    await page.goto(`${origin}/#/t/${thread.id}`);
    await c.until(checked(st.turns.build.app.id), { label: `${key}’s check`, timeout: 60000 });
    const frame = page.locator(latest(st)).last();
    await frame.waitFor();
    await frame.evaluate((n) => n.scrollIntoView({ block: 'start' }));
    await sleep(3000);
    // Postbox’s own bar and composer sit over the app’s top and bottom edges: hidden for the crop.
    await page.addStyleTag({ content: 'header.topbar, .composer { visibility: hidden !important }' });
    await frame.screenshot({ path: join(OUT, name) });
  }
  await page.close();
}

/** Runs ffmpeg with these arguments, and throws with its last lines when it fails. @param {string[]} args */
function ffmpeg(args) {
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (r.error) throw new Error(`ffmpeg didn’t run (${r.error.message}). Install it, or name it with FFMPEG.`);
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.trim().split('\n').slice(-3).join(' ')}`);
}

/** The kept moments, joined, as a GIF, through a palette made from those frames first. */
function toGif(video, gif, palette) {
  const parts = cuts.map(([a, b], i) => `[0:v]trim=start=${a.toFixed(2)}:end=${b.toFixed(2)},setpts=PTS-STARTPTS[c${i}]`);
  const joined = `${parts.join(';')};${cuts.map((_, i) => `[c${i}]`).join('')}concat=n=${cuts.length}:v=1:a=0`;
  const scaled = `${joined},fps=${GIF.fps},scale=${GIF.width}:-1:flags=lanczos`;
  ffmpeg(['-i', video, '-filter_complex', `${scaled},palettegen=max_colors=${GIF.colors}:stats_mode=diff`, palette]);
  ffmpeg(['-i', video, '-i', palette, '-filter_complex', `${scaled}[v];[v][1:v]paletteuse=dither=none:diff_mode=rectangle`, gif]);
}

// The Work view shows a file the mock writes in the data folder, so its path is one that names nothing of this machine.
const dataDir = await mkdtemp('/tmp/postbox-');
const videos = await mkdtemp(join(tmpdir(), 'pb-readme-video-'));
const app = await start({ port: PORT, dataDir, fresh: true, demo: true, quiet: true });
const origin = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch();
try {
  const c = client(origin);
  await c.call('/api/demo/speed', { speed: 0.35 });
  const context = await browser.newContext({ viewport: SIZE, colorScheme: 'light', recordVideo: { dir: videos, size: SIZE } });
  const page = await context.newPage();
  began = Date.now();
  await scenes(page, c, origin);
  await context.close();
  const [video] = (await readdir(videos)).filter((f) => f.endsWith('.webm'));
  await mkdir(OUT, { recursive: true });
  const gif = join(OUT, 'highlight.gif');
  toGif(join(videos, video), gif, join(videos, 'palette.png'));
  if (KEEP) await rename(join(videos, video), join(OUT, 'highlight.webm'));
  const seconds = cuts.reduce((n, [a, b]) => n + b - a, 0);
  console.log(`${gif}: ${seconds.toFixed(1)} s, ${((await stat(gif)).size / 1e6).toFixed(2)} MB`);
  await stills(browser, c, origin);
  console.log(
    `${Object.values(STILLS)
      .map((n) => join(OUT, n))
      .join(', ')}: the stills`,
  );
} finally {
  await browser.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(videos, { recursive: true, force: true });
}
