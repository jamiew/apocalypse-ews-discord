# Apocalypse EWS — Discord bot

Discord bot for the [Apocalypse Early Warning System](https://ews.kylemcdonald.net) ([source](https://github.com/kylemcdonald/ews)). Mirrors the existing [Telegram channel](https://t.me/apocalypse_ews) — when the system reaches emergency level 5, the bot posts an alert to subscribed channels and DMs.

Tone is deadpan and technical, replicating the website. All user-facing strings live in `src/copy.ts`.

## What it does

- Polls `https://ews.kylemcdonald.net/rss.xml` every 30 minutes.
- New `<item>`s fan out to every subscribed Discord channel and DM user.
- Slash commands in servers: `/subscribe [channel]`, `/unsubscribe`, `/status`, `/help`.
- 1:1 DM ping/pong: any message from a never-subscribed user gets the opt-in prompt; `subscribe`/`unsubscribe` keywords toggle state; anything else gets a "still here" reply with the last alert on record.
- Once a year, every active subscriber gets a reminder that they are still subscribed and an invitation to enjoy their lives.
- Hidden `/dev-fire` admin command (gated by `DEV_ADMIN_USER_ID`) synthesizes an alert event for end-to-end testing.

## Stack

TypeScript + Node 20+, pnpm, [discord.js](https://discord.js.org), [rss-parser](https://www.npmjs.com/package/rss-parser), [better-sqlite3](https://www.npmjs.com/package/better-sqlite3), [node-cron](https://www.npmjs.com/package/node-cron), [zod](https://zod.dev). Biome for lint + format. Vitest for tests.

The bot needs a persistent process — Discord's gateway is a long-lived WebSocket. SQLite lives on local disk.

## Setting up the Discord app

1. Go to <https://discord.com/developers/applications> and create a new application. Name it whatever you want.
2. **Bot tab** → Add Bot → copy the **Token**. Under "Privileged Gateway Intents", enable **Message Content Intent** (required for DM ping/pong).
3. **General Information tab** → copy the **Application ID** (this is `DISCORD_CLIENT_ID`).
4. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`.
5. Build an OAuth2 invite URL with scopes `bot` + `applications.commands` and these bot permissions: View Channels (1024), Send Messages (2048). Replace `YOUR_CLIENT_ID`:

   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=3072&scope=bot%20applications.commands
   ```

6. After deployment, run once: `pnpm register-commands`. Global slash commands take up to ~1 hour to propagate. For dev, set `TEST_GUILD_ID=<your test server id>` in `.env` — the script will register guild-scoped commands instead, which appear instantly. Unset (or leave empty) for global registration in prod.

## Database

Local **SQLite** via `better-sqlite3` (single file at `./data/ews.db`, configurable via `DATABASE_PATH`). One process, one file — no network, no service to operate, no auth.

Three tables:

- `subscribers` — one row per Discord channel or DM user, `kind ∈ {guild_channel, dm}`, status, `subscribed_at`, `last_reminded`. Migration: `migrations/0001_init.sql`.
- `seen_alerts` — RSS items already dispatched, deduped by `<guid>`. Migration: `migrations/0001_init.sql`.
- `events` — durable activity log. Every meaningful action records one row: `startup`, `shutdown`, `guild_create`, `guild_delete`, `guild_welcome_sent`, `command`, `subscribe`, `unsubscribe`, `dm_in`, `dm_out`, `alert_seen`, `alert_dispatch_ok`, `alert_dispatch_fail`, `reminder_ok`, `reminder_fail`, `error`. Indexed by `ts`, `(kind, ts)`, and partial indexes on `(user_id, ts)` and `(guild_id, ts)`. Migration: `migrations/0002_events.sql`.

The migration runner executes every `.sql` file in `migrations/` in lexical order on boot.

If you ever want this on a managed/synced database (e.g. for backups, multi-host, or a serverless port), swapping in [Turso](https://turso.tech) (libSQL) is a small change: replace `better-sqlite3` with `@libsql/client`, keep the same SQL. Not worth doing for a single VPS process.

## Logging & observability

Two kinds of records:

- **Structured stdout/file logs** (operator stream). `src/log.ts` is a tiny zero-dep logger: ANSI-pretty in dev, one JSON line per record in prod, silent in tests. Defaults to writing one JSON line per record to `./data/ews.log` in addition to stdout. Set `LOG_FILE=""` to disable file output, `LOG_FILE=/path` to point elsewhere. Set `LOG_LEVEL` (`debug | info | warn | error`).
- **`events` table** (durable, queryable). A row per meaningful action — including raw DM contents and outbound replies — for after-the-fact debugging. Query directly with `sqlite3 data/ews.db 'SELECT ts, kind, payload FROM events ORDER BY id DESC LIMIT 50;'`.

The logger never writes a file in `NODE_ENV=test`, and `recordEvent` swallows internal errors (a broken events table must not crash a request).

## Local development

```bash
pnpm install
pnpm register-commands   # one-shot: registers global slash commands
pnpm dev                 # starts the bot under tsx watch
```

`pnpm dev` boots the bot. SQLite state lives at `./data/ews.db` by default.

If `pnpm install` fails to build the native `better-sqlite3` binary, run:

```bash
pnpm rebuild better-sqlite3
```

(`pnpm v10` blocks build scripts by default; this repo's `pnpm.onlyBuiltDependencies` allow-lists `better-sqlite3`.)

## Testing & quality

```bash
pnpm test            # vitest (in-memory SQLite)
pnpm typecheck       # tsc --noEmit, includes test files
pnpm check           # biome lint + format check
pnpm check:fix       # biome lint + format with autofix
pnpm build           # tsc → dist/
```

Tests are co-located (`src/foo.test.ts` beside `src/foo.ts`). Vitest uses an in-memory database so tests are isolated and fast. End-to-end: invite the dev bot to a personal test server, run `/subscribe`, then run `/dev-fire` (from the user id you set as `DEV_ADMIN_USER_ID`) to synthesize an alert without waiting for a real level-5 event.

## Deploying

This bot needs a long-running process. Vercel/Cloudflare-Workers/Lambda **do not work as-is** because the Discord gateway is a persistent WebSocket — see `Deploying on serverless` below for the trade-offs.

### VPS via systemd (recommended)

```bash
# on the server, as root or with sudo
adduser --system --group --home /opt/apocalypse-ews ews
git clone <repo> /opt/apocalypse-ews
cd /opt/apocalypse-ews
pnpm install --prod=false
pnpm build
chown -R ews:ews /opt/apocalypse-ews
# copy .env.example to .env and fill in
cp systemd/ews-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now ews-bot
journalctl -u ews-bot -f
```

Run `pnpm register-commands` once after deploying any change to slash command definitions.

### Docker

```bash
docker build -t apocalypse-ews .
docker run -d --name ews \
  -v ews-data:/app/data \
  --env-file .env \
  --restart unless-stopped \
  apocalypse-ews
```

Volume `ews-data` persists both `data/ews.db` and `data/ews.log` across container restarts. Stdout still streams via `docker logs apocalypse-ews`; the file log is the durable copy.

### Fly.io / Railway

Both fit. Fly: `fly launch` against the included `Dockerfile`, attach a persistent volume mounted at `/app/data`, set secrets with `fly secrets set ...`. Railway: connect the repo, add a volume mounted at `/app/data`, set env vars in the dashboard.

### Deploying on serverless (Vercel etc.)

Vercel's runtime can't hold a persistent WebSocket, so this bot won't run on it as written. The two ways out:

1. **Drop the gateway and switch to HTTP interactions.** Discord can POST slash-command interactions to a webhook (Vercel function). Cron jobs handle the RSS poll and the annual reminder. **Cost:** lose `messageCreate` (no DM ping/pong) and `guildCreate` (no auto-welcome on install). Slash commands and outbound alert sending still work. Storage moves to a network DB — Turso or Neon are good fits.
2. **Hybrid.** Run the gateway part on a $4/mo VPS (or Fly free tier), keep Vercel for nothing here. Most pragmatic, but you're already running a server.

If you want option 1, this needs a real port: replace the gateway client with a signature-verifying HTTP endpoint, swap `better-sqlite3` for `@libsql/client` (Turso), drop the DM and guildCreate handlers. Probably an afternoon. Ask and I'll do it.

## Layout

```
assets/
  ews-icon.jpg    # bundled radiation-symbol icon — reuse for bot avatar, embed thumbnails, etc.
src/
  index.ts        # boot: db, discord client, crons
  discord.ts      # client, commands, DM handler, fan-out, event recording
  poller.ts       # RSS fetch (zod-validated) + dedup
  reminders.ts    # annual reminder cron handler
  db.ts           # better-sqlite3 wrapper, EventKind, recordEvent
  copy.ts         # all user-facing strings
  env.ts          # zod-validated env
  log.ts          # tiny zero-dep structured logger (stdout + file)
  scripts/
    register-commands.ts
migrations/
  0001_init.sql   # subscribers, seen_alerts
  0002_events.sql # durable activity log
systemd/
  ews-bot.service
.vscode/
  settings.json   # format-on-save with Biome
  extensions.json # recommend the Biome extension
Dockerfile
biome.json             # tabs, lineWidth 100, strict rules
tsconfig.json          # for typechecking (includes tests)
tsconfig.build.json    # for `pnpm build` (excludes tests)
```
