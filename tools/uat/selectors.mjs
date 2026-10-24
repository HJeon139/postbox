// How the UAT driver names things in the page. Moved out of tools/uat/driver.mjs, so its review module shares them.

export const J = JSON.stringify;
export const ITEM = (key) => `document.querySelector('[data-key=${J(key)}]')`;
