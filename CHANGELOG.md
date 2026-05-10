# Changelog

## 2026-05-09

### Features

- Heartbeat broadcast: every 6–10 days (jittered) the bot pings subscribed guild channels with a "STANDING BY. Nothing to report." note so operators know it's alive. Suppressed for 24h after any real level change so heartbeats don't follow alerts. Guild channels only — DM subscribers are not pinged.

### Robustness

- `guildCreate` now distinguishes _no postable channel_, `DiscordAPIError[50001]` Missing Access, and other failures, recording a `guild_welcome_failed` event for each and DMing the operator. Previously a single catch-all log line.
- Replaced the deprecated `ephemeral: true` with `flags: MessageFlags.Ephemeral` (7 sites) so docker logs stop emitting a stack trace on every interaction.

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
