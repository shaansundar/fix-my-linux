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

**Status (2026-10-12):** version 0.1.0. All seven build phases are done and
tested on macOS (375 unit, 26 integration and 11 end-to-end tests). It has
not run on real Linux yet, the backend isn't deployed, and nothing is
released. [What's pending](#whats-pending) lists what's left, in order.

## Contents

- [Repository](#repository)
- [Install](#install)
- [Set up a Linux machine (VPS)](#set-up-a-linux-machine-vps)
- [Development](#development)
- [Tests](#tests)
- [How it stays safe](#how-it-stays-safe)
- [Packaging](#packaging)
- [Deploying the backend (Railway)](#deploying-the-backend-railway)
- [What's pending](#whats-pending)
- [Licenses](#licenses)

## Repository

| Path | What it is |
|---|---|
| `apps/desktop` | Electron app (electron-vite, React 19, Tailwind v4) |
| `apps/desktop/src/main` | opencode supervisor, approval broker and safety policy, model relay, sudo askpass server, account |
| `apps/desktop/src/renderer/components/bui` | Vendored Beautiful UI components (MIT); `atoms/` are recreations of the site's internal atoms |
| `apps/desktop/resources` | Agent prompt, shell wrapper, sudo shim; `bin/` holds fetched opencode binaries (not committed) |
| `apps/desktop/flatpak` | Flatpak manifest, launcher, desktop file, metainfo and build script |
| `server` | Go backend: email sign-in, trial and subscription, catalog, metered Zen proxy, Lemon Squeezy billing |
| `tools/askpass` | `fml-askpass`, the helper sudo runs to get the password from the app |
| `scripts` | Fetch opencode, build askpass, re-vendor Beautiful UI |
| `.railway/railway.ts` | Railway infrastructure (API service and Postgres) |
| `docs/PLAN.md` | The approved design plan and product decisions |

## Install

Packages will come from GitHub Releases. None is published yet, so for now
build them yourself (see [Packaging](#packaging)). The commands below use
version 0.1.0 on x64; on arm64 the files end in `arm64.deb`,
`aarch64.rpm`, `aarch64.flatpak` and `arm64.AppImage`.

| System | Package | Install |
|---|---|---|
| Ubuntu, Debian, Mint, Pop!_OS | `.deb` | `sudo apt install ./fix-my-linux_0.1.0_amd64.deb` |
| Fedora, RHEL and relatives | `.rpm` | `sudo dnf install ./fix-my-linux-0.1.0.x86_64.rpm` |
| Any system with Flatpak | `.flatpak` | `flatpak install --user ./fix-my-linux-0.1.0-x86_64.flatpak` |
| Any (not Ubuntu 24.04+, see below) | AppImage | `chmod +x fix-my-linux-0.1.0-x86_64.AppImage`, then run it |

Open **Fix My Linux** from the app menu, or run `fix-my-linux` (.deb and
.rpm) or `flatpak run dev.fixmylinux.app`.

- **Use a normal user account, not root.** Electron refuses to start as
  root. The account should be able to use sudo.
- **On Ubuntu 24.04 and newer, use the .deb or the Flatpak.** The AppImage
  will probably refuse to start there (see [Packaging](#packaging)).
- **Signing in needs the backend,** which isn't deployed yet. Until then,
  run the app in a mode that doesn't need an account:

  ```bash
  FML_DEMO=1 fix-my-linux                        # scripted demo, offline, no key
  FML_DEV_ZEN_KEY=sk-... fix-my-linux            # the real agent on Zen's free models, with your own Zen key
  FML_API_BASE=http://127.0.0.1:8080 fix-my-linux    # a backend you run yourself (see Development)
  flatpak run --env=FML_DEMO=1 dev.fixmylinux.app    # the same for the Flatpak
  ```

To uninstall, run `sudo apt remove fix-my-linux`, `sudo dnf remove
fix-my-linux` or `flatpak uninstall dev.fixmylinux.app`, or delete the
AppImage. Settings, the sign-in token and the activity log are in
`~/.config/Fix My Linux` (Flatpak: `~/.var/app/dev.fixmylinux.app`).

## Set up a Linux machine (VPS)

How to continue development and testing on a Linux server. Written for
Ubuntu 24.04; Fedora differences are noted.

### 1. A user that sudo asks for a password

Electron won't run as root. The in-app sudo prompt only appears when sudo
actually asks for a password, and cloud images often give their default
user passwordless sudo. Create a test user:

```bash
sudo adduser fml                    # choose a password
sudo usermod -aG sudo fml           # Fedora: sudo useradd -m -G wheel fml && sudo passwd fml
sudo -l -U fml | grep -i nopasswd   # should print nothing
```

Log in as `fml` for every step below.

### 2. Tools

```bash
sudo apt update
sudo apt install -y git curl rpm flatpak flatpak-builder \
  xvfb x11vnc xfce4 xfce4-terminal dbus-x11 gnome-keyring
flatpak remote-add --user --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
```

- **Node 24:** from [nodejs.org](https://nodejs.org/en/download) or nvm.
  Then run `corepack enable`. It provides the pnpm version pinned in
  `package.json`.
- **Go 1.26 or newer:** from [go.dev/dl](https://go.dev/dl/). Extract it
  with `sudo tar -C /usr/local -xzf go1.26.*.linux-amd64.tar.gz` and add
  `/usr/local/go/bin` to `PATH`.
- **GitHub access:** the repository is private. Run `gh auth login`, or add
  this user's SSH key to your GitHub account.

### 3. Clone and build

```bash
git clone git@github.com:shaansundar/fix-my-linux.git
cd fix-my-linux
pnpm install
pnpm fetch:opencode     # every Linux build of opencode, checked against pinned checksums
pnpm build:helpers      # fml-askpass for x64 and arm64
pnpm --filter @fml/desktop exec playwright install-deps chromium   # Electron's system libraries (asks for sudo)
```

Then run the [tests](#tests). The Go and unit tests run as they are. The
E2E tests and `pnpm dev` need two more things:

- **A display.** Use `xvfb-run -a` for tests, or the VNC desktop in step 4.
- **Chromium's sandbox.** Ubuntu 24.04 blocks the unprivileged user
  namespaces that the development Electron in `node_modules` uses for its
  sandbox. CI turns that restriction off; do the same while you work:

  ```bash
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0   # allow
  sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1   # restore (the default)
  ```

  Restore the default before you test the installed packages, especially
  the AppImage. Otherwise you'll test a setting real users don't have.

### 4. See the app (VNC through SSH)

On the VPS, as `fml`, start a desktop on display `:1` and share it only on
localhost:

```bash
Xvfb :1 -screen 0 1440x900x24 &
DISPLAY=:1 startxfce4 &
x11vnc -storepasswd                  # once: sets the VNC password
x11vnc -display :1 -localhost -rfbauth ~/.vnc/passwd -rfbport 5900 -forever &
```

On your Mac, open a tunnel and connect with the built-in Screen Sharing:

```bash
ssh -L 5900:localhost:5900 fml@<vps-address>
open vnc://localhost:5900
```

In a terminal inside that desktop, run `pnpm dev` (with one of the modes
under [Development](#development)) or launch an installed package. The full
desktop matters for real testing: it provides the keyring for the sign-in
token and a normal session environment.

## Development

Requirements: Node 22+ (24 recommended), pnpm 10, Go 1.26.

```bash
pnpm install
pnpm fetch:opencode --host      # opencode for this machine, checked against pinned checksums
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

The component gallery shows every vendored component, for side-by-side
comparison with beautifului.dev. It only exists in a dev build: in the
`pnpm dev` window, open DevTools (Ctrl+Shift+I) and run
`location.hash = "#/gallery"`.

## Tests

```bash
pnpm --filter @fml/desktop typecheck
pnpm --filter @fml/desktop test               # unit (Vitest)
pnpm --filter @fml/desktop test:integration   # against the real opencode binary
pnpm --filter @fml/desktop test:e2e           # Playwright + Electron, incl. the real Go server (Linux: xvfb-run -a)

cd server && go test -race -cover ./...       # Go; set FML_TEST_DATABASE_URL to include Postgres
cd tools/askpass && go test -race ./...
```

For the Postgres tests, run a database and point the tests at it, as CI
does:

```bash
docker run -d --name fml-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=fml \
  -p 127.0.0.1:5432:5432 postgres:17
export FML_TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/fml?sslmode=disable'
```

`FML_RECORD=1` re-records the integration fixtures. `FML_SHOTS=<dir>` makes
the E2E suite save screenshots. CI (`.github/workflows/ci.yml`) runs
everything above on every push to `main` and every pull request. It also
enforces at least 80% Go coverage and runs staticcheck and gosec.

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
  `/etc/shadow`, other users' homes, `/proc/*/environ` and everything the
  app itself keeps, including the sign-in token.
- **sudo** always uses the in-app password prompt, which names the exact
  command. The password goes straight to sudo's askpass helper. It is never
  logged, stored or shown to the model.
- **opencode is isolated.** It has private config and data directories,
  so it never touches your own opencode setup. It never sees the
  account token: model calls go through a loopback relay with a per-launch
  key.
- Every decision is written to a local activity log (the Activity screen).

## Packaging

On Linux, from the repository root after `pnpm install`:

```bash
pnpm fetch:opencode && pnpm build:helpers
cd apps/desktop
pnpm package                  # AppImage, deb, rpm for this machine's architecture
pnpm package:flatpak          # Flatpak bundle (needs flatpak-builder and the Flathub remote)
```

The packages land in `apps/desktop/release/`. If `flatpak-builder` fails
with a bubblewrap "Permission denied" error on Ubuntu 24.04, allow user
namespaces as in [Set up a Linux machine](#3-clone-and-build).

Each package carries only its architecture's opencode and `fml-askpass`.
opencode 1.19 publishes identical x64 and baseline (no-AVX2) builds, so one
copy ships. A future release with a distinct baseline build would be shipped
automatically. The AppImage and .deb can be built on macOS; rpm and Flatpak
need Linux.

The AppImage uses the static runtime, so it doesn't need `libfuse2`. On
Ubuntu 24.04+, though, AppArmor blocks the user namespaces Chromium's
sandbox needs, and an AppImage can't carry the setuid fallback. Expect the
AppImage to refuse to start there. The .deb is fine there because it
installs an AppArmor profile. Point Ubuntu users to the .deb or the
Flatpak.

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
- The safety policy also only sees the sandbox's copy of the files. Commands
  that use wildcards outside home, or temporary folders like `/tmp` (which
  differ on the host), ask first.
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

## What's pending

In rough order. Nothing below has been done yet.

### 1. CI

- [ ] The first push runs `.github/workflows/ci.yml` for the first time.
  Fix whatever it finds before going further.

### 2. Test on real Linux

Use the [VPS setup](#set-up-a-linux-machine-vps) above. Restore the user
namespace setting before testing installed packages.

- [ ] **Build every format on Linux:** `pnpm package` and
  `pnpm package:flatpak`. The rpm and the Flatpak have never been built.
- [ ] **.deb on Ubuntu or Debian:** it installs, starts from the app menu,
  and its AppArmor profile lets Chromium's sandbox work.
- [ ] **.rpm on Fedora:** at least check that the dependencies resolve:
  `docker run --rm -v "$PWD/apps/desktop/release:/r" fedora:latest dnf install -y /r/fix-my-linux-0.1.0.x86_64.rpm`.
  Better, run it in a Fedora VM with a desktop.
- [ ] **AppImage on Ubuntu 24.04** with the default user namespace setting.
  It is expected to fail. Decide how to handle it: tell Ubuntu users to use
  the .deb, or something else.
- [ ] **Flatpak:**
  - Commands run on the host, not in the sandbox.
  - The sudo password prompt works.
  - File tools outside the home folder are refused, with the "use a shell
    command" message.
- [ ] **sudo:** the prompt names the exact command. Try a wrong password and
  cancelling.
- [ ] **Package preview:** an install or remove shows the apt dry run on
  the approval card. Only apt has a preview so far.
- [ ] **Sign-in token storage:** with an unlocked keyring there is no
  warning. On a session without a keyring, the sign-in screen says the
  sign-in is saved without strong protection.
- [ ] **Real fixes** with `FML_DEV_ZEN_KEY`: "my disk is full", "install VLC",
  "restart the network".
- [ ] **Visual check:** compare the gallery with beautifului.dev.

### 3. Deploy the backend

- [ ] Railway: log in, then run `railway config plan`, then `apply` (see
  [Deploying the backend](#deploying-the-backend-railway)).
- [ ] Set every variable in the table above.
- [ ] Point a domain at the service: `api.fixmylinux.app`, or another domain
  with `DEFAULT_API_BASE` changed to match.
- [ ] Resend: verify the sending domain.
- [ ] Sign in from an installed app against the deployed backend, and check
  the trial starts.

### 4. Billing (Lemon Squeezy)

- [ ] Create the store and a $15/month subscription product. Its variant ID
  goes in `LEMONSQUEEZY_VARIANT_ID`.
- [ ] Add the webhook and its signing secret.
- [ ] Test-mode run:
  1. Check out with a test card.
  2. The webhook arrives.
  3. The app shows the paid plan, the paid models appear in the picker, and
     the usage meter moves.
  4. Cancel, and the plan ends at the end of the period.
- [ ] Build the page `CHECKOUT_REDIRECT_URL` points at ("you can go back to
  the app"). It doesn't exist yet.
- [ ] Get the store approved for live payments. Lemon Squeezy reviews
  stores first, and usually wants a public website with pricing, terms and
  a privacy policy.

### 5. Before launch

- [ ] Confirm with OpenCode that reselling Zen access through a proxy is
  allowed. Zen's terms don't cover it.
- [ ] Write a privacy policy and terms. The service stores email addresses
  and usage records. Zen's free models may collect prompts, which can
  include terminal output; the sign-in screen says so, and that notice must
  stay.
- [ ] Decide where downloads live. Release files in a private repository
  can't be downloaded by the public. Use a public releases repository or
  another host, and host a Flatpak repository (`.flatpakref`) or just offer
  the bundle.
- [ ] Replace the placeholder app icon (`apps/desktop/build/icon.svg`) and
  set up the `fixmylinux.app` homepage that the Flatpak metadata links to.
- [ ] Release: tag `v0.1.0` and push the tag. Then check the draft release
  on a clean machine and publish it.

### Later (not in v1)

- Auto-update (electron-updater for the AppImage).
- Credit top-ups, and languages other than English.
- Package previews for dnf, zypper and pacman.

### Known limitations

- **Same-user processes can pass the askpass check.** The check looks for
  a sudo process run by the agent, but Node can't read the peer's
  credentials from a socket. In the Flatpak build it only checks that a
  sudo approval is active.
- **The Flatpak's safety policy sees the sandbox's view of files,** not the
  host's.
- **Memory use on the Home screen is wrong on macOS.** Linux is fine, and
  macOS is only for development.

## Licenses

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): Beautiful UI (MIT),
Lucide (ISC), Inter and JetBrains Mono (OFL), opencode (MIT), and others.
