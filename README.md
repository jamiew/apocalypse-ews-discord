```
 ████████████████████████████████
 █  APOCALYPSE.EWS // DISCORD  █▓
 █  CONDITION NORMAL: SILENT   █▓▒
 ████████████████████████████████▓▒░
  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░
   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

Discord bot for the [Apocalypse Early Warning System](https://ews.kylemcdonald.net) ([source](https://github.com/kylemcdonald/ews)). Tracked-aircraft anomalies over a rolling 24h. Every emergency-level transition announced — increasing urgency as it climbs.

## // CAPABILITIES

- Polls the upstream RSS (`/rss.xml`, level-5 incidents) and the upstream dashboard JSON (`current.emergencyLevel` 1..5) every 30 min.
- Announces every level transition. `Notice → ELEVATED → WARNING → ATTENTION` rising; `Stand-down` falling.
- Slash commands `/subscribe [channel]` `/unsubscribe` `/status` `/help` — guild, DM, private-channel, user-install.
- `@-mention` in a guild channel with the same words (ManageGuild for state changes).
- DM the bot direct: same words, no mention needed.
- Annual reminder: "still subscribed. nothing has ended. go outside."
- Operator (`OPERATOR_USER_ID`, falls back to `DEV_ADMIN_USER_ID`) DM'd on install / subscribe / unsubscribe.
- Hidden `/dev-fire` (gated by `DEV_ADMIN_USER_ID`) synthesizes a level 5 for testing.

## // STACK

- bun
- discord.js
- rss-parser
- node-cron
- zod
- bun:sqlite
- biome for lint+format
- bun:test for tests

## // INITIALIZE

1. <https://discord.com/developers/applications> → New App. Bot tab: Reset Token; enable **Message Content Intent**. App ID = `DISCORD_CLIENT_ID`.
2. Installation tab → enable **User Install** (so the bot installs to user accounts, not just guilds).
3. `cp .env.example .env`, fill `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `DEV_ADMIN_USER_ID`. Optional: `OPERATOR_USER_ID`, `TEST_GUILD_ID` (set in dev — instant command propagation).
4. Invite the bot to your test server **before** running `register-commands`. Guild-scoped registration requires the bot already in the guild.

## // RUN

```bash
bun install
bun run register-commands
bun run dev
```

State on disk: `./data/ews.db` (sqlite) + `./data/ews.log` (json lines).

## // QUALITY GATES

```bash
bun run ci   # biome ci . && tsc --noEmit && bun test src
```

Single command, same one CI runs. ~100 tests under `bun:test`, in-memory sqlite, co-located beside the file under test.

## // OBSERVE

```bash
tail -f data/ews.log | jq .
sqlite3 data/ews.db 'SELECT ts, kind, payload FROM events ORDER BY id DESC LIMIT 20;'
```

## // DEPLOY

First-time, on the host:

```bash
cp .env.example .env && $EDITOR .env
mkdir -p data
docker compose up -d --build
docker compose run --rm register   # after editing slash command defs
docker compose logs -f bot
```

`./data` is bind-mounted — db and log are inspectable from the host. Vercel / Workers / Lambda don't fit (the gateway is a long-lived WebSocket).

Subsequent deploys, from your laptop:

```bash
cp .deploy.env.example .deploy.env && $EDITOR .deploy.env
./deploy.sh
```

`deploy.sh` SSHes once: `git fetch + reset --hard`, `docker compose build --pull`, `up -d --build --force-recreate`, re-registers slash commands, prunes stale images, prints status + tail. Same script, every time.

## // PAGES

Static splash at `/docs/`. GitHub → Settings → Pages → `main` / `/docs`. The install buttons read a single `CLIENT_ID` constant in `docs/index.html`.

---

```
ACK. STANDING BY.
```
