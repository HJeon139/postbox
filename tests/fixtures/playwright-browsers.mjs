// Where Playwright keeps its browsers on this computer: PLAYWRIGHT_BROWSERS_PATH, else its own default per platform.
// view_app’s tests point AppBrowser (server/view-app/browser.mjs) here, at the headless shell `npx playwright install
// chromium` already put there for the specs, so no test downloads one into Postbox’s own data folder.

import { homedir } from 'node:os';
import { join } from 'node:path';

export function playwrightBrowsers() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright');
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright');
}
