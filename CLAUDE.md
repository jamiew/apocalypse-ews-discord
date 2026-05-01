# CLAUDE.md

Project-specific notes for Claude Code working on this repo. Read these before changing code.

## What this is

A Discord bot for the [Apocalypse Early Warning System](https://ews.kylemcdonald.net). One job: when the RSS feed at `https://ews.kylemcdonald.net/rss.xml` shows a new emergency-level-5 alert, fan it out to subscribed Discord channels and DM users. Plus an annual "you're still subscribed" reminder.

The Telegram channel [@apocalypse_ews](https://t.me/apocalypse_ews) does the same job for Telegram. We are deliberately a Discord-only mirror of that.

## Architecture

Single long-running Node.js process. **The Discord gateway is a persistent WebSocket — this is not a serverless app.** See README "Deploying on serverless" for the trade-offs if anyone proposes Vercel/Workers/Lambda.

```
src/index.ts                boot: db, discord client, two crons (poll, reminders)
src/discord.ts              gateway client, slash commands, DM handler, alert fan-out, event recording
src/poller.ts               fetch RSS (zod-validated), diff seen_alerts by <guid>, dispatch
src/reminders.ts            daily cron handler — annual reminder
src/db.ts                   better-sqlite3 wrapper; EventKind union; recordEvent
src/copy.ts                 ALL user-facing strings
src/env.ts                  zod-validated env
src/log.ts                  tiny zero-dep structured logger (stdout + ./data/ews.log)
migrations/0001_init.sql    schema (subscribers, seen_alerts)
migrations/0002_events.sql  events table
```

Three tables:
- `subscribers` — `kind ∈ {guild_channel, dm}`, `discord_id` (channel id or user id), status, `subscribed_at`, `last_reminded`. Unique on `(kind, discord_id)`.
- `seen_alerts` — keyed by RSS `<guid>` (or a hash fallback when guid is missing).
- `events` — durable activity log keyed by an `EventKind` union (closed set). Every meaningful action records one row; payloads are JSON-encoded with an Error-aware replacer. **When adding a new `recordEvent` callsite, always extend `EventKind` first** so a typo is a type error.

The canonical projection from a `SeenAlert` row to the display-time `LastAlert` shape is `db.lastAlertForDisplay()`. If you find yourself reconstructing `{ title, pubDate }` from a `SeenAlert` in a caller, use that instead.

## Boundaries: validate unknown data with Zod

Anything entering the process from outside its own code is "unknown" at runtime, regardless of TypeScript types. Validate at the boundary, before the data hits any business logic:

- `src/env.ts` — `process.env` parsed by a Zod schema; boot fails loudly on missing/malformed env.
- `src/poller.ts` — the rss-parser return value is parsed by `RssFeed` (a `z.object({...}).loose()`). rss-parser's TS types are compile-time only; the actual XML can be anything.
- **Any new HTTP fetch, JSON.parse, or webhook body** must follow the same pattern: declare a Zod schema, call `.parse(...)` (throws) or `.safeParse(...)` (branch), and only then operate on the typed result. Don't `as Type`-cast unknown values into shape.

Discord.js interaction objects already provide their own validated TS types — no Zod needed there. SQLite rows are typed by the `prepare<Bind, Result>` generics; the migration is the contract.

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
- **Lint + format:** Biome 2.4 (single tool). Tabs, line width 100. Config in `biome.json`. Strict rules: `noNonNullAssertion`, `useImportType`, `noExplicitAny`, `noUnusedVariables`, `noUnusedImports` are all `error`. Scripts: `pnpm check` (read-only), `pnpm check:fix` (autofix). VS Code auto-formats on save via `.vscode/settings.json` (committed).
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

## Logging & events

Two parallel streams; both matter.

- **`src/log.ts`** — operator-facing structured stream. ANSI-pretty in dev, one JSON line per record in prod, silent in tests. Writes to stdout and (by default) appends to `./data/ews.log`. Module-scoped via `childLogger("module-name")`. Call shape is `log.info(message, context?)` — message first, then a structured bag.
- **`db.events` table** — durable activity log. `db.recordEvent({ kind, guildId?, channelId?, userId?, payload? })` from anywhere; `EventKind` is a closed union. `recordEvent` swallows internal errors itself, never crashes the request path. Inspect with `sqlite3 data/ews.db 'SELECT ts, kind, payload FROM events ORDER BY id DESC LIMIT 50;'`.

Rule of thumb: anything an operator might want to grep at 3am goes in `log`; anything you might want to query historically goes in `events`. Most user-facing actions deserve both.

## Test conventions

Per global `~/.claude/CLAUDE.md`:
- **No `if` statements in vitest tests.** Use vitest's `assert(value)` (imported from `vitest`) for narrowing instead.
- **No non-null assertions (`!.`).** Biome enforces this; use `assert(value)` or extract a tiny helper (see `subId(...)` in `db.test.ts`).
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
- If you add a new request path or handler, **record an event for it**. Add the kind to the `EventKind` union in `src/db.ts` first, then `db.recordEvent({...})` at the action site. Both success and failure deserve their own kinds (e.g. `*_ok` / `*_fail`).
- If you add a new external data source (HTTP fetch, webhook, JSON file), declare a Zod schema for it in the same module and parse the response before using it. Don't `as`-cast unknown data.
