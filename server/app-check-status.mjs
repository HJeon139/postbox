// Saving an app is separate from its browser check; receipts and reads name the current version (#337).

/** What the agent hears of a check: its problems, and the hints only it is told (#952). @param {any} app */
export function appCheckStatus(app) {
  const found = [...(app.check?.problems ?? []), ...(app.check?.hints ?? [])];
  return {
    version: app.current,
    status: app.check?.status ?? 'pending',
    problems: found.map(({ code, message }) => ({ code, message })),
  };
}

/** A save receipt never waits for a browser to open the conversation. @param {any} app @param {string} message */
export function appReceipt(app, message) {
  const check = appCheckStatus(app);
  return {
    ok: true,
    appId: app.id,
    itemId: app.itemId,
    version: app.current,
    check,
    message: `${message} Saved v${app.current}; browser check: ${check.status}. This does not confirm a rendered result.`,
  };
}

/** @param {any} app */
export function appCheckText(app) {
  const check = appCheckStatus(app);
  const problems = check.problems.map((p) => `- ${p.code}: ${p.message}`).join('\n');
  return `App ${app.id}, v${check.version}. Browser check: ${check.status}.${app.retired ? ' This app is retired.' : ''}${problems ? `\n${problems}` : ''}`;
}

/** The head line for a version that isn't the current one: Postbox records a check only for that (#516's S1). @param {any} app @param {number} v */
export function appVersionText(app, v) {
  return `App ${app.id}, v${v}; v${app.current} is the current version. v${v}’s browser check isn’t kept: Postbox records one only for the current version.${app.retired ? ' This app is retired.' : ''}`;
}
