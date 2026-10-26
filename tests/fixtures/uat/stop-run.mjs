// A host-mode UAT run cut down to its start, for tests/process/uat-stop.test.mjs: the run’s own Postbox and Chromium,
// its stop on a signal (tools/uat/stop.mjs) wired as tools/uat-run.mjs wires it, and one host set up through the UI
// (added, its folder made, installed) over whatever `ssh` is first on PATH. Then it prints “ready” and waits for the
// signal.
//
//   node tests/fixtures/uat/stop-run.mjs <port> <data folder> <workspace> <host’s home>

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../../tools/browser.mjs';
import { driver } from '../../../tools/uat/driver.mjs';
import { followEvents } from '../../../tools/uat/history.mjs';
import { createHostRun, setUp } from '../../../tools/uat/hosts-run.mjs';
import { startPostbox } from '../../../tools/uat/postbox.mjs';
import { onStopSignal, runStop } from '../../../tools/uat/stop.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const [port, data, workspace, home] = process.argv.slice(2);
const log = (/** @type {string} */ line) => console.log(line);
const run = { log };
onStopSignal(runStop(run), { log });
const postbox = await startPostbox({ root: ROOT, port: Number(port), data, env: { POSTBOX_BACKENDS: 'mock' }, log: () => {} });
const history = followEvents(postbox.origin);
const page = await launch({ detached: true });
const hosts = [{ label: 'host1', destination: 'host.example.com', settings: {} }];
const hr = createHostRun({ hosts, placement: {}, launcher: null, root: ROOT, stamp: 'stop-check', data, log });
Object.assign(run, { hr, history, page, postbox });
await page.size(1280, 900);
await page.goto(`${postbox.origin}/`);
const d = driver(page);
await d.newProject('Stop check', workspace);
Object.assign(hr, { postbox, api: postbox.api, kit: d.kit });
// What baseline() would read over ssh; its measurements need Linux’s ps and ss, which tests/integration covers.
hr.hosts[0].home = home;
const project = Object.values((await postbox.api('/api/state')).state.projects).find((p) => p.name === 'Stop check');
await setUp(hr, project.id);
log('ready');
setInterval(() => {}, 1000);
