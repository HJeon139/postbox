// The environment a backend conformance check runs a CLI in (#585): an allowlist, never a copy of this process’s.
// A probe must not reach the person’s sign-in, so nothing that names a key or a token passes through, and HOME is a
// temp folder, so the CLI reads none of the person’s own config.

/** The placeholder Codex sends as its bearer token to the fake model endpoint: not a credential. */
export const PLACEHOLDER = 'postbox-conformance-placeholder';
/** The variable Codex reads it from (the fake provider’s env_key). Its name holds neither KEY nor TOKEN. */
export const PLACEHOLDER_VAR = 'POSTBOX_CONFORMANCE_PLACEHOLDER';

// A name that looks like a secret’s. The placeholder’s own variable is the one exception, and holds no secret.
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH/i;

/**
 * The environment for a CLI under check: PATH from `from`, HOME and CODEX_HOME set to the probe’s temp folders, and
 * with `placeholder`, the fake provider’s placeholder. Nothing else from `from` passes, whatever it holds.
 * @param {{ from?: NodeJS.ProcessEnv, home: string, codexHome?: string, placeholder?: boolean }} opts
 * @returns {Record<string, string>}
 */
export function sandboxEnv({ from = process.env, home, codexHome, placeholder = false }) {
  if (!home) throw new Error('A conformance probe needs a temp HOME: it never runs a CLI in the real one.');
  const env = { PATH: String(from.PATH ?? ''), HOME: home };
  if (codexHome) env.CODEX_HOME = codexHome;
  if (placeholder) env[PLACEHOLDER_VAR] = PLACEHOLDER;
  refuseSecretNames(env); // a backstop: the allowlist above already lets no such name through
  return env;
}

/**
 * Throws when an environment names a key or a token, or when the placeholder’s variable holds anything but the
 * placeholder.
 * @param {Record<string, string>} env
 */
export function refuseSecretNames(env) {
  for (const [name, value] of Object.entries(env)) {
    if (name === PLACEHOLDER_VAR && value !== PLACEHOLDER) throw new Error(`A conformance probe’s ${name} can hold only the placeholder.`);
    if (name !== PLACEHOLDER_VAR && SECRET_NAME.test(name)) throw new Error(`A conformance probe’s environment can’t carry ${name}: it names a secret.`);
  }
}
