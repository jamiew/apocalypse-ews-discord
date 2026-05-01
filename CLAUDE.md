# CLAUDE.md

Project-specific notes for Claude Code working on this repo. Read these before changing code.

## What this is

A Discord bot for the [Apocalypse Early Warning System](https://ews.kylemcdonald.net). One job: when the RSS feed at `https://ews.kylemcdonald.net/rss.xml` shows a new emergency-level-5 alert, fan it out to subscribed Discord channels and DM users. Plus an annual "you're still subscribed" reminder.

The Telegram channel [@apocalypse_ews](https://t.me/apocalypse_ews) does the same job for Telegram. We are deliberately a Discord-only mirror of that.

## Architecture

Single long-running Node.js process. **The Discord gateway is a persistent WebSocket — this is not a serverless app.** See README "Deploying on serverless" for the trade-offs if anyone proposes Vercel/Workers/Lambda.

```
src/index.ts           boot: db, discord client, two crons (poll, reminders)
src/discord.ts         gateway client, slash commands, DM handler, alert fan-out
src/poller.ts          fetch RSS, diff seen_alerts by <guid>, dispatch new
src/reminders.ts       daily cron handler — annual reminder
src/db.ts              better-sqlite3 wrapper, prepared statements
src/copy.ts            ALL user-facing strings
src/env.ts             zod-validated env
migrations/0001_init.sql   schema (subscribers, seen_alerts)
```

Two tables:
- `subscribers` — `kind ∈ {guild_channel, dm}`, `discord_id` (channel id or user id), status, `subscribed_at`, `last_reminded`. Unique on `(kind, discord_id)`.
- `seen_alerts` — keyed by RSS `<guid>` (or a hash fallback when guid is missing).

The canonical projection from a `SeenAlert` row to the display-time `LastAlert` shape is `db.lastAlertForDisplay()`. If you find yourself reconstructing `{ title, pubDate }` from a `SeenAlert` in a caller, use that instead.

## Tone of voice (rules for editing copy.ts)

The website and Telegram channel are **deadpan, technical, no emojis, no exclamation points, short declarative sentences.** Wryness comes from the framing — calling tracked-jet-anomaly monitoring an "apocalypse early warning system" — never from the prose.

Source phrases worth preserving:
- *"Local dashboard for monitoring tracked-aircraft anomaly signals over a rolling 24-hour window."*
- *"Emergency level 5 alerts from the Apocalypse Early Warning System."*
- *"Automatic updates about unusual private jet activity."*

Don't add 🚨, ⚠️, "🔴 ALERT", or anything chipper. If a string would feel out of place on the source website, it's wrong.

`copy.test.ts` has a "tone guard" suite that fails on exclamation points or emoji in user-facing strings, and on missing source-URL/uninstall hints in the welcome. Don't disable those tests; if you genuinely need to change the rule, change the test alongside the code.

## Out of scope (don't add without being asked)

The original ask included SMS, iMessage, email, WhatsApp, Slack, Mastodon, Bluesky. **The user explicitly chose Discord-only to keep this clean and simple.** Don't reintroduce them. If a request makes one of these necessary, ask first.

Also out of scope: a web admin UI, metrics dashboard, multi-tenant config, anything beyond `seen_alerts` + `subscribers`.

## Tooling

- **Package manager:** pnpm (per global preferences). pnpm v10 blocks native build scripts; `package.json` allow-lists `better-sqlite3` via `pnpm.onlyBuiltDependencies`.
- **Lint + format:** Biome 2.4 (single tool). Config in `biome.json`. Scripts: `pnpm check` (read-only), `pnpm check:fix` (autofix).
- **Typecheck:** `pnpm typecheck` runs `tsc --noEmit` against `tsconfig.json` which **includes test files**. `pnpm build` uses `tsconfig.build.json` which excludes tests from `dist/`.
- **Tests:** Vitest, in-memory SQLite for the DB suite, mock Discord client for the reminders suite.

Pre-commit checklist:

```bash
pnpm check && pnpm typecheck && pnpm test && pnpm build
```

## Native module gotcha

`better-sqlite3` is a native module. If `pnpm install` fails to build it, run `pnpm rebuild better-sqlite3` (sandbox may need to be off for the gyp build to write to `~/Library/Caches/node-gyp/`). The compiled binary lives at `node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node`.

## Discord-specific gotchas

- **Message Content Intent** must be enabled in the Developer Portal for DM ping/pong to work — gateway-only feature.
- **Partials** `[Channel, Message]` are required so `messageCreate` fires for DMs the bot wasn't cached for.
- **Global slash commands** take up to ~1 hour to propagate. For dev iteration, switch `Routes.applicationCommands(clientId)` to `Routes.applicationGuildCommands(clientId, guildId)` in `src/discord.ts` — guild commands are instant.
- The hidden `/dev-fire` command is gated by env `DEV_ADMIN_USER_ID`; without it, the command replies "Not authorized."

## Test conventions

Per global `~/.claude/CLAUDE.md`:
- **No `if` statements in vitest tests.** Use vitest's `assert(value)` (imported from `vitest`) for narrowing instead.
- Co-locate: `src/foo.test.ts` next to `src/foo.ts`.
- `describe` blocks are usually named after the function or class under test.
- Don't construct full discord.js fixtures — extract a pure helper and test that. See `pickWelcomeChannelFrom` for the pattern.

## Things that cost a lot of debugging if missed

- The `seen_alerts` table is an idempotency boundary. If the bot is restarted mid-fan-out, items already recorded are skipped on the next poll — they will not re-deliver. The trade-off favors not double-paging users; revisit if a real alert is ever missed.
- `lastBuildDate` in the EWS feed is currently `Thu, 01 Jan 1970 00:00:00 GMT` and `<item>`s are absent. Don't treat the empty feed as a bug. Test against a synthetic feed instead.
- `cron` strings in env (`POLL_CRON`, `REMINDER_CRON`) are validated by `node-cron` at runtime, not by zod — typos crash on first tick, not on boot.

## When making changes

- If you change slash command definitions in `src/discord.ts`, the user must run `pnpm register-commands` after deploying. Mention this in your end-of-turn summary.
- If you add a new dependency that ships a native module, add it to `pnpm.onlyBuiltDependencies` in `package.json`.
- If you touch `copy.ts`, re-read the tone rules above. The bar is "would this feel out of place on the source website."
