> The design plan approved before implementation (2026-10-11), kept for
> reference. The code and the README are authoritative where they differ.
> For example, Lucide replaced Central Icons, and `.railway/railway.ts`
> replaced the Railway MCP deploy.

# Fix My Linux — opencode-powered "terminal operator" desktop app

## Context

Many Linux users don't know how to use the terminal, but most Linux fixes ("Wi-Fi stopped working", "disk is full", "install Chrome", "no sound") happen there. This app lets them describe the problem in plain English. An AI agent diagnoses and fixes it by running terminal commands for them. It explains each step in plain language and asks before changing anything.

The agent runtime is **opencode v1.19.0**, run headless (`opencode serve`) and driven through `@opencode-ai/sdk` 1.19.0. The UI is built **only from Beautiful UI** (beautifului.dev). That's 21 MIT copy-paste React + Tailwind components; screens they don't cover are composed from their own parts.

The business model is a 5-day free trial on OpenCode Zen's free models. After that it's **$15/mo** through **Lemon Squeezy**, which unlocks a curated list of paid Zen models, capped at **$8/mo of upstream cost** per user. All model traffic goes through **our Go proxy on Railway**, so the Zen key never ships inside the app.

The repository started empty. The opencode details below were verified against the `anomalyco/opencode@v1.19.0` source; file references are to that tag.

## Decisions (from Q&A)

| Topic | Decision |
|---|---|
| Desktop shell | Electron (electron-vite, React 19, TS, Tailwind v4) |
| opencode | Bundle a pinned binary and auto-spawn it. Fully isolated from any user-installed opencode |
| Auth | Email OTP (6-digit). Trial tied to email **and** an HMAC of `/etc/machine-id` |
| Billing | Lemon Squeezy $15/mo, opened in the system browser; webhooks update the plan |
| Models | Trial = Zen free models only. Paid = curated Zen list. Both go through our proxy |
| Usage cap | $8/mo upstream cost per subscriber, shown as a usage meter |
| Backend | Go service on Railway + Railway Postgres |
| Safety | Tiered: read-only commands auto-run; changes show an Approval Card; catastrophic patterns denied |
| Root | In-app password prompt through a `SUDO_ASKPASS` helper; `sudo` is always "ask" |
| UI gaps | Composed from Beautiful UI parts and tokens |
| Icons | Central Icons (paid license) → **lucide-react** behind one adapter |
| Missing atoms | Recreate `Button`, `EntityChip`, `Shimmer`, `StreamText`, `ValuePill`, `GlideMenu` to match the live site |
| Packages | AppImage, .deb, .rpm, Flatpak (x64 + arm64) |
| Linux testing | User's Linux VPS: Xvfb for E2E, x11vnc/noVNC over an SSH tunnel for visual checks |

## Architecture

```
┌──────────────────────── Electron app (user's machine) ───────────────────────┐
│ Renderer (React + Beautiful UI) ◄── typed IPC (preload, sender-checked) ──► Main│
│ Main process:                                                                │
│  • opencode supervisor ──spawn (isolated env)──► opencode serve --port 0     │
│  • SDK client + SSE pump → session reducer → IPC                 │ bash tool │
│  • permission broker (risk score, "this kind" memory, audit log)  ▼           │
│  • loopback model relay 127.0.0.1:<rand> (per-launch nonce) ◄── opencode    │
│        adds device token → backend; maps 402/429 → UI cards                  │
│  • askpass socket (0700 dir) ◄── askpass helper ◄── sudo -A ◄── shell wrapper│
│  • account: device token in safeStorage                                      │
└───────────────┬──────────────────────────────────────────────────────────────┘
                │ HTTPS, Bearer device token
┌───────────────▼────────────────── Go backend (Railway) ──────────────────────┐
│ /v1/auth/otp/*  /v1/me  /v1/catalog  /v1/billing/*  /v1/webhooks/lemonsqueezy│
│ /zen/v1/*  auth → plan → model allowlist → reserve worst-case cost →          │
│           forward to opencode.ai/zen/v1 (our Zen key) → tee stream →          │
│           parse usage (5 formats) → settle cost (drain even if client leaves) │
│ Postgres · Resend (OTP email) · Lemon Squeezy API                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

The long-lived device token never enters opencode's process or env. opencode only knows a loopback URL and a per-launch nonce.

## Repo layout (monorepo)

```
fix-my-linux/
  apps/desktop/
    src/main/       opencode.ts (supervisor, env, config), config.ts (generated opencode config),
                    events.ts, permissions.ts (ruleset), broker.ts (approval logic), risk.ts,
                    relay.ts (loopback model relay), askpass.ts, account.ts, audit.ts, ipc.ts, security.ts
    src/preload/index.ts
    src/renderer/
      components/bui/            21 vendored components (MIT header kept)
      components/bui/atoms/      recreated atoms
      components/bui/icons.tsx   Lucide-backed icon adapter
      styles/bui-tokens.css      Tailwind v4 @theme tokens from the site's compiled CSS
      screens/                   Onboarding, Chat, Home, Activity, Settings
      state/                     session reducer, account store
    resources/shell/bash         shell wrapper (see "Shell wrapper")
    resources/shell/sudo         shim: exec /usr/bin/sudo -A "$@"
    resources/askpass/askpass    helper → Unix socket
    resources/prompts/fixer.md   agent system prompt
    resources/bin/<variant>/opencode   fetched at build time
    electron-builder.yml, flatpak/dev.fixmylinux.app.yml
  server/  cmd/api, internal/{auth,billing,proxy,usage,catalog,store}, migrations/
  scripts/vendor-bui.ts, scripts/fetch-opencode.ts
