// A choice uses pills while each option fits on one line at the block’s width, and full-width panels when any option
// would wrap (#673). One observer follows every live choice as its block or window changes width.

function fit(options) {
  if (!options.isConnected) return void fitter.unobserve(options);
  options.classList.remove('panels');
  options.classList.add('measuring');
  const width = options.clientWidth;
  const wraps = [...options.querySelectorAll('.chip')].some((option) => option.getBoundingClientRect().width > width);
  options.classList.remove('measuring');
  options.classList.toggle('panels', wraps);
}

const fitter = new ResizeObserver((entries) => {
  for (const { target } of entries) fit(target);
});

/** Observe a choice’s options once they are on the page, and return them for DOM construction. */
export function fitChoiceOptions(options) {
  fitter.observe(options);
  return options;
}
