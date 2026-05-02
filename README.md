```
   ┌──────────────────────────────────────────────────────────────────┐
   │  APOCALYPSE EARLY WARNING SYSTEM // DISCORD BOT                  │
   │  CONDITION NORMAL: SILENT.                                       │
   └──────────────────────────────────────────────────────────────────┘
```

Discord bot for the [Apocalypse Early Warning System](https://ews.kylemcdonald.net) ([source](https://github.com/kylemcdonald/ews)). Mirrors the existing [Telegram channel](https://t.me/apocalypse_ews) — when the upstream system reaches **emergency level 5**, this bot announces it in subscribed Discord channels and direct messages.

> Tracked-aircraft anomaly signals over a rolling 24-hour window. Most days nothing happens. That is the design.

User-facing copy is deadpan / War Games. Source strings live in `src/copy.ts`. The tone-guard tests (`copy.test.ts`) reject exclamation points and emoji on principle.

---

## // CAPABILITIES

- **POLL.** Fetches `https://ews.kylemcdonald.net/rss.xml` every 30 minutes (matching the feed `<ttl>`).
- **DETECT.** Diffs incoming items against the `seen_alerts` table by `<guid>` (or a hashed fallback). Already-delivered items are not re-paged.
- **DISPATCH.** New items fan out to every active subscriber. Every per-subscriber outcome is recorded (`alert_dispatch_ok` / `alert_dispatch_fail`).
- **OPERATE.**
  - Slash commands: `/subscribe [channel]`, `/unsubscribe`, `/status`, `/help`. Available in **guild** and **user-install** contexts (DMs and private channels too).
  - `@-mention` in a guild channel with `subscribe` / `unsubscribe` / `status` / `help` — same effect, gated on ManageGuild for state changes.
  - Plain DMs respond to `subscribe` / `unsubscribe` keywords; anything else gets a "still here" status reply.
  - Hidden `/dev-fire` (gated by `DEV_ADMIN_USER_ID`) synthesizes an alert without waiting on the real feed.
- **REMIND.** Once a year, every active subscriber receives a "you are still subscribed, go enjoy your life" nudge.
- **REPORT.** The operator (`OPERATOR_USER_ID`, falls back to `DEV_ADMIN_USER_ID`) is DM'd on guild install / subscribe / unsubscribe.

---

## // SUBSYSTEMS

TypeScript + Node 22+, pnpm, [discord.js](https://discord.js.org), [rss-parser](https://www.npmjs.com/package/rss-parser), [better-sqlite3](https://www.npmjs.com/package/better-sqlite3), [node-cron](https://www.npmjs.com/package/node-cron), [zod](https://zod.dev). Biome for lint + format. Vitest for tests.

```
src/
  index.ts                boot: db, discord client, two crons (poll + reminders)
  discord.ts              gateway client, commands, DM + mention handlers, fan-out
  poller.ts               RSS fetch (zod-validated) + dedup
  reminders.ts            daily cron handler — annual reminder
  db.ts                   better-sqlite3 wrapper; EventKind; recordEvent
  copy.ts                 ALL user-facing strings (DEFCON tone)
  env.ts                  zod-validated env
  log.ts                  tiny zero-dep structured logger (stdout + file)
  scripts/
    register-commands.ts  one-shot, runs slash command upload
migrations/
  0001_init.sql           subscribers, seen_alerts
  0002_events.sql         durable activity log
docs/                     GitHub Pages splash (install buttons, terminal CSS)
assets/                   bundled icon, reused for bot avatar / embeds
systemd/                  ews-bot.service unit
.vscode/                  shared workspace settings (Biome)
Dockerfile                node:24-bookworm-slim, two-stage build
biome.json                tabs, line width 100, strict (noNonNullAssertion etc.)
tsconfig.json             typecheck (includes tests)
tsconfig.build.json       build (excludes tests)
```

The bot needs a persistent process — Discord's gateway is a long-lived WebSocket. SQLite and the JSON log live on local disk; both belong on the same volume.

---

## // INITIALIZE THE DISCORD APPLICATION

1. <https://discord.com/developers/applications> → **New Application**.
2. **Bot tab** → Reset Token → copy. Enable **Message Content Intent** (required for DM ping/pong + @-mention reading).
3. **General Information** → copy **Application ID** → that's `DISCORD_CLIENT_ID`.
4. **Installation tab** → enable **User Install** alongside Guild Install if you want the bot to be installable to user accounts (not just servers).
5. Copy `.env.example` → `.env`, fill in:
   - `DISCORD_TOKEN`
   - `DISCORD_CLIENT_ID`
   - `DEV_ADMIN_USER_ID` (your Discord user id; right-click name → Copy User ID with Developer Mode on)
   - `OPERATOR_USER_ID` (optional — defaults to `DEV_ADMIN_USER_ID`)
   - `TEST_GUILD_ID` (optional — your test server id; **set this in dev** so command registration is instant)

### Invite URLs

**Guild install** (Add to Server) — replace `YOUR_CLIENT_ID`:

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=3072&scope=bot%20applications.commands
```

**User install** (Add to Account) — `applications.commands` only, no `bot` scope:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&integration_type=1&scope=applications.commands
```

The splash page in `/docs/` builds both URLs from a single `CLIENT_ID` constant at runtime.

---

## // LOCAL DEVELOPMENT

```bash
pnpm install
# Invite the bot to your TEST_GUILD_ID server FIRST. Guild-scoped commands
# need the bot to already be a guild member, otherwise:
#   DiscordAPIError[50001]: Missing Access
pnpm register-commands     # if TEST_GUILD_ID is set, registers there only
pnpm dev                   # tsx watch, auto-loads .env via --env-file-if-exists
```

State lives at `./data/ews.db`; the JSON log lives at `./data/ews.log` (override or disable via `LOG_FILE`).

If `pnpm install` fails to build the `better-sqlite3` native binary:

```bash
pnpm rebuild better-sqlite3
```

(pnpm v10 blocks build scripts by default; this repo's `pnpm.onlyBuiltDependencies` allow-lists it.)

---

## // PERSISTENCE

Local SQLite via `better-sqlite3` at `./data/ews.db` (override with `DATABASE_PATH`). One process, one file — no network, no sidecar service, no auth.

| Table         | Migration                | Purpose                                                                                                                                                                                                                                                       |
| ------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscribers` | `0001_init.sql`          | One row per recipient. `kind ∈ {guild_channel, dm}`, `discord_id` (channel id or user id), status, `subscribed_at`, `last_reminded`. Unique on `(kind, discord_id)`.                                                                                          |
| `seen_alerts` | `0001_init.sql`          | Idempotency boundary. RSS items already dispatched, keyed by `<guid>` (hash fallback when missing). Skipped on every subsequent poll.                                                                                                                         |
| `events`      | `0002_events.sql`        | Durable activity log. One row per meaningful action: `startup`, `shutdown`, `guild_create`, `guild_delete`, `guild_welcome_sent`, `command`, `subscribe`, `unsubscribe`, `dm_in`, `dm_out`, `mention_in`, `mention_out`, `alert_seen`, `alert_dispatch_ok`, `alert_dispatch_fail`, `reminder_ok`, `reminder_fail`, `error`. Indexed by `ts`, `(kind, ts)`, partial indexes on `(user_id, ts)` and `(guild_id, ts)`. |

Migrations are applied on boot — the runner executes every `.sql` file in `migrations/` in lexical order.

If you ever want a managed/synced backend (backups, multi-host, serverless port), [Turso](https://turso.tech) (libSQL) is a small swap: replace `better-sqlite3` with `@libsql/client`, keep the same SQL. Not worth doing for one VPS process.

---

## // OBSERVABILITY

Two parallel telemetry streams. Both matter; both go to the same `data/` volume.

- **`src/log.ts`** — operator-facing structured stream. ANSI-pretty in dev, one JSON line per record in prod, silent in tests. Writes to stdout AND (by default) appends to `./data/ews.log`. Module-scoped via `childLogger("module")`. Set `LOG_LEVEL` (`debug | info | warn | error`); set `LOG_FILE=""` to disable the file sink.
- **`events` table** — durable, queryable record of every action. Inspect from a shell:

  ```bash
  sqlite3 data/ews.db 'SELECT ts, kind, payload FROM events ORDER BY id DESC LIMIT 50;'
  sqlite3 data/ews.db "SELECT payload FROM events WHERE kind='dm_in' ORDER BY id DESC LIMIT 20;"
  ```

`db.recordEvent()` swallows internal errors itself — the activity log can never crash a request path. The logger never writes to disk under `NODE_ENV=test`.

---

## // QUALITY GATES

```bash
pnpm test            # vitest, in-memory SQLite, ~75 tests
pnpm typecheck       # tsc --noEmit, includes test files
pnpm check           # biome lint + format check
pnpm check:fix       # biome lint + format with autofix
pnpm build           # tsc -p tsconfig.build.json → dist/
```

Tests are co-located (`src/foo.test.ts` next to `src/foo.ts`). End-to-end smoke: invite the dev bot to your test server, run `/subscribe`, then `/dev-fire` (from `DEV_ADMIN_USER_ID`) to synthesize an alert without waiting for the real feed.

---

## // DEPLOY

This bot needs a long-running process. **Vercel / Cloudflare Workers / Lambda do not work as-is** — see *Deploying on serverless* below for the trade-off.

### VPS via systemd (primary target)

```bash
adduser --system --group --home /opt/apocalypse-ews ews
git clone <repo> /opt/apocalypse-ews
cd /opt/apocalypse-ews
pnpm install --prod=false
pnpm build
chown -R ews:ews /opt/apocalypse-ews
# .env: copy from .env.example, fill in
cp systemd/ews-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ews-bot
journalctl -u ews-bot -f
```

Re-run `pnpm register-commands` after every change to slash command definitions.

### Docker

```bash
docker build -t apocalypse-ews .
docker run -d --name ews \
  -v ews-data:/app/data \
  --env-file .env \
  --restart unless-stopped \
  apocalypse-ews
```

The `ews-data` volume persists both `data/ews.db` and `data/ews.log` across restarts. Stdout still streams via `docker logs apocalypse-ews`; the file log is the durable copy.

### Fly.io / Railway

Both fit. Fly: `fly launch` against the included Dockerfile, attach a persistent volume at `/app/data`, set secrets with `fly secrets set ...`. Railway: connect the repo, add a volume at `/app/data`, set env in the dashboard.

### Deploying on serverless (Vercel etc.)

Vercel's runtime can't hold a persistent WebSocket. The two ways out:

1. **Drop the gateway and switch to HTTP interactions.** Discord POSTs slash-command payloads to a webhook (Vercel function). Cron jobs handle the RSS poll and the annual reminder. **Cost:** lose `messageCreate` (no DM ping/pong, no @-mention) and `guildCreate` (no auto-welcome on install). Slash commands and outbound alert sending still work. Storage moves to a network DB — Turso or Neon are the natural fits.
2. **Hybrid.** Gateway on a $4/mo VPS, Vercel for nothing in particular. Most pragmatic, but you're already running a server, so why.

Option 1 is a real port: signature-verifying HTTP endpoint, `@libsql/client` for storage, drop the DM and guildCreate handlers. Roughly an afternoon.

---

## // ACKNOWLEDGEMENTS

Upstream EWS by [Kyle McDonald](https://github.com/kylemcdonald/ews). Telegram channel: [@apocalypse_ews](https://t.me/apocalypse_ews). Bundled icon (`assets/ews-icon.jpg`) is the channel avatar, mirrored locally.

```
STANDING BY.
```
