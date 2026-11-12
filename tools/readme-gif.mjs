// The README’s highlight GIF: about 30 seconds of what Postbox is best at, recorded from the demo’s mock agents, so it
// costs nothing and needs no agent accounts. It starts its own Postbox in demo mode on a port and a temporary data
// folder of its own, drives a light-theme page at 1280 × 800 with Playwright, records it, keeps only the moments
// that show something, and turns them into a GIF with ffmpeg’s two-pass palette (designs/developing.md, “Screenshots”).
//
//   node tools/readme-gif.mjs                      → screenshots/readme/highlight.gif
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
const GIF = { width: 960, fps: 10, colors: 96 };

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
  await box.pressSequentially(text, { delay: 28 });
  await box.press('Enter');
}

/** The room the GIF shows: @indexer, @researcher and @critic together in the demo’s Reading notes project. */
async function makeRoom(c) {
  const s = await c.state();
  const notes = c.thread(s, 'Corpus planning');
  const ids = ['indexer', 'researcher', 'critic'].map((h) => Object.values(s.personas).find((p) => p.handle === h).id);
  return c.call('/api/threads', { projectId: notes.projectId, title: 'Reading notes', personaIds: ids });
}

/** The scenes, each cut to the part worth seeing. */
async function scenes(page, c, origin) {
  const room = await makeRoom(c);
  const cites = c.thread(await c.state(), 'Citation fixes');
  // The Work view’s turn runs off camera, while the room works.
  await c.call(`/api/threads/${cites.id}/messages`, { text: 'Fix the citation script' });
  await page.goto(`${origin}/#/t/${room.id}`);
  await page.locator('#composer-input').waitFor();
  await keep(async () => {
    await say(page, '@indexer index the shelf');
    await say(page, '@researcher explain ReAct with something I can try');
    await say(page, '@critic review my corpus schema line by line');
    await sleep(2500);
    await say(page, '@indexer also drop the illustration captions');
    await sleep(6500);
  });
  await c.until((st) => c.idle(st, st.threads[room.id]) && st, { label: 'the room to finish', timeout: 90000 });
  // The critic’s review of an app it wrote, live in the conversation.
  await keep(async () => {
    await page
      .getByText('Explorer layout', { exact: true })
      .first()
      .evaluate((n) => n.scrollIntoView({ block: 'start' }));
    await sleep(7000);
  });
  await c.until((st) => c.idle(st, st.threads[cites.id]) && st, { label: 'the citation fix', timeout: 60000 });
  await page.goto(`${origin}/#/t/${cites.id}?work`);
  await keep(async () => {
    await page.locator('#wp-title').waitFor();
    await sleep(6000);
  });
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
  await c.call('/api/demo/speed', { speed: 0.5 });
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
} finally {
  await browser.close();
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(videos, { recursive: true, force: true });
}
