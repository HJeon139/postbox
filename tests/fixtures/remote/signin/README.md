# Sign-in status fixtures (#1608)

What each harness’s own status command printed, for `server/remote/host/harness-signin.mjs` and its tests. Each `*.json` file holds one run: the date, the CLI’s version, the command, how it was configured, its exit code, and its stdout and stderr.
- Recorded on 27 November 2026 on macOS with Claude Code 2.1.318, codex-cli 0.167.0 and kiro-cli 3.6.2, run with no stdin.
- `*-signed-in.json`: each command as the recording computer was signed in.
- `*-signed-out.json`: the same command against an empty config folder, which is how a sign-out looks without touching the real sign-in: `CLAUDE_CONFIG_DIR` for Claude Code, `CODEX_HOME` for Codex, and `HOME` for Kiro.
- Scrubbed before they were saved: the email is the fixture person’s (`robin@example.com`, from `tools/fixture-person.mjs`), the home folder is `/home/someone`, the empty folders are `/home/someone/.empty/…`, the organization ID is a zero UUID, the organization name is “Robin Example’s Organization”, and Kiro’s start URL is `https://example.awsapps.com/start`. Nothing else was changed.
- `signins-before-1608.json`: what a daemon from before `signins` answers it, recorded from main’s daemon at a7eacc5b9 in-process (`tests/remote-daemon-setup.mjs`), sent the line `{"type":"signins"}`.
- Checked again before they were committed: each command was run once more the same way, scrubbed the same way, and matched these files’ exit codes, stdout and stderr exactly, and none of the recording computer’s real email, organization, start URL or home folder appears in any file. `signins-before-1608.json` matched what the daemon at 5bf5e1148 (main’s daemon, unchanged) answered to the same line.
