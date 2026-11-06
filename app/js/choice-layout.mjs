// A choice uses pills while each option fits on one line at the block’s width, and full-width panels when any option
// would wrap (#673). One observer follows every live choice as its block or window changes width.

const fitter = new ResizeObserver((entries, observer) => {
  for (const { target } of entries) fit(target, observer);
});

function fit(options, observer) {
  if (!options.isConnected) {
    observer.unobserve(options);
    return;
  }
  options.classList.remove('panels');
  options.classList.add('measuring');
  const width = options.clientWidth;
  // An option with a description under its label is a panel too (#838).
  const wraps = !!options.querySelector('.chip-desc') || [...options.querySelectorAll('.chip')].some((option) => option.getBoundingClientRect().width > width);
  options.classList.remove('measuring');
  options.classList.toggle('panels', wraps);
}

/** Observe a choice’s options once they are on the page, and return them for DOM construction. */
export function fitChoiceOptions(options) {
  fitter.observe(options);
  return options;
}