```

## Desktop app

### opencode supervisor (`src/main/opencode.ts`)
- **Binary variants**: `opencode-linux-x64` (needs AVX2), `opencode-linux-x64-baseline` (older CPUs) and `opencode-linux-arm64`. Pick at runtime by checking `/proc/cpuinfo` for `avx2`. Each binary is a self-contained Bun executable at `package/bin/opencode`; needs glibc ≥ 2.17.
- **Launch**: `opencode serve --hostname 127.0.0.1 --port 0`. Parse `opencode server listening on http://…` from stdout. Restart with backoff on crash. Show the **Loading State** while it boots.
- **Isolated env**:
  - `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME` → app-private dirs. This keeps the user's `~/.config/opencode`, `auth.json` and DB out.
  - `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_PURE=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_SHARE=1`, `OPENCODE_DISABLE_LSP_DOWNLOAD=1`, `OPENCODE_DISABLE_DEFAULT_PLUGINS=1`, `OPENCODE_DISABLE_EMBEDDED_WEB_UI=1`.
  - `OPENCODE_MODELS_URL` → our backend `/v1/catalog`, a plan-filtered `opencode` provider in models.dev format.
  - Random `OPENCODE_SERVER_PASSWORD`. Config passed via `OPENCODE_CONFIG_CONTENT`.
  - Known leftovers: `/etc/opencode/opencode.json` and a logged-in console org can still override. Detect and warn.
- **Generated config** (`config.ts`):
  - `enabled_providers:["opencode"]`.
  - `provider.opencode`: `options.baseURL` = loopback relay URL + `/zen/v1`, `options.apiKey` = per-launch nonce, `whitelist` = plan models.
  - `model` and `small_model` set to plan models. `small_model` must be **free** for trial users, or title generation fails.
  - `share:"disabled"`, `autoupdate:false`, `lsp:false`, `formatter:false`, `snapshot:false` (otherwise a dotfiles `~/.git` makes it snapshot all of `$HOME`).
  - `shell` = `resources/shell/bash`.
  - `default_agent:"fixer"`.
  - `agent.fixer` = `{mode:"primary", prompt:"{file:…/fixer.md}", steps:40}`.
  - `build`, `plan`, `general` and `explore` all `disable:true`.
- **Agent prompt (`fixer.md`)**:
  - Assume a non-technical user.
  - Detect distro, desktop, package manager and init system first.
  - Before **every** tool call, write one plain-English sentence saying what it will do and why. The bash tool in 1.19 has no description argument.
  - Keep a todo list for multi-step fixes.
  - Prefer the least invasive fix. Use `sudo` only when needed. Never pipe downloads into a shell.
  - Verify the fix afterwards, then summarize in plain words.
