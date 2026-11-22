// UAT recording mode, which the UAT runner turns on with POSTBOX_UAT_RECORD=1 (tools/uat/run-env.mjs): what only a
// UAT run’s record reads is kept then, and in no other room (#1527, #1528). Each user reads it once, when it’s built,
// never per event.

/** Whether this Postbox runs in UAT recording mode. @param {Record<string, string | undefined>} [env] */
export const uatRecording = (env = process.env) => env.POSTBOX_UAT_RECORD === '1';
