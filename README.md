```
 ████████████████████████████████
 █  APOCALYPSE.EWS // DISCORD  █▓
 █  CONDITION NORMAL: SILENT   █▓▒
 ████████████████████████████████▓▒░
  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░
   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

Discord bot for the [Apocalypse Early Warning System](https://ews.kylemcdonald.net) ([source](https://github.com/kylemcdonald/ews)). Tracked-aircraft anomalies over a rolling 24h. Level 5 → announced. Otherwise silent.

## // CAPABILITIES

- Polls `ews.kylemcdonald.net/rss.xml` every 30 min. Dedup by `<guid>`.
- Slash commands `/subscribe [channel]` `/unsubscribe` `/status` `/help` — guild, DM, private-channel, user-install.
- @-mention in a guild channel: same words, same effect (ManageGuild for state changes).
- DM the bot direct: same words, no mention needed.
- Annual reminder: "still subscribed. nothing has ended. go outside."
- Operator (`OPERATOR_USER_ID`, falls back to `DEV_ADMIN_USER_ID`) DM'd on install / subscribe / unsubscribe.
- Hidden `/dev-fire` (gated by `DEV_ADMIN_USER_ID`) synthesizes a level 5 for testing.

## // SUBSYSTEMS

TS + Node 22+. discord.js, rss-parser, better-sqlite3, node-cron, zod. Biome. Vitest.

```
src/  index boot · discord gateway+commands · poller ingest · reminders cron
      db state · copy voice · env config · log telemetry
migrations/  0001 subscribers+seen_alerts · 0002 events
docs/  Pages splash · assets/  icon · systemd/  unit · Dockerfile
```

Three tables: `subscribers`, `seen_alerts`, `events`. Migrations apply in lex order on boot.

## // INITIALIZE

1. <https://discord.com/developers/applications> → New App. Bot tab: Reset Token; enable **Message Content Intent**. App ID = `DISCORD_CLIENT_ID`.
2. Installation tab → enable **User Install** (so the bot's installable to user accounts, not just guilds).
3. `cp .env.example .env`, fill `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DEV_ADMIN_USER_ID`. Optional: `OPERATOR_USER_ID`, `TEST_GUILD_ID` (set in dev — instant command propagation).
4. Invite the bot to your test server **before** running `register-commands`. Guild-scoped registration requires the bot already in the guild.

## // RUN

```bash
pnpm install
pnpm register-commands
pnpm dev
```

If the `better-sqlite3` native binding fails: `pnpm rebuild better-sqlite3`.

## // QUALITY GATES

```bash
pnpm check && pnpm typecheck && pnpm test && pnpm build
```

All four green before commit. Vitest is in-memory; ~75 tests; co-located.

## // OBSERVE

- `data/ews.log` — one JSON line per record. Pipe through `jq`.
- `data/ews.db` `events` table — durable activity log; one row per meaningful action (`startup` `command` `subscribe` `dm_in` `alert_dispatch_ok` …).

```bash
sqlite3 data/ews.db 'SELECT ts, kind, payload FROM events ORDER BY id DESC LIMIT 20;'
```

## // DEPLOY

VPS via the included `systemd/ews-bot.service` unit. Or `compose.yaml`:

```bash
cp .env.example .env && $EDITOR .env
mkdir -p data
docker compose up -d --build
docker compose run --rm register   # after editing slash command defs
docker compose logs -f bot
```

`./data` is bind-mounted from the host — `data/ews.db` and `data/ews.log` are inspectable directly with `sqlite3` and `tail -f`. Stdout still streams via `docker compose logs`.

Vercel / Workers / Lambda don't fit — the gateway is a long-lived WebSocket. HTTP-interactions port is possible (Turso/Neon for storage, lose DM ping/pong + auto-welcome).

## // PAGES

Static splash at `/docs/`. GitHub → Settings → Pages → `main` / `/docs`. Replace `YOUR_DISCORD_CLIENT_ID` in `docs/index.html` and the install buttons wire themselves up.

---

```
ACK. STANDING BY.
```