- **Sessions** are created with `session.create({permission: <deny rules>})`, because session deny rules also reach child sessions. Prompts go through v2 `client.session.promptAsync({sessionID, agent:"fixer", model, parts})`.

### Permissions (`src/main/permissions.ts`)
Facts from the source:
- Rules live in the **top-level** `permission` block. Subagent rules don't inherit from the parent agent, so `task:"deny"` as well.
- opencode splits commands with tree-sitter. Every simple command (both sides of `;`, `&&`, `|`, `$(…)`) is matched on its own; any deny wins, all-allow runs, otherwise it asks.
- The last matching rule wins. `*` matches anything, including spaces, `>` and `/`.
- A redirect stays part of the command's pattern.

Ruleset, in order:
1. `bash`:
   1. `"*":"ask"`.
   2. **allow** (read-only diagnostics): `ls *`, `cat *`, `head *`, `tail *`, `grep *`, `find *`, `df *`, `du *`, `free *`, `uname *`, `lsb_release *`, `lsblk*`, `lspci*`, `lsusb*`, `ip addr*`, `ip route*`, `ip link show*`, `nmcli general*`, `nmcli device status*`, `nmcli connection show*`, `systemctl status *`, `systemctl list-*`, `systemctl is-*`, `journalctl *`, `ps *`, `uptime*`, `whoami`, `id`, `id *`, `which *`, `dpkg -l*`, `rpm -q*`, `apt list*`, `apt-cache *`, `dnf list*`, `pacman -Q*`, `flatpak list*`, `snap list*`, `pactl info*`, `pactl list*`, `xrandr --query*`, `echo *`, `pwd`.
   3. **re-ask** overrides after the allows: `*>*`, `sudo *`, `pkexec *`, `su *`, `doas *`, `run0 *`, `find * -delete*`, `find * -exec*`, `find * -ok*`, `find * -fprint*`, `find * -fls*`, `journalctl *--vacuum*`, `journalctl *--rotate*`, `nmcli *--show-secrets*`, `tail *-f*`, `*OPENCODE_*`.
   4. **deny**: `rm -rf /`, `rm -rf /*`, `rm -rf ~*`, `mkfs*`, `dd * of=/dev/*`, `chmod -R 777 /*`, `sh`, `bash`, `sh -s*`, `bash -s*`, `:(){*`.
2. `edit:"ask"`. `webfetch:"ask"`, which blocks prompt-injection exfiltration. `websearch:"deny"`, since it would otherwise call exa.ai directly. `task:"deny"`.
3. `external_directory:{"*":"ask","/etc/*":"allow","/var/log/*":"allow"}`. The model prefers the read/grep tools over `cat`.

Table-driven Vitest: command → expected decision, including chained, piped, redirected and `$( )` cases.

### Approval broker (`src/main/broker.ts`) → **Approval Card**
- **Input**: `permission.asked` `{id, sessionID, permission, patterns[], metadata, always[], tool}`. Metadata per tool:
  - bash: `{command}`
  - edit: `{filepath, diff}`
  - external_directory: `{directories}`
- **Risk** comes from `risk.ts` and is scored from the **real command or diff, never the model's text**:
  - Low: user-space change.
  - Medium: package install/remove, service start/stop, editing a config under `$HOME`.
  - High: sudo, `/etc`, bootloader, drivers, disks.
- **Card contents**: the agent's preceding plain-English sentence (the text part just before the tool call), the risk badge, the exact command in a collapsible **Code Block**, and the unified diff for edits.
- **Options**: *Allow once* · *Allow similar for this chat* · *Don't do this*.
- **Never send `reply:"always"`.** In 1.19 it overrides deny rules and lasts for the whole server process. "Allow similar" is remembered in the broker per session (low/medium only, never sudo), and the broker auto-replies `once`.
- **Reply**: `client.permission.reply({requestID, reply, message?})`. A reject also rejects every pending request in that session; the UI reflects this.
- Every decision and its outcome go to the local audit log, shown on the Activity screen.

### Shell wrapper + sudo (`resources/shell/*`, `src/main/askpass.ts`)
- `resources/shell/bash` is named `bash` so opencode treats it as bash. It:
  - unsets `OPENCODE_*`
  - restores the user's real `XDG_*`
  - prepends `resources/shell` to `PATH`, so the `sudo` shim forces `-A`
  - sets `SUDO_ASKPASS`
  - `exec /bin/bash "$@"`
  - in Flatpak mode instead: `exec flatpak-spawn --host --watch-bus --env=… /bin/bash "$@"`
