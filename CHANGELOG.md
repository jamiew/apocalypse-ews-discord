# Changelog

## 2026-11-08

### Website

- Added dated, plain-English privacy and terms pages, linked from the homepage. The privacy policy explains message logging, stored Discord details, outside services, and how to request deletion.

### Deploy

- Rootless Docker documented as the recommended setup, with rootful Docker as the alternative and steps to move between them. `DEPLOY_DOCKER_CONTEXT` in `.deploy.env` points `deploy.sh` and `sync-from-prod.sh` at the right daemon on the remote.
- Test fixtures use synthetic Discord names and IDs.

### Security

- Removed the unnecessary Message Content gateway intent. DMs and direct @mentions retain access to their content without privileged approval. Setup now documents safe toggle removal and the separate app-verification requirement for growing past 100 servers.
- Dependencies bumped to latest: discord.js 14.28.1, zod 4.6.7, node-cron 4.6.0. Clears 17 `bun audit` advisories (7 high) in transitive `undici` <6.29.1 (TLS cert validation bypass, WebSocket / content-encoding DoS), `ws` <8.21.0 (fragment memory exhaustion), and `zod` <4.6.6 (oversized-collection memory exhaustion).
- `/subscribe` and `/unsubscribe` now check ManageGuild in the handler for guild channels. Previously only the command's `default_member_permissions` gated them, which server admins can widen and user-installed invocations don't carry — any member could re-route or silence a server's alerts. The @-mention path already checked.
- Client-wide `allowedMentions: { parse: [] }`. Upstream feed text relayed to every subscriber can no longer ping users, roles, or @everyone.
- Upstream fields clipped (256 chars, links 512) and backticks neutralised inside the level-change code fence. An oversized title previously failed every send for an alert already marked seen, dropping it for good.
- RSS and dashboard fetches go through `fetchTextCapped` (15s timeout, 16 MiB body cap). rss-parser now parses a string instead of fetching itself.
- Replaced operator DMs with `INFO_WEBHOOK_URL` for DEBUG/INFO and `ERROR_WEBHOOK_URL` for WARN/ERROR. Install/uninstall and routine status stay separate from urgent alerts and failures. Removed `OPERATOR_USER_ID` and `DEV_ADMIN_USER_ID`; empty webhook URLs disable their stream. Messages suppress mentions, redact credentials and message bodies, and stay within Discord's length limit. Delivery is best-effort; pending requests drain before exit. Renamed the secret-free configuration template to `.env.sample`.
- Container runs as the unprivileged `bun` user. The entrypoint chowns `./data` (root-owned from earlier deploys) on start, then drops privileges; on the host, `./data` ends up owned by uid 1000. Compose adds `read_only`, `tmpfs: /tmp`, `cap_drop: ALL` (+ CHOWN/SETUID/SETGID for the entrypoint), `no-new-privileges`. `scripts/sync-from-prod.sh` execs as `bun` to match.
- `.dockerignore` keeps `.env*`, `data*/`, and `.git` out of the build context.
- CI actions pinned to commit SHAs, checkout without persisted credentials, bun pinned to 1.4.4.
- `deploy.sh` and `sync-from-prod.sh` shell-quote `DEPLOY_PATH` / branch / remote for the remote shell.

### Tooling

- Biome 2.6.6 (config migrated: `recommended: true` → `preset: "recommended"`), TypeScript 7.0.2, `@types/bun` 1.4.4.
- Removed stale `/dev-fire` references from `README.md` and `.env.example`.
- Stricter gates. TypeScript: `verbatimModuleSyntax`, `erasableSyntaxOnly`, `noUncheckedSideEffectImports`, `allowUnreachableCode: false`, `allowUnusedLabels: false`. Biome: `noFloatingPromises`, `noMisusedPromises`, `useExhaustiveSwitchCases`, `noConsole`, `noProcessEnv`, `useAwait`, `noShadow`, `noImportCycles`, `noUnusedFunctionParameters`, `noUndeclaredDependencies`, `useThrowOnlyError`, `useErrorMessage`, `noEvolvingTypes`. Caught one floating promise: shutdown didn't await `node-cron` task stops.
- Dropped the two remaining `as` casts in `discord.ts` in favour of `in` narrowing.
- Dependabot: weekly grouped version updates (bun, GitHub Actions, Docker); alerts + automatic security PRs enabled on the repo. Daily `bun audit --audit-level=high` workflow fails on high/critical advisories.
- Documented team ownership transfer, public privacy/terms setup, stored message data, and release checks. The landing page explains the minimal invite permissions and labels its older screenshot. Welcome and subscription messages now describe every emergency-level change rather than only level 5 incidents.

