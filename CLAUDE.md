# Fix My Linux: notes for Claude Code

Start with the README: setup, tests, and **What's pending** (the checklist
of what's left, in order). `docs/PLAN.md` is the approved design plan.

## Settled product decisions (don't re-ask)

- Electron app; opencode 1.19.0 is bundled and spawned by the app, isolated from any user install.
- 5-day free trial on Zen's free models, then $15/month for a curated list of paid Zen models, capped at $8/month of upstream cost per user. No top-ups in v1.
- All model traffic goes through our Go backend on Railway, which proxies to OpenCode Zen. The Zen key never ships in the app.
- Sign-in by emailed one-time code (Resend). Billing by Lemon Squeezy.
- Tiered safety: read-only commands run on their own, changes need approval, catastrophic patterns are blocked. sudo uses an in-app password prompt.
- UI from beautifului.dev components only; gaps are composed from their parts; icons are Lucide.
- Packages: AppImage, .deb, .rpm and Flatpak, for x64 and arm64.
- Name "Fix My Linux", app id `dev.fixmylinux.app`. English only. No conversation content stored on the server. Sessions start in `$HOME`.

## Conventions

- Commits: `<type>: <description>` (feat, fix, refactor, docs, test, chore, perf, ci).
- Write the tests first. Run the relevant suites before committing (README, Tests).
- Go: gofmt, wrap errors with `fmt.Errorf("...: %w", err)`, small interfaces defined where they're used, table-driven tests, `go test -race`, at least 80% coverage (CI enforces it), gosec and staticcheck clean, `context.WithTimeout` on outgoing calls.
- Ask before anything outward-facing: deploying, setting Railway variables, Lemon Squeezy or Resend setup, pushing tags or publishing releases.
- Never commit secrets. Railway secrets stay in Railway and are kept in `.railway/railway.ts` with `preserve()`.

## Safety invariants

- Never reply `"always"` to an opencode permission request. In 1.19 it overrides deny rules. "Allow similar" lives in the app's broker.
- Risk is scored from the real command or diff, never from the model's text.
- Upgrading opencode: update `OPENCODE_VERSION` and `PINNED_INTEGRITY` in `scripts/fetch-opencode.ts`, then re-run the integration tests. They check the permission decisions against the real binary.
