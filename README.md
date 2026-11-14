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
- Slash commands `/subscribe [channel]` `/unsubscribe` `/status` `/help` — guild, DM, private-channel, user-install. In a guild, `/subscribe` and `/unsubscribe` require ManageGuild.
- `@-mention` in a guild channel with the same words (ManageGuild for state changes).
- DM the bot direct: same words, no mention needed.
- No privileged intents required. DMs and direct @mentions work without Message Content Intent. The server invite requests only View Channels and Send Messages, not Administrator.
- Annual reminder: "still subscribed. nothing has ended. go outside."
- Separate Discord webhooks for INFO events (including install / uninstall) and WARN/ERROR notifications. DEBUG stays local.

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

1. <https://discord.com/developers/applications> → New App. Bot tab: Reset Token; leave all **Privileged Gateway Intents** off. DMs and direct @mentions work without Message Content Intent. App ID = `DISCORD_CLIENT_ID`.
2. Installation tab → enable **User Install** (so the bot installs to user accounts, not just guilds). Under **Default Install Settings → Guild Install**, set scopes `applications.commands` + `bot` and permissions View Channel + Send Messages (3072). Without `bot`, Discord's "Add App" adds commands to a server but not the bot, and the bot can never post there.
3. `cp .env.sample .env`, fill `DISCORD_TOKEN` and `DISCORD_CLIENT_ID`. Optional: `INFO_WEBHOOK_URL`, `ERROR_WEBHOOK_URL`, `TEST_GUILD_ID` (set in dev for instant command propagation).
4. Invite the bot to your test server **before** running `register-commands`. Guild-scoped registration requires the bot already in the guild.

If an install says the bot cannot join more servers:

