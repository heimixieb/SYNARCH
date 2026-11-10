# SYNARCH working notes

SYNARCH is a fork of OpenMausBot (`upstream` = github.com/milind-soni/OpenMausBot) turned into a DeepSeek-style
Super-agent: the person talks only to the Chief, the Chief runs every model and asks the person only for decisions
and sign-off. Work happens on branch `synarch/main`, based on tag v0.1.151. Also follow `AGENTS.md`; the plan and
its progress live in `docs/synarch/` (`02-roadmap.md` is the source of truth for what is done and what is next).
Setting up another computer: `docs/synarch/00-new-computer.md`.

## The person

- Always answer in Chinese, in plain words: they are not a programmer and read no English. Translate English
  buttons and errors.
- Decide every technical matter yourself and keep working; ask only what is theirs to decide: accounts, money,
  permissions, anything public or hard to undo.
- Say in a sentence or two what you are about to change. After each feature that works, commit it (they asked for
  commits as checkpoints) and tell them.
- Preferred model for SYNARCH work and real-model tests: DeepSeek V4.1-Flash (`deepseek-official/deepseek-flash`).

## Safety

- Never touch the released app's data in `~/.openmausbot`; verify only in temporary data dirs.
- The DeepSeek key lives in `%USERPROFILE%\.synarch\deepseek.env` (`DEEPSEEK_API_KEY=...`). Never copy it into the
  repo, a user-level environment variable (the released app reads `OMB_DEEPSEEK_API_KEY`) or chat.
- Upstream first: generic fixes may go back to upstream as PRs, but opening one is public: ask first.

## Verifying

- Fake engine: `node --experimental-strip-types scripts/control-omb.ts launch` (prints url, pid, dataDir), then
  `scripts/control-omb.ts <verb> --url URL`. It seals PATH, so it never sees real engine CLIs.
- Real DeepSeek: `node --experimental-strip-types scripts/synarch/launch-deepseek.ts` (needs `dsh` and the key file).
  After stopping it, kill the printed pid tree and delete the printed dataDir: it holds a copy of the key.
- GitHub and npm are slow and drop connections from here. A local proxy runs at `127.0.0.1:7688` (HTTP and SOCKS5;
  the port may differ on another computer). Route one git command through it without changing config:
  `GIT_SSH_COMMAND="ssh -o ProxyCommand='connect -S 127.0.0.1:7688 %h %p'" git push`.
- Git Bash `curl` mangles Chinese request bodies: send them from `python -I` scripts as UTF-8.
- Goals over HTTP: `POST /api/bots/:id/messages {text, mode: "goal", threadId}`; read `GET /api/threads/:id/messages`.
- Stopping a fixture through a task stop leaves its `%TEMP%\openmausbot-verify-*` dir: delete only the one it printed.

## Tests

- Never run the whole suite locally (about 25k tests, hours). Run the files `git grep` shows importing what you
  changed, with `OMB_VITEST_WORKERS=4`, plus `pnpm typecheck` and `pnpm exec oxlint <files>`.
- `scripts/testing/file-size-ratchet.test.ts` forbids listed big files (`server/index.ts`, `server/store.ts`, ...)
  from growing: put new logic in new files and wire it in on existing lines.
- Agent tool descriptions are snapshotted: rerun the two `server/drivers/agents-*-wire.test.ts` files with
  `UPDATE_AGENTS_CATALOG_GOLDENS=1` and review the diff.
- New UI strings: add to `src/locales/en.json` and `zh.json`, then `node scripts/generate-locale.mjs --record-hashes`
  (slow, reads git history) and `--check`.
- Known upstream failures on Windows (also on untouched v0.1.151): two "setup answers" tests in
  `server/index.test.ts`, the locale-format test in `src/components/SidebarThreadRow.test.ts`, and the timezone test
  "turns a paused schedule back on" in `server/routines.test.ts` (full-file run).
