// Saving an app is separate from its browser check; receipts and reads name the current version (#337).

/** @param {any} app */
export function appCheckStatus(app) {
  return {
    version: app.current,
    status: app.check?.status ?? 'pending',
    problems: (app.check?.problems ?? []).map(({ code, message }) => ({ code, message })),
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
