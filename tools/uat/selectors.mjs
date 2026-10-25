// How the UAT driver names things in the page. Moved out of tools/uat/driver.mjs, so its review module shares them.

import { js } from '../cdp.mjs';

export const ITEM = (key) => `document.querySelector('[data-key=${js(key)}]')`;