- **askpass**:
  - The helper connects to a Unix socket in a 0700 runtime dir.
  - Main identifies the peer. Node has no SO_PEERCRED, so it maps the socket inode to a pid through `/proc`, or uses a tiny native addon.
  - It checks the parent is `sudo`, that it descends from the opencode PID, and that its `/proc/<pid>/cmdline` matches a currently approved sudo permission.
  - Main shows an Approval-Card-style password prompt naming that exact command, with one prompt per connection.
  - The password is held only in memory and written once to the helper's stdout. It is never logged or sent to the model.

### Loopback model relay (`src/main/relay.ts`)
- opencode → `127.0.0.1:<rand>/zen/v1/*` with the nonce, in any of the three auth header styles (`Authorization: Bearer`, `x-api-key`, `x-goog-api-key`).
- The relay swaps in the device token and streams to the backend with no buffering.
- A backend 402 (trial over or no plan) or 429 (budget or rate limit) is surfaced as a UI event, rendered as an **Approval Card** paywall or a "budget used, resets on <date>" card.

### Screens → Beautiful UI components
| Screen / element | Components |
|---|---|
| App frame | **Sidebar Nav** (chats, new chat, Home, Activity, Settings, account + usage meter from the `ValuePill` atom) |
| Chat | **Chat** + **Prompt Bar** (`/` = quick fixes such as /wifi, /disk-space, /updates; `@` = attach context such as system info, a file or a log; model picker = plan models; dictation hidden in v1) |
| Agent output | **Thinking** (reasoning deltas) · **Streaming Text** (`message.part.delta` text, plus follow-ups) · **Tool Chips** (tool parts by `state.status`) · **Task Rows** (`todo.updated`) · **Code Block** (live `metadata.output`, final output/exit code, diffs) |
| Approvals, sudo password, paywall, budget exhausted | **Approval Card** |
| Package change preview | **Diff Table** (install/remove/upgrade with versions) |
| Home | **Insight Cards** (live CPU/RAM/disk/network, read locally by main, no AI cost) · **Recommendation Card** (results of an on-demand read-only health check) · **Context Cards** (detected system facts and the command that produced each) |
| Ctrl+K palette | **Search** (past chats + quick fixes) |
| Output text | **Selection Actions** ("Explain this" / "Fix this") |
| Activity | **Filter Table** (auto-ran / approved / denied / failed) |
| Settings | **Fine-tune Card** (explanation detail, "always ask" mode, default model) |
| Onboarding / sign-in | Composed: `Button`, Prompt Bar input styling, Loading State. Discloses that trial free models may collect data |
| Not used in v1 | Records Table, Flowchart, Agent Screen |

**Event mapping (SSE `{id,type,properties}`)**:
- `message.part.delta`
- `message.part.updated`: tool states are `pending` → `running` (`metadata.output`) → `completed` (`output`, `metadata.exit`) or `error`; `step-finish` carries cost and tokens.
- `todo.updated`
- `permission.asked` / `permission.replied`
- `session.status` (`idle|busy|retry`)
- `session.error`
- Ignore `session.next.*`.

Fixture-driven reducer tests.

### Beautiful UI vendoring
1. `scripts/vendor-bui.ts` extracts the 21 component sources embedded in the beautifului.dev HTML into `components/bui/*.tsx`, adding the MIT header. The committed files are the source of truth from then on.
2. Pull the tokens (`ink-*`, `line`, radii, fonts) from the compiled CSS into `bui-tokens.css`. Identify the two woff2 fonts and check their licenses.
3. Rewrite the 12 `@central-icons-react/...` imports to `icons.tsx`, backed by Lucide.
4. Recreate the 6 atoms from their call-site props, checked against the live site.
5. `PromptBar` uses `glimm`. Use its framework-agnostic core, since the React adapter peer-depends on `next`. `InsightCards` uses `liveline` (MIT).
6. Replace the demo data with typed props.
7. Build a dev-only `/gallery` route that renders each component beside a reference screenshot.

