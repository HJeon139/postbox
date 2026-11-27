# Sign-in status fixtures (#1608)

What each harness’s own status command printed, for `server/remote/host/harness-signin.mjs` and its tests. Each `*.json` file holds one run: the date, the CLI’s version, the command, how it was configured, its exit code, and its stdout and stderr.
- Recorded on 27 November 2026 on macOS with Claude Code 2.1.318, codex-cli 0.167.0 and kiro-cli 3.6.2, run with no stdin.
- `*-signed-in.json`: each command as the recording computer was signed in.
- `*-signed-out.json`: the same command against an empty config folder, which is how a sign-out looks without touching the real sign-in: `CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex, and `HOME` for Kiro.
- Scrubbed before they were saved: the email is the fixture person’s (`robin@example.com`, from `tools/fixture-person.mjs`), the home folder is `/home/someone`, the empty folders are `/home/someone/.empty/…`, the organization ID is a zero UUID, the organization name is “Robin Example’s Organization”, and Kiro’s start URL is `https://example.awsapps.com/start`. In `claude-signed-in.json`, `subscriptionType` and `loginExpiresAt` are made up too (`pro` and `2026-12-01T00:00:00.000Z`), since the recorded ones were a real account’s. Nothing else was changed.
- `signins-before-1608.json`: what a daemon from before `signins` answers it, recorded from main’s daemon at a7eacc5b9 in-process (`tests/remote-daemon-setup.mjs`), sent the line `{"type":"signins"}`.
- Checked again before they were committed: each command was run once more the same way, scrubbed the same way, and matched these files’ exit codes, stdout and stderr exactly, and none of the recording computer’s real email, organization, start URL or home folder appears in any file. `signins-before-1608.json` matched what the daemon at 5bf5e1148 (main’s daemon, unchanged) answered to the same line.
- Since its two made-up values, `claude-signed-in.json` no longer matches a fresh run in those two fields.

## Do the status commands write?

Measured on 27 November 2026 on macOS with the same versions, without reading any credential: the modification time and size of each CLI’s stored-credential files, and the modification date of its keychain items (attributes only), before and after three runs of each status command in a row.
- `claude auth status`: `~/.claude.json` and the keychain item “Claude Code-credentials” (macOS keeps no `~/.claude/.credentials.json`). Neither changed.
- `codex login status`: `~/.codex/auth.json`. It didn’t change.
- `kiro-cli whoami --format json`: `~/Library/Application Support/kiro-cli/data.sqlite3`, and the keychain items “kirocli:odic:token” and “kirocli:odic:device-registration”. `data.sqlite3`’s modification time moved on the first run (its size didn’t), and a fourth run after them didn’t move it. The keychain items didn’t change.
- `data.sqlite3` holds Kiro’s sign-in token (its `auth_kv` table has the keys `kirocli:odic:token` and `kirocli:odic:device-registration`) beside telemetry state. Which row the run wrote wasn’t checked, since that means reading the values.
- kiro-cli’s binary carries the strings “token is expired, refreshing”, “Refreshing access token” and “secret store changed during refresh; not persisting stale builder id token”, and Kiro keeps a `.refresh.lock` beside the database: loading the token refreshes it when it has expired, under a lock of its own.
- Claude Code wasn’t measured near its token’s expiry, so whether `auth status` refreshes a token about to run out is still open.
