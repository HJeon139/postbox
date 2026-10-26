import assert from 'node:assert/strict';
import { test } from 'node:test';
import { orphans, parsePs, stopOrphans } from '../tools/orphans.mjs';

// Lines from `ps -axww -o pid=,ppid=,command=` on 25 October 2026, with the home folder replaced and long flags cut.
const T = '/var/folders/2c/62_ppcjn3k5clz05q35pm85w0000gn/T';
const PW = '/Users/you/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents';
const CHROME = '/Applications/Google Chrome.app/Contents';
const browser = (pid, ppid, profile) =>
  `${pid} ${ppid} ${PW}/MacOS/Google Chrome for Testing --disable-field-trial-config --headless --no-sandbox --user-data-dir=${T}/playwright_chromiumdev_profile-${profile} --remote-debugging-pipe --no-startup-window`;
const crashpad = (pid) =>
  `${pid} 1 ${PW}/Frameworks/Google Chrome for Testing Framework.framework/Versions/156.0.8078.4/Helpers/chrome_crashpad_handler --monitor-self-annotation=ptype=crashpad-handler --database=/Users/you/Library/Application Support/Google/Chrome for Testing/Crashpad`;
const LINES = {
  orphanBrowser: browser(3592, 1, 'HI5sNi'),
  liveBrowser: browser(25274, 25255, 'YYBMPs'),
  renderer: `3743 3592 ${PW}/Frameworks/Google Chrome for Testing Framework.framework/Versions/156.0.8078.4/Helpers/Google Chrome for Testing Helper (Renderer).app/Contents/MacOS/Google Chrome for Testing Helper (Renderer) --type=renderer --user-data-dir=${T}/playwright_chromiumdev_profile-HI5sNi`,
  cdpChrome: `23477 1 ${CHROME}/MacOS/Google Chrome --headless=new --remote-debugging-port=10997 --user-data-dir=${T}/pb-cdp-23425-10997 --no-first-run about:blank`,
  cdpHelper: `23481 23477 ${CHROME}/Frameworks/Google Chrome Framework.framework/Versions/156.0.8078.48/Helpers/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=gpu-process --user-data-dir=${T}/pb-cdp-23425-10997`,
  yourChrome: `501 1 ${CHROME}/MacOS/Google Chrome`,
  yourCrashpad: `502 1 ${CHROME}/Frameworks/Google Chrome Framework.framework/Versions/156.0.8078.48/Helpers/chrome_crashpad_handler --database=/Users/you/Library/Application Support/Google/Chrome/Crashpad`,
  uatServer: `53126 1 /Users/you/.local/share/mise/installs/node/22.13.0/bin/node /private/tmp/postbox-codex-144/server/index.mjs --port 18413 --data /private/tmp/postbox-codex-144/uat-runs/2026-10-23T01-14-02-codex/data`,
  installServer: `39857 1 node ${T}/pb-check-install-BbI2lZ/prefix/node_modules/.bin/postbox --port 30184`,
  yourPostbox: '700 1 node /Users/you/postbox/bin/postbox.mjs --port 4317',
  yourPostboxData: '701 1 node /Users/you/postbox/server/index.mjs --port 4400 --data /tmp/my-notes',
  moveData: '28217 1 /Users/you/.local/share/mise/shims/node bin/postbox.mjs --move-data',
  otherTool: '87712 1 /Users/you/.local/share/mise/installs/node/22.13.0/bin/node tools/bench-monitor/server.js --port 4320',
};
const procs = (...names) => parsePs(names.map((n) => LINES[n]).join('\n'));
const found = (...names) => orphans(procs(...names)).map((o) => `${o.kind} ${o.pid}`);

test('ps output parses into pid, parent and command, spaces in the command kept', () => {
  assert.deepEqual(parsePs(`  3592     1 ${PW}/MacOS/Google Chrome for Testing --headless\n\n`), [
    { pid: 3592, ppid: 1, command: `${PW}/MacOS/Google Chrome for Testing --headless` },
  ]);
});

test('an orphaned Playwright browser and CDP Chrome are stopped; their helpers go with them', () => {
  assert.deepEqual(found('orphanBrowser', 'renderer', 'cdpChrome', 'cdpHelper'), ['playwright-browser 3592', 'cdp-chrome 23477']);
});

test('a browser whose run is still going is left alone', () => {
  assert.deepEqual(found('liveBrowser'), []);
});

test('your own Chrome and its crash handler never match, though their parent is launchd too', () => {
  assert.deepEqual(found('yourChrome', 'yourCrashpad'), []);
});

test('a Playwright crash handler is stopped only once no Playwright browser is left running', () => {
  const withHandler = (...names) => orphans([...procs(...names), ...parsePs(crashpad(3632))]).map((o) => `${o.kind} ${o.pid}`);
  // A live run’s browser may own it: kept.
  assert.deepEqual(withHandler('orphanBrowser', 'liveBrowser'), ['playwright-browser 3592']);
  // Only orphans: it goes with them.
  assert.deepEqual(withHandler('orphanBrowser'), ['playwright-browser 3592', 'playwright-crashpad 3632']);
});

test('a test tool’s orphaned Postbox is stopped: a UAT run’s, or one installed in our temp folder', () => {
  assert.deepEqual(found('uatServer', 'installServer'), ['postbox-server 53126', 'postbox-server 39857']);
});

test('your own Postbox, a stuck --move-data and another tool’s server are left alone', () => {
  assert.deepEqual(found('yourPostbox', 'yourPostboxData', 'moveData', 'otherTool'), []);
});

test('stopping sends SIGTERM to each, goes on past one already gone, and says what it stopped', async () => {
  /** @type {[number, string][]} */
  const sent = [];
  const lines = [];
  const stopped = await stopOrphans({
    list: async () => procs('orphanBrowser', 'cdpChrome', 'liveBrowser', 'yourChrome'),
    kill: (pid, signal) => {
      sent.push([pid, signal]);
      if (pid === 23477) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    },
    log: (line) => lines.push(line),
  });
  assert.deepEqual(sent, [
    [3592, 'SIGTERM'],
    [23477, 'SIGTERM'],
  ]);
  assert.deepEqual(
    stopped.map((o) => o.pid),
    [3592],
  );
  assert.match(lines.join('\n'), /^Stopped what an earlier run left behind: 1 playwright-browser \(pids 3592\)\.$/);
});

test('a ps that fails stops nothing', async () => {
  const sent = [];
  assert.deepEqual(await stopOrphans({ list: async () => Promise.reject(new Error('no ps')), kill: (pid) => sent.push(pid) }), []);
  assert.deepEqual(sent, []);
});