- Open the app's **App Verification** tab in the [Developer Portal](https://discord.com/developers/applications). Discord requires [verification to grow past 100 servers](https://support-dev.discord.com/hc/en-us/articles/23926564536471-How-Do-I-Get-My-App-Verified); complete its checklist, including the owner's identity check if requested.
- When upgrading from a version that requests Message Content Intent, deploy this version **before** turning that toggle off under **Bot → Privileged Gateway Intents**. Turning it off first can prevent the old bot from connecting. Leave Server Members and Presence off too.
- Retry the server install, then check `/status`, a DM, and `@bot status`. Removing privileged intents does not remove the verification requirement. Alerts, slash commands, DMs, and direct @mentions need no privileged intents ([Discord's exceptions](https://docs.discord.com/developers/gateway/you-might-not-need-a-privileged-intent#exceptions-when-you-get-message-content-without-the-privileged-intent)).

For an existing app moving to a Discord team:

- Transfer the existing application to the team rather than creating a new bot. Keep its application ID, installed bot, and database so existing installs and subscriptions stay attached.
- Publish the team's privacy policy and terms at public URLs, then set both URLs in the application's General Information. Link the same pages from the public site once they are available.
- Complete the App Verification checklist as the team owner, including identity verification if requested. Verification and privileged-intent approval are separate. Keep Message Content, Server Members, and Presence off after verification too.

If Message Content Intent is already disabled while the old build is running, deploy the non-privileged build now. The old build can fail its next gateway connection because it still requests that intent.

The privacy policy must reflect actual storage: subscriber IDs and status, server/channel/user metadata, command activity, and DM/direct-mention text are stored in SQLite and local logs. Webhook copies omit message bodies and credentials, but retain diagnostic metadata. Unsubscribing changes subscription status; it does not delete past records. There is no automatic retention or deletion schedule in this code. State the team's actual retention policy and contact/deletion process rather than promising automatic erasure.

## // APP DIRECTORY

Listing in the [App Directory](https://discord.com/application-directory) requires a verified app plus the checklist under **Discovery → Discovery Status** ([Discord's guide](https://docs.discord.com/developers/discovery/enabling-discovery)). The bot token can read the checklist state: `GET /applications/@me` returns `discovery_eligibility_flags` (bits [documented by Userdoccers](https://docs.discord.food/resources/application#application-discovery-eligibility-flags)) and `discoverability_state` (1 means ineligible, 3 means listed).

Status on November 14, 2026: the app was verified, and its description, tags, terms, privacy policy, install parameters, slash commands, and owner MFA all passed. Four items were still missing, and all four need the portal:

- **Support server** (`SUPPORT_GUILD`): set one under **Discovery → Discovery Settings**. Discord recommends a dedicated server or channel for user support.
- **Supported language** (`SUPPORTED_LOCALES`): pick English.
- **Short description** (`SAFE_SHORT_DESCRIPTION`): the summary shown in search, 200 characters at most.
- **Safe commands** (`SAFE_COMMANDS`): not set even though all four commands are plain words. It may update after the rest of the settings are saved. If not, ask [developer support](https://dis.gd/developer-support/discovery).

Then click **Enable Discovery** at the bottom of **Discovery Status**. The listing can take up to 24 hours to appear. Suggested category: Utilities. Tags (set through the API): `apocalypse`, `alerts`, `early warning`, `notifications`, `news`.

Short description:

```text
Private jets leaving cities as an apocalypse early warning. Posts every emergency-level change, 1 to 5, to your server or your DMs.
```

Expanded description (Markdown):

```markdown
**APOCALYPSE EARLY WARNING SYSTEM.**

If something terrible were about to happen, people with private jets would likely leave first. The [Apocalypse EWS](https://ews.kylemcdonald.net) tracks private-aircraft departures from major cities and reports an emergency level from 1 to 5. Most days it is 1.

This app brings that signal to Discord.

**What it does**
- Announces every emergency-level change, rising or falling.
- Sends level 5 incident alerts as they happen.
- Works in server channels or in your DMs.

**Getting started**
- Server: add the app. It posts a welcome note and subscribes that channel. Use `/subscribe #channel` to pick another.
- Personal: add it to your account, then DM the bot `subscribe`.
- `/status` shows the current level. `/unsubscribe` stands down.

Requests only View Channels and Send Messages. No message content access.
```

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

Single command, same one CI runs. Tests use `bun:test`, in-memory sqlite, co-located beside the file under test.

Releases use matching package versions, Git tags, and [GitHub Releases](https://github.com/jamiew/apocalypse-ews-discord/releases), not npm publishing (`private: true`). Before tagging a release, run `bun run ci`, verify a deployed install plus slash/DM/@mention commands, and include any required environment migration in the release notes. Team transfer and verification do not themselves require a new bot version.

## // OBSERVE

```bash
tail -f data/ews.log | jq .
sqlite3 -readonly data/ews.db 'SELECT ts, kind, payload FROM events ORDER BY id DESC LIMIT 20;'
```

Create two incoming webhooks in **Server Settings → Integrations → Webhooks**, choosing a different channel for each. Save their URLs in the deployment's `.env`, then rebuild/restart the bot. Keep the URLs private.

- `INFO_WEBHOOK_URL`: installs/uninstalls, startup/shutdown, and level changes below 4.
- `ERROR_WEBHOOK_URL`: all WARN/ERROR logs, including RSS alerts, level changes reaching 4–5, and poll/delivery failures. Lower-level changes go to INFO. Keep this channel unmuted.
- These replace operator DMs. Remove `OPERATOR_USER_ID` and `DEV_ADMIN_USER_ID` from your configuration. Empty or unset URLs disable their stream without falling back to another destination. Subscriber alerts and commands are unchanged.

Webhooks use severity-colored Discord embeds with an event title, readable details, source, and timestamp. Only INFO and above reach webhooks. Unchanged polls, command/DM/mention activity, subscriptions, and routine heartbeat/reminder work are DEBUG. Set `LOG_LEVEL=debug` to include them in local output; they still never reach webhooks. Durable SQLite event recording is unchanged.

Messages suppress mentions and redact credentials and message bodies. Delivery is best-effort with a five-second timeout, no retries or replay. INFO-webhook failures notify the ERROR destination; ERROR-webhook failures stay local to avoid loops. Shutdown drains pending deliveries. Check the INFO channel after deployment with a test install/uninstall and a restart.

Rejected installs never reach the bot, and a stopped process cannot send warnings. App-verification blocks and full outages still need portal checks or external monitoring.

Server installs and removals are stored as `guild_create` and `guild_delete` events. Installer IDs and names are best-effort: Discord requires **View Audit Log**, which the standard invite does not request. Server-owner details do not identify the installer. Account-only installations are not separately recorded; subsequent commands and subscriptions are logged.

## // DEPLOY

A single long-running container. Vercel / Workers / Lambda don't fit (the gateway is a long-lived WebSocket). `./data` is bind-mounted, so the db and log are readable from the host.

The container starts as root only long enough to hand `./data` to the unprivileged `bun` user, then drops every capability. Compose runs it with a read-only root filesystem and `no-new-privileges`.

Pick one Docker setup per host.

### Rootless Docker (recommended)

The bot needs no host privileges. Under [rootless Docker](https://docs.docker.com/engine/security/rootless/) the daemon and containers run as your user, so a container escape gets your user, not root, and you (or a coding agent) can manage the bot without `sudo` or the `docker` group.

One-time host setup:

```bash
dockerd-rootless-setuptool.sh install   # creates the "rootless" docker context
loginctl enable-linger "$USER"           # start the daemon at boot, not at login
```

First run:

```bash
export DOCKER_CONTEXT=rootless   # or pass --context rootless to each command
cp .env.sample .env && $EDITOR .env
mkdir -p data
docker compose up -d --build
docker compose run --rm register   # after editing slash command defs
docker compose logs -f bot
```

On the host, files in `./data` show up owned by a subordinate UID (the container's `bun` user mapped through `/etc/subuid`, often `100999`). You can still read them: `sqlite3 -readonly` and `tail` work. Write to them through the container: `docker compose exec --user bun bot …`.

Moving an existing rootful deployment over:

```bash
docker --context default compose down    # stop the copy on the root daemon
sudo chown -R "$USER": data              # rootless can't take over root-owned files
DOCKER_CONTEXT=rootless docker compose up -d --build
DOCKER_CONTEXT=rootless docker compose run --rm register
```

### Rootful Docker

The same first-run commands without `DOCKER_CONTEXT`. Running Docker this way needs root or the `docker` group, which is root-equivalent. `./data` ends up owned by uid 1000 on the host (the container's `bun` user).

## // PAGES

GitHub Pages serves `/docs/` from `main`. The two static install links in `docs/index.html` must use the same Discord application ID.

The site links to a [privacy policy](https://jamiew.github.io/apocalypse-ews-discord/privacy.html) and [terms of use](https://jamiew.github.io/apocalypse-ews-discord/terms.html). Keep these pages current when data handling changes. The bot stores DM and mention text, commands, Discord IDs, and install details; unsubscribing does not delete old records.

Keep `docs/llms.txt` aligned with the homepage. It is an optional guide for AI readers; [Google does not require it](https://developers.google.com/search/docs/appearance/ai-features). `docs/sitemap.xml` lists the three canonical pages; submit its published URL in Search Console. The share image is `docs/social-card.png` (1200×630), using the existing app icon. This site lives below `/apocalypse-ews-discord/`, so a `docs/robots.txt` would not control crawlers.

## // REDEPLOY

Every subsequent push gets shipped with the same script, from your laptop:

```bash
cp .deploy.env.example .deploy.env   # one time
$EDITOR .deploy.env                   # set host / user / path
./deploy.sh
```

Configure once in `.deploy.env` (gitignored via the `.env.*` rule):

| var                     | required | default  | purpose                                         |
|-------------------------|----------|----------|-------------------------------------------------|
| `DEPLOY_HOST`           | yes      | —        | SSH host (e.g. `ews.example.com`)               |
| `DEPLOY_USER`           | yes      | —        | SSH user                                        |
| `DEPLOY_PATH`           | yes      | —        | absolute path to the checkout on host           |
| `DEPLOY_BRANCH`         | no       | `main`   | branch to deploy                                |
| `DEPLOY_REMOTE`         | no       | `origin` | git remote to fetch from                        |
| `DEPLOY_SSH_PORT`       | no       | `22`     | non-standard SSH port                           |
| `DEPLOY_SSH_OPTS`       | no       | —        | extra ssh flags (e.g. `-i <keyfile>`)           |
| `DEPLOY_DOCKER_CONTEXT` | no       | —        | remote docker context; `rootless` for rootless  |

What it does, in one SSH session on the remote:

1. `git fetch --prune ${DEPLOY_REMOTE}` and `git reset --hard ${DEPLOY_REMOTE}/${DEPLOY_BRANCH}` — clean slate, no merge surprises.
2. `docker compose build --pull` — refresh the pinned `oven/bun:1.4.4-debian` base. Bun carries its own root CAs, so bump the pin deliberately when Bun ships a trust-store fix.
3. `docker compose up -d --build --force-recreate` — rebuild the image with new source and replace the container even when the image hash is unchanged (catches `.env`-only changes too).
4. `docker compose run --rm register` — re-register slash commands. Idempotent, runs every time.
5. `docker image prune -f` — reclaim space from the now-dangling old image.
6. `docker compose ps` and last 30 `bot` log lines.

Aborts on the remote if `.env` is missing (so the bot doesn't silently fail to boot post-deploy). Warns locally before SSHing if your `HEAD` differs from `${DEPLOY_REMOTE}/${DEPLOY_BRANCH}` — you deploy what's pushed, not your working copy.

Stream the bot afterwards (add `--context rootless` on a rootless host):

```bash
ssh $DEPLOY_USER@$DEPLOY_HOST "cd $DEPLOY_PATH && docker compose logs -f bot"
```

## // SYNC

Pull prod state (db + log) to your laptop for analysis or backup. Safe while the bot is running — the db is snapshotted via `VACUUM INTO` inside the container before transfer, so the WAL stays consistent.

This is a manual snapshot, not a scheduled or versioned backup. Reusing a destination replaces its previous database and log. The database includes install/removal events, subscriptions, and recorded activity; the text log is copied separately. Use this snapshot method when automating backups rather than copying live SQLite files with rsync alone.

```bash
./scripts/sync-from-prod.sh            # → ./data-prod/
./scripts/sync-from-prod.sh ./snap-1   # custom dest
```

Uses the same `.deploy.env` as `deploy.sh`, including `DEPLOY_DOCKER_CONTEXT`. The snapshot runs inside the container as `bun`. The default destination matches the `data-*/` gitignore rule so synced data can't accidentally land in a commit. Inspect with:

```bash
sqlite3 -readonly data-prod/ews.db 'SELECT kind, count(*) FROM events GROUP BY kind ORDER BY 2 DESC;'
tail -f data-prod/ews.log | jq .
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