### Electron security (`src/main/security.ts`)
- Window settings: `contextIsolation`, `sandbox`, `nodeIntegration:false`.
- Content: strict CSP; sanitized markdown rendering.
- Navigation: block navigation and `window.open`.
- IPC: sender-frame checks on every handler.
- External links: `shell.openExternal` limited to Lemon Squeezy hosts.
- Electron Fuses: RunAsNode, NODE_OPTIONS and inspect off; asar integrity on.
- Secrets: device token in `safeStorage`. If `getSelectedStorageBackend()` is `basic_text`, warn and offer sign-in each launch. Flatpak needs `--talk-name=org.freedesktop.secrets`.

## Backend (Go, `server/`)
- **Stack**:
  - Router and DB: `net/http` + chi, pgx/v5, goose, slog.
  - Config from env: `ZEN_API_KEY`, `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_STORE_ID`, `LEMONSQUEEZY_VARIANT_ID`, `LEMONSQUEEZY_WEBHOOK_SECRET`, `RESEND_API_KEY`, `MACHINE_HMAC_SECRET`, `DATABASE_URL`.
  - `context.WithTimeout` on upstream calls.
  - Errors: wrapped with `%w`.
  - Interfaces: small, defined at the consumer (`Mailer`, `Billing`, `Upstream`, `Pricing`).
- **Tables**:
  - `users`
  - `otp_codes` (hashed, 10-minute TTL, 5 attempts)
  - `devices` (token hash, machine HMAC)
  - `trials` (unique email, unique machine HMAC)
  - `subscriptions` (LS id, status, renews_at, ends_at)
  - `usage` (user, model, in/out/cache tokens, micro-USD, request id, ts)
  - `reservations`
  - `webhook_events` (idempotency)
- **Endpoints**:
  - `POST /v1/auth/otp/start` and `POST /v1/auth/otp/verify` (rate-limited per IP and email).
  - `GET /v1/me`: plan, trial end, used/budget, period end.
  - `GET /v1/catalog`: the models.dev-format `opencode` provider, filtered by plan. Trial = active models with zero cost; paid = curated allowlist. Excludes `status:"deprecated"`. Pricing is refreshed hourly from `models.opencode.ai/api.json`.
  - `POST /v1/billing/checkout`: LS checkout with `custom.user_id`.
  - `GET /v1/billing/portal`.
  - `POST /v1/webhooks/lemonsqueezy`: HMAC-SHA256 `X-Signature`; handles `subscription_created/updated/cancelled/expired/payment_success`.
- **Proxy `/zen/v1/*`**:
  1. Auth.
  2. Plan check.
  3. Resolve the model. It comes from the JSON `model` field, or from the URL path for Google `/models/<id>:streamGenerateContent`. Check it against the allowlist.
  4. Reserve the worst-case cost (input estimate + `max_tokens` × output price). Reject with 429 if it would exceed $8. Trial users get a daily request cap instead.
  5. Forward with the Zen key.
  6. Stream the response back unchanged while a tee parses the final usage, then settle the reservation with the real cost. **Keep draining upstream after a client disconnect**, because Zen bills cancelled requests.
- **Usage formats**:
  - `/chat/completions`: final chunk `usage`.
  - `/responses`: `response.completed.response.usage`.
  - `/messages`: `message_start` + cumulative `message_delta.usage`.
  - Gemini: last `usageMetadata`.
  - Mistral.
  - Pricing: `cost{input,output,cache_read,cache_write}` per 1M tokens, plus context `tiers`.
  - Title, summary and compaction calls are metered like everything else.
- **Privacy**: the proxy never logs request or response bodies.
- **Deploy**: Railway service + Postgres via the Railway MCP. `/healthz`.

## Packaging
- electron-builder: AppImage, deb, rpm for x64 + arm64. `scripts/fetch-opencode.ts` pulls the pinned `opencode-linux-x64`, `-x64-baseline` and `-arm64` tarballs and verifies their checksums against the npm integrity values.
- **Flatpak**:
  - Own manifest with `--share=network`, `--talk-name=org.freedesktop.Flatpak` and `--talk-name=org.freedesktop.secrets`.
  - opencode runs inside the sandbox, while the shell wrapper runs each command on the **host** via `flatpak-spawn --host`.
  - The askpass socket lives in `$XDG_RUNTIME_DIR/app/<id>`.
  - Distribute through our own repo/`.flatpakref`, since Flathub is likely to refuse a sandbox escape.
