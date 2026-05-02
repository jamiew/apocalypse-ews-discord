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

## // PAGES

Static splash at `/docs/`. GitHub → Settings → Pages → `main` / `/docs`. The install buttons read a single `CLIENT_ID` constant in `docs/index.html`.

## // REDEPLOY

Every subsequent push gets shipped with the same script, from your laptop:

```bash
cp .deploy.env.example .deploy.env   # one time
$EDITOR .deploy.env                   # set host / user / path
./deploy.sh
```

Configure once in `.deploy.env` (gitignored via the `.env.*` rule):

| var               | required | default  | purpose                                |
|-------------------|----------|----------|----------------------------------------|
| `DEPLOY_HOST`     | yes      | —        | SSH host (e.g. `ews.example.com`)      |
| `DEPLOY_USER`     | yes      | —        | SSH user                               |
| `DEPLOY_PATH`     | yes      | —        | absolute path to the checkout on host  |
| `DEPLOY_BRANCH`   | no       | `main`   | branch to deploy                       |
| `DEPLOY_REMOTE`   | no       | `origin` | git remote to fetch from               |
| `DEPLOY_SSH_PORT` | no       | `22`     | non-standard SSH port                  |
| `DEPLOY_SSH_OPTS` | no       | —        | extra ssh flags (e.g. `-i <keyfile>`)  |

What it does, in one SSH session on the remote:

1. `git fetch --prune ${DEPLOY_REMOTE}` and `git reset --hard ${DEPLOY_REMOTE}/${DEPLOY_BRANCH}` — clean slate, no merge surprises.
2. `docker compose build --pull` — refresh the `oven/bun:1-debian` base.
3. `docker compose up -d --build --force-recreate` — rebuild the image with new source and replace the container even when the image hash is unchanged (catches `.env`-only changes too).
4. `docker compose run --rm register` — re-register slash commands. Idempotent, runs every time.
5. `docker image prune -f` — reclaim space from the now-dangling old image.
6. `docker compose ps` and last 30 `bot` log lines.

Aborts on the remote if `.env` is missing (so the bot doesn't silently fail to boot post-deploy). Warns locally before SSHing if your `HEAD` differs from `${DEPLOY_REMOTE}/${DEPLOY_BRANCH}` — you deploy what's pushed, not your working copy.

Stream the bot afterwards:

```bash
ssh $DEPLOY_USER@$DEPLOY_HOST "cd $DEPLOY_PATH && docker compose logs -f bot"
```

## // CREDITS

- **Kyle McDonald** — creator of the upstream [Apocalypse Early Warning System](https://github.com/kylemcdonald/ews). This bot is a thin Discord adapter; the signal is his.
- **Jamie Dubs** ([@jamiew](https://github.com/jamiew)) — author of this bot.

```
███████╗ █████╗ ████████╗    ██╗      █████╗ ██████╗
██╔════╝██╔══██╗╚══██╔══╝    ██║     ██╔══██╗██╔══██╗
█████╗  ███████║   ██║       ██║     ███████║██████╔╝
██╔══╝  ██╔══██║   ██║       ██║     ██╔══██║██╔══██╗
██║     ██║  ██║   ██║       ███████╗██║  ██║██████╔╝
╚═╝     ╚═╝  ╚═╝   ╚═╝       ╚══════╝╚═╝  ╚═╝╚═════╝
                    ____
                   / __/___  ________ _   _____  _____
                  / /_/ __ \/ ___/ _ \ | / / _ \/ ___/
                 / __/ /_/ / /  /  __/ |/ /  __/ /
                /_/  \____/_/   \___/|___/\___/_/
```

---

```
ACK. STANDING BY.
```
