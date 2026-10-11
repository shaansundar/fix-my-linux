# Fix My Linux

A Linux desktop app for people who don't use the terminal. You describe the
problem ("my Wi-Fi keeps dropping", "my disk is full") and an AI assistant
runs the right commands for you. It explains each step in plain words and
asks before changing anything.

The agent is [opencode](https://opencode.ai) 1.19.0, bundled and run headless.
The UI is built from [Beautiful UI](https://www.beautifului.dev) components.
Model access goes through our backend to OpenCode Zen: a 5-day free trial on
Zen's free models, then $15/month for a curated list of paid models with an
$8/month usage budget.

## Repository

| Path | What it is |
|---|---|
| `apps/desktop` | Electron app (electron-vite, React 19, Tailwind v4) |
| `apps/desktop/src/main` | opencode supervisor, approval broker and safety policy, model relay, sudo askpass server, account |
| `apps/desktop/src/renderer/components/bui` | Vendored Beautiful UI components (MIT); `atoms/` are recreations of the site's internal atoms |
| `apps/desktop/resources` | Agent prompt, shell wrapper, sudo shim; `bin/` holds fetched opencode binaries (not committed) |
| `server` | Go backend: email sign-in, trial and subscription, catalog, metered Zen proxy, Lemon Squeezy billing |
| `tools/askpass` | `fml-askpass`, the helper sudo runs to get the password from the app |
| `scripts` | Fetch opencode, build askpass, re-vendor Beautiful UI |
| `.railway/railway.ts` | Railway infrastructure (API service and Postgres) |

## Development

Requirements: Node 22+ (24 recommended), pnpm 10, Go 1.26.

```bash
pnpm install
pnpm fetch:opencode --host      # opencode for this machine, checksum-verified
pnpm build:helpers --host       # fml-askpass for this machine
```

Run the app in one of these modes:

```bash
# Offline demo: a scripted assistant, no account, no key, no network.
FML_DEMO=1 pnpm dev

# Zen's free models with your own key, no backend.
FML_DEV_ZEN_KEY=sk-... pnpm dev

# Against a local backend (see below).
FML_API_BASE=http://127.0.0.1:8080 pnpm dev
```

macOS works for UI development. The commands, sudo and system checks are
Linux-only, so test those on Linux.

To run the backend locally without Postgres, Resend or Lemon Squeezy, use
memory mode. It keeps data in memory and logs sign-in codes instead of
emailing them:

```bash
cd server
FML_DEV_MEMORY=1 ZEN_API_KEY=... \
  CODE_SECRET=$(openssl rand -hex 32) MACHINE_HMAC_SECRET=$(openssl rand -hex 32) \
  go run ./cmd/api
```

The component gallery is at `#/gallery` in a dev build. It shows every
vendored component for side-by-side comparison with beautifului.dev.

## Tests

```bash
pnpm --filter @fml/desktop typecheck
pnpm --filter @fml/desktop test               # unit (Vitest)
pnpm --filter @fml/desktop test:integration   # against the real opencode binary
pnpm --filter @fml/desktop test:e2e           # Playwright + Electron, incl. the real Go server

cd server && go test -race -cover ./...       # Go; set FML_TEST_DATABASE_URL to include Postgres
```

`FML_RECORD=1` re-records the integration fixtures. `FML_SHOTS=<dir>` makes
the E2E suite save screenshots. CI (`.github/workflows/ci.yml`) runs
everything above. It also enforces at least 80% Go coverage and runs
staticcheck and gosec.

## How it stays safe

- **Nothing runs without a decision.** opencode asks before every command
  and file access. The broker in `src/main/safety` answers each request
  using a bash parser and per-program rules:
  - Read-only diagnostics run on their own.
  - Anything that changes the system shows an approval card with a plain
    explanation, a risk level and the exact command.
  - A small set of destructive patterns is always blocked.
- **The model's own words never decide anything.** Risk is scored from the
  real command or diff. Package commands show the package manager's dry run
  ("this also removes 40 packages") before you approve.
- **"Always allow" is never sent to opencode.** In opencode 1.19 it would
  override deny rules. "Allow similar" is remembered by the app for one
  chat, only for low/medium risk, and never for deletes, stops or writes.
- **Private files ask first:** SSH keys, browser profiles, keyrings,
  `/etc/shadow`, other users' homes, `/proc/*/environ` and the app's own
  data.
- **sudo** always uses the in-app password prompt, which names the exact
  command. The password goes straight to sudo's askpass helper. It is never
  logged, stored or shown to the model.
- **opencode is isolated.** It has private config and data directories,
  so it never touches your own opencode setup. It never sees the
  account token: model calls go through a loopback relay with a per-launch
  key.
- Every decision is written to a local activity log (the Activity screen).

## Packaging

```bash
cd apps/desktop
pnpm package                  # AppImage, deb, rpm for this architecture
pnpm package:flatpak          # Flatpak bundle (Linux, needs flatpak-builder)
```

Each package carries only its architecture's opencode and `fml-askpass`.
opencode 1.19 publishes identical x64 and baseline (no-AVX2) builds, so one
copy ships. A future release with a distinct baseline build would be shipped
automatically. The AppImage and .deb can be built on macOS; rpm and Flatpak
need Linux.

Pushing a `vX.Y.Z` tag that matches `apps/desktop/package.json` runs
`.github/workflows/release.yml`. It builds every format for x64 and arm64
into a draft GitHub release with checksums.

**Flatpak** builds are not sandboxed, by design: the app exists to run
commands on your computer.
- The shell wrapper runs each command on the host with
  `flatpak-spawn --host`. Commands start from the host session's
  environment.
- opencode's file tools only see the home folder, so outside it the agent
  is told to use shell commands instead.
- The askpass peer check is weaker here: host processes aren't visible
  from the sandbox, so it only checks that a sudo approval is active.
- Because of the host access this build can't go on Flathub. It ships
  from our own repository or as a bundle.

## Deploying the backend (Railway)

`.railway/railway.ts` defines the `api` service (built from
`server/Dockerfile`, health check `/healthz`) and its Postgres. Database
migrations run when the API starts.

```bash
railway login && railway link
railway config plan        # preview
railway config apply       # apply after confirming
```

Then connect the service to the GitHub repo (root directory `server`) or
deploy with `railway up` from `server/`. Set these variables on the service
first. Secret values stay in Railway; the config file keeps them with
`preserve()`.

| Variable | Value |
|---|---|
| `ZEN_API_KEY` | OpenCode Zen API key (ours, never shipped in the app) |
| `CODE_SECRET`, `MACHINE_HMAC_SECRET` | Random, at least 32 characters each: `openssl rand -hex 32` |
| `RESEND_API_KEY`, `MAIL_FROM` | Resend key, and a sender on a domain verified in Resend, e.g. `Fix My Linux <hello@fixmylinux.app>` |
| `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_ID` | The store and the $15/month subscription variant |
| `LEMONSQUEEZY_WEBHOOK_SECRET` | The signing secret of the webhook below |
| `CHECKOUT_REDIRECT_URL` | Where checkout lands afterwards (a "you can return to the app" page) |
| `DATABASE_URL` | Set automatically from the Postgres service |

Optional settings:
- `BUDGET_USD` (8), `TRIAL_DAYS` (5) and `TRIAL_DAILY_REQUESTS` (300).
- The paid model list: `PAID_MODELS`, `PAID_DEFAULT_MODEL`,
  `PAID_SMALL_MODEL` and `FREE_PREFERENCE`.
- `ZEN_BASE_URL` and `MODELS_URL`.

In Lemon Squeezy, add a webhook to `https://<api domain>/v1/webhooks/lemonsqueezy`
with the `subscription_*` events: created, updated, cancelled, resumed,
expired, paused, unpaused, payment_success, payment_failed and
payment_recovered.

The desktop app talks to `https://api.fixmylinux.app` by default. Point
that domain at the Railway service, or change `DEFAULT_API_BASE` in
`apps/desktop/src/main/mode.ts`.

## Before launch

- Confirm with OpenCode that reselling Zen access through a proxy is allowed.
  Zen's terms don't cover it.
- Get the Lemon Squeezy store approved (test mode works until then).
- Zen's free models may collect prompts to improve the model, and those
  prompts can include terminal output. The sign-in screen says so; keep
  that disclosure.
- Test on real distributions:
  - Ubuntu/Debian (.deb, AppImage) and Fedora (.rpm)
  - the Flatpak
  - sudo with the password prompt, an apt dry-run preview, and a few real
    fixes

## Licenses

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): Beautiful UI (MIT),
Lucide (ISC), Inter and JetBrains Mono (OFL), opencode (MIT), and others.