- Releases go to GitHub Releases. AppImage auto-update (electron-updater) comes in a later phase.

## Phases
1. **Scaffold + UI kit**: git init, monorepo, electron-vite, tokens, 21 vendored components, atoms, icon adapter, `/gallery`.
2. **opencode core**: binary fetch, supervisor, isolated env, config generation, SDK event pump, reducer, Chat screen. Uses a dev-only direct Zen key through the relay.
3. **Safety**: ruleset, broker, risk scoring, Approval Card, shell wrapper, sudo askpass, audit log + Activity.
4. **Backend**: OTP, entitlements, catalog, proxy + metering + reservations, Railway deploy. Switch the relay to the backend.
5. **Billing**: Lemon Squeezy checkout, webhooks, portal, paywall, usage meter, budget card.
6. **Home & polish**: Insight/Recommendation/Context Cards, Search, Selection Actions, Settings, onboarding.
7. **Packaging + CI**: Docker builds for all 4 formats and both arches; GitHub Actions.

Per your workflow rules: tests are written first in each phase, and the code-reviewer and security-reviewer agents run after each phase.

## Verification
- **Go**: `go test -race -cover ./...` (≥80%), plus `gosec ./...` and `staticcheck`. Table-driven tests cover:
  - usage parsers on recorded Zen SSE fixtures for all 5 formats
  - reservation and settle math, including disconnect draining
  - webhook signatures and idempotency
  - entitlements
  - OTP expiry and attempt limits
  - allowlist, including Google path models
  - proxy end-to-end against an `httptest` fake upstream
- **Desktop Vitest**:
  - the permission decision table, checked against opencode's real behavior by a test that runs the bundled opencode
  - risk scoring
  - the broker (never sends "always"; "similar" memory)
  - the reducer, using fixture SSE streams
  - the askpass peer check
  - config/env generation, asserting the isolation flags are present
- **Playwright-Electron E2E**: the real bundled opencode against a staging backend with a fake Zen upstream that replays scripted replies. The run:
  1. OTP sign-in through a test mailbox.
  2. "My disk is full".
  3. `df` auto-runs and shows as a chip.
  4. Approve a cleanup on the Approval Card.
  5. The sudo password prompt appears and names the exact command.
  6. Task rows complete.
  7. A chained `ls; rm -rf ~/x` prompts instead of auto-running.
  8. An injected `echo $OPENCODE_SERVER_PASSWORD` prints nothing.
  9. The trial-expiry paywall appears.
  10. The budget-exhausted card appears.
- **User's Linux VPS**:
  - Install the .deb and AppImage on Ubuntu and the .rpm in a Fedora container; install the Flatpak.
  - Run the E2E under Xvfb.
  - Do a manual visual pass over x11vnc/noVNC through an SSH tunnel, comparing `/gallery` with beautifului.dev.
  - Run real tasks: check disk space, install a package with sudo, restart NetworkManager.
  - SSH access details are needed at that point.
- **Billing**: Lemon Squeezy test mode. A test card completes checkout → webhook → `/v1/me` shows active → paid models appear in the picker.

## Risks / open items
- **Zen resale terms**: Zen's docs don't mention reselling or proxying access. Confirm with OpenCode before launch.
- **Data collection on free models**: Zen says free models may collect data, which can include terminal output from the user's machine. Disclose this during onboarding.
- **Free-model churn**: the trial list is always dynamic (from the catalog).
- **Flatpak**: the host escape rules out Flathub (self-hosted repo instead).
- **Lemon Squeezy store approval**: required before going live; test mode works meanwhile.
- **Atoms are recreations**: they match the site visually but aren't the official code.
- **Upgrade review**: opencode permission semantics changed between versions. Re-run the decision-table test against the real binary before any version bump.

## Defaults chosen (change if wrong)
- Working name **"Fix My Linux"**, app id `dev.fixmylinux.app`.
- OTP email through **Resend**.
- English only.
- No credit top-ups in v1.
- No conversation content stored server-side; usage metadata only.
- Session cwd = `$HOME`.