## 2026-10-25

### Security

- Base image pinned to `oven/bun:1.4.4-debian`. Bun ships its own root CAs, and 1.3.13 still trusted the compromised eMudhra root `emSign ECC Root CA - G3`, so a forged certificate for any host (Discord, the RSS feed, the dashboard) would have passed. 1.4.4 rejects it.

## 2026-05-18

- `scripts/sync-from-prod.sh` — pull prod sqlite db + log to a local dir for analysis. Uses `VACUUM INTO` inside the bot container for a WAL-safe atomic snapshot; reuses `.deploy.env`; default dest `./data-prod/` (matches new `data-*/` gitignore rule).

## 2026-05-09

### Features

- Heartbeat broadcast: every 6–10 days (jittered) the bot pings subscribed guild channels with a "STANDING BY. Nothing to report." note so operators know it's alive. Suppressed for 24h after any real level change so heartbeats don't follow alerts. Guild channels only — DM subscribers are not pinged.

### Robustness

- `guildCreate` now distinguishes _no postable channel_, `DiscordAPIError[50001]` Missing Access, and other failures, recording a `guild_welcome_failed` event for each and DMing the operator. Previously a single catch-all log line.
- Replaced the deprecated `ephemeral: true` with `flags: MessageFlags.Ephemeral` (7 sites) so docker logs stop emitting a stack trace on every interaction.
- Removed the `/dev-fire` test command. Re-register globally to drop it from the live command list.

### Observability

- `info` log lines at every user-facing seam: slash command, DM in/out, mention in/out, subscribe, unsubscribe, alert seen, operator DM sent. The durable `events` table already covered these; live tailing now does too.
- Heartbeat skipped decisions logged at `info` instead of `debug`.

## 2026-05-05

- Operator DMs on guild install / subscribe / unsubscribe now use a bulleted format with names and IDs.
- Welcome channel is auto-subscribed on install — no manual `/subscribe` needed for fresh servers.
- `guild install` / `guild remove` log lines and operator DMs carry richer context (member count, owner tag, locale, features, tenure).
- Install-time owner DM dropped.

## 2026-05-03

- Mention / DM free-text classifier widened (e.g. "stop", "sign me up", "what's my level") and transitions in copy clarified.
- `.deploy.env` added to `.gitignore`.

## 2026-05-02

- One-command `deploy` script for docker-compose hosts.
- README REDEPLOY section + credits.

## 2026-05-01

Initial release. Discord bot mirroring the [Apocalypse EWS](https://ews.kylemcdonald.net) Telegram channel.

- Single Bun process holding a persistent Discord gateway.
- RSS poller diffs against `seen_alerts` and fans out level-5 alerts to subscribed channels and DM users.
- Dashboard JSON poller tracks `current.emergencyLevel` and announces every transition (rising or falling) through a level-state table.
- Slash commands (`/subscribe`, `/unsubscribe`, `/status`, `/help`) supporting both guild-install and user-install with all interaction contexts; ManageGuild gates write commands; `/dev-fire` admin-only.
- @-mentions and DM free-text understood for the same intents.
- Annual reminder cron pings long-tenured subscribers with a way out.
- Zod-validated boundaries: env vars, RSS feed, dashboard JSON.
- Closed `EventKind` union with discriminated-union payloads — adding a kind without extending the payload map is a compile error.
- Durable `events` table records every meaningful action; tiny zero-dep logger streams JSON to stdout + `./data/ews.log`.
- Operator DM on install / subscribe / unsubscribe.
- Deadpan / War Games copy throughout, locked in by tone-guard tests (no emoji, no `!`, source URL on welcome).
- Docker / docker-compose deployment, GitHub Actions CI (biome + tsc + bun test), GitHub Pages splash page with install buttons.
