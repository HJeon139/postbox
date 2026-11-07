// A choice uses pills while each option fits on one line at the block’s width, and full-width panels when any option
// would wrap (#673). One observer follows every live choice as its block or window changes width.
//
// The observer measures every choice it’s called for in one pass: it sets each one up to be measured, then reads them
// all, then writes the results. A read between two writes forces a layout of the whole page, so measuring them one at
// a time cost a layout per choice: in a room with many choices, a switch into it grew with choices × items (#866).

const fitter = new ResizeObserver((entries, observer) => {
  const live = [];
  for (const { target } of entries) {
    if (target.isConnected) live.push(target);
    else observer.unobserve(target);
  }
  for (const options of live) startMeasuring(options);
  const wrapped = live.map(wraps);
  for (let i = 0; i < live.length; i++) finishMeasuring(live[i], wrapped[i]);
});

/** Lays the options out as pills, unwrapped, so their widths can be read. @param {Element} options */
function startMeasuring(options) {
  options.classList.remove('panels');
  options.classList.add('measuring');
}

/** Whether any option would wrap at the block’s width; reads only. @param {Element} options */
function wraps(options) {
  // An option with a description under its label is a panel too (#838).
  if (options.querySelector('.chip-desc')) return true;
  const width = options.clientWidth;
  return [...options.querySelectorAll('.chip')].some((option) => option.getBoundingClientRect().width > width);
}

/** @param {Element} options @param {boolean} wrapped */
function finishMeasuring(options, wrapped) {
  options.classList.remove('measuring');
  options.classList.toggle('panels', wrapped);
}

/** Observe a choice’s options once they are on the page, and return them for DOM construction. */
export function fitChoiceOptions(options) {
  fitter.observe(options);
  return options;
}
