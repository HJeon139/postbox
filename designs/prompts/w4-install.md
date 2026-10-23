# Prompt: wave 4, install (#157, #90)

A wave 4 session, integrated by the reviewing session. Follow [README.md](README.md) for the rules every session shares. Your ports are 4750–4799 for servers and 9950–9999 for Chrome.

---

You’re making Postbox installable as an npm package with the person’s data outside it, on the branch `feat/w4-install`, in one pull request with one commit per issue (#90 first, since #157 depends on it).

## Why

Both are release blockers (the person’s decision, 22 October 2026).
- **#157:** Postbox runs only from a git clone. An installed package has no command to run (`package.json` has no `bin`). It would also keep the person’s conversations inside the package, where an upgrade or an uninstall deletes them.
- **#90:**
  - **The data folder:** it defaults to `ROOT/data` (`server/index.mjs`).
  - **Media an agent adds:** it lands in the source tree. `/media/` is served from `app/media`, the only folder an app’s sandbox can load images from. On 22 October an agent copied 23 video frames into `app/media/`, and another agent deleted them, which broke the first agent’s app.
- **The decided split** (on #47 and #90, 23 October 2026):
  - **Per project:** Postbox’s data for a project goes under `<project>/.postbox/` (datasets already do, from #173).
  - **The person’s own:** settings, data and media go under `~/.postbox`.

## Read first

- [README.md](README.md), `designs/intent.md` (Who it’s for) and `designs/architecture.md` on storage.
- Both issues and their comments, which list every place that writes user data and the build line’s dependence on git.

## The work

- **#90:**
  - The data folder defaults to `~/.postbox` (`POSTBOX_HOME` overrides; `--data` still wins).
  - Media an agent adds goes to `~/.postbox/media/`, served at `/media/` beside the bundled `app/media/`, with the sandbox’s `img-src` unchanged.
  - **Migration:** a clone with an existing `data/` keeps working. Say on startup where the data is. Never move or delete the person’s files without asking: offer the move, and keep using `data/` until they accept.
- **#157:**
  - A `bin` entry (`postbox`, with `--port`, `--data` and `--help`) and a `files` list that ships what runs and nothing of `data/`, `uat-runs/` or the tests.
  - The build line reads the version from `package.json` and the commit from a file written at pack time, falling back to git in a clone.
  - `npm pack`, installed into a temp prefix, starts, serves the page and writes only under `~/.postbox` (point `HOME` at a temp folder for the test).

## Files

- **Yours:** `package.json`; the startup, paths and static serving in `server/index.mjs` (not its API routes); `server/build-info.mjs`; a new `bin/postbox.mjs`; `server/sandbox.mjs`’s media path only if it must change; the README’s install section.
- **Shared:**
  - **`server/index.mjs`:** the blocks session changes its CSP line (#180). Leave the `content-security-policy` header to them, and rebase if both land.

## Done when

- A test installs the packed tarball into a temp prefix with a temp `HOME`, runs `postbox --port <yours>`, loads `/` and confirms nothing was written outside `HOME/.postbox`.
- A clone with `data/` starts on it, and says so.
- The release workflow still releases (`tools/release.mjs --check`), and the build line shows the version and commit in an installed copy.
