// Whether the transcript window (window.mjs, #866) is on in this browser.
//
//   localStorage.setItem('pb-window', 'off')    turns it off in this browser

const FLAG = 'pb-window';

/**
 * Whether the window is on in this browser: by default, the person’s choice of 8 Nov (#866). The flag set to 'off'
 * mounts every item, as before; a conversation within both the ceiling of items and the budget of elements mounts
 * whole either way (createWindow).
 */
export function windowOn() {
  try {
    return localStorage.getItem(FLAG) !== 'off';
  } catch {
    return true;
  }
}
