// Text matched literally inside a regular expression built at run time (SECURITY.md, #344).

/** s with every character a regular expression gives a meaning escaped, so it matches only itself. */
export const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
