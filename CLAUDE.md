```
 ████████████████████████████████
 █  CLAUDE.OPERATING.DOCTRINE  █▓
 █  STANDING ORDERS // READ    █▓▒
 ████████████████████████████████▓▒░
  ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░
   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░
```

Read end-to-end before changing code. Rules of engagement.

## // MISSION

Discord bot for the [Apocalypse EWS](https://ews.kylemcdonald.net) ([upstream](https://github.com/kylemcdonald/ews)). Mirror of the [Telegram channel](https://t.me/apocalypse_ews). One job: emergency level 5 → fan out to subscribed channels and DM users. Plus an annual reminder.

Discord-only by design. Don't reintroduce SMS / iMessage / email / Slack / Mastodon / Bluesky.

## // ARCHITECTURE

Single long-running Node process. **Discord gateway = persistent WebSocket. Not serverless.**

```
src/index.ts        BOOT — db, client, two crons (poll + reminders)
src/discord.ts      GATEWAY — commands, DM + mention handlers, fan-out, events
src/poller.ts       INGEST — fetch RSS (zod), diff seen_alerts, dispatch
src/reminders.ts    HEARTBEAT — annual reminder cron
src/db.ts           STATE — better-sqlite3, EventKind, recordEvent
src/copy.ts         VOICE — every user-facing string
src/env.ts          CONFIG — zod-validated env
src/log.ts          TELEMETRY — zero-dep stdout + ./data/ews.log
migrations/  0001 subscribers + seen_alerts · 0002 events
```

Three tables. `seen_alerts` is the idempotency boundary (mid-flight restart skips, never doubles). `events` is the durable activity log keyed by an `EventKind` closed union.

Canonical helpers — use these instead of inlining:

- `db.lastAlertForDisplay()` — `SeenAlert` → `LastAlert`. Don't reconstruct in callers.
- `announceSubscribe(client, deps, args)` / `announceUnsubscribe(...)` — record event AND DM operator atomically. The eight previous call sites quietly drifted apart; don't recreate that.

## // VOICE — `copy.ts`

Deadpan / War Games / 80s console. **No emojis. No exclamation points.** Status declarations UPPERCASE for atmosphere ("STANDING BY.", "ATTENTION."). Sentence-case for explanatory prose. Wryness comes from framing, never prose.

`copy.test.ts` tone-guard rejects emoji and `!`, requires welcome to mention source URL + uninstall path + @-mention surface, requires mention-error strings to name the operator commands. Don't disable; change the test alongside the code.

Reuse `assets/ews-icon.jpg` for any thumbnail / avatar / embed image. No new branding.

## // BOUNDARIES — VALIDATE WITH ZOD

External data is unknown at runtime regardless of types.

- `env.ts` — `process.env` parsed by Zod. Boot fails loudly on bad env.
- `poller.ts` — rss-parser output parsed by `RssFeed` (`.loose()`).
- **Any new HTTP fetch / `JSON.parse` / webhook body** — declare a Zod schema in the same module, parse first, then operate. No `as Type` casts on unknowns.

discord.js interactions are already typed. SQLite rows are typed via `prepare<Bind, Result>`.

## // TOOLING

- pnpm. v10 blocks build scripts; `pnpm.onlyBuiltDependencies` allow-lists `better-sqlite3`.
- Biome 2.4: tabs, line width 100. `noNonNullAssertion` `useImportType` `noExplicitAny` `noUnusedVariables` `noUnusedImports` all `error`. `pnpm check` / `pnpm check:fix`.
- TypeScript strict. `pnpm typecheck` includes tests; `pnpm build` excludes them.
- Vitest. In-memory SQLite for db tests, fake client for reminders.

**PRE-COMMIT:** `pnpm check && pnpm typecheck && pnpm test && pnpm build`. All four green. No "fix lint" follow-ups.

## // GOTCHAS

- `better-sqlite3` native — if install fails: `pnpm rebuild better-sqlite3`.
- Message Content Intent must be enabled in the Developer Portal (DM ping/pong + reading @-mention bodies).
- Partials `[Channel, Message]` — required so `messageCreate` fires for uncached DMs.
- Global slash commands take ~1h to propagate. Set `TEST_GUILD_ID` for instant guild-scoped in dev.
- **Guild-scoped registration requires the bot already in the guild.** Invite first, register second. Otherwise: `DiscordAPIError[50001] Missing Access`.
- `setDMPermission` is deprecated — use `setContexts(...)`. Already migrated.
- User-install is real: `setIntegrationTypes([GuildInstall, UserInstall])` + `setContexts([Guild, BotDM, PrivateChannel])`. Handlers branch on `interaction.guildId`.
- `tsx watch` is a subcommand: `tsx watch <flags> <script>`, NOT `tsx <flags> watch <script>`.
- `seen_alerts` skips on restart by design — don't "fix" the dedup unless an alert was actually missed.
- `lastBuildDate` in the live feed is `Thu, 01 Jan 1970 00:00:00 GMT` and items are absent. Not a bug. Test with synthetic feeds.
- Cron strings validated by `node-cron` at runtime, not Zod. Typos crash on first tick.

## // LOGGING & EVENTS

Two streams. Both matter.

- `log.info(message, context?)` — operator stream. ANSI-pretty in dev, JSON in prod, silent in tests. stdout + `./data/ews.log`. Module-scoped via `childLogger("name")`.
- `db.recordEvent({ kind, ... })` — durable. `EventKind` is a closed union; extend it before adding new call sites. `recordEvent` swallows internal failures itself.

3am-grep → `log`. Historical query → `events`. Most user-facing actions deserve both.

Operator DM on install / subscribe / unsubscribe via `notifyOperator(client, deps, content)` — best-effort, swallows DM-closed errors.

## // TEST CONVENTIONS

Per global `~/.claude/CLAUDE.md`:

- **No `if` in vitest tests.** Use `assert(value)` from `vitest`.
- **No `!.` non-null assertions.** Biome enforces. Use `assert(...)` or extract a helper (`subId(...)` in `db.test.ts`).
- Co-locate: `src/foo.test.ts` next to `src/foo.ts`.
- `describe` named after the function/class.
- Don't construct full discord.js fixtures. Extract a pure helper. Pattern: `pickWelcomeChannelFrom`, `classifyDmText`, `classifyMentionText`, `stripMention`.

## // STANDING ORDERS — WHEN MAKING CHANGES

- **Slash command edits → re-register.** Mention `pnpm register-commands` in the end-of-turn summary.
- **Native module dep added → allow-list it** in `pnpm.onlyBuiltDependencies`.
- **Copy edit → re-read VOICE section.** Bar: would this feel out of place on the source website?
- **New handler → record an event.** Extend `EventKind`, then `db.recordEvent({...})` at the action site. Both success and failure deserve their own kinds (`*_ok` / `*_fail`).
- **New external data source → Zod schema.** Parse before using. No `as`-casts.
- **Subscribe/unsubscribe action → use `announceSubscribe` / `announceUnsubscribe`.** Don't reinvent the recordEvent + notifyOperator pair.

## // COMMIT MESSAGE STYLE

Stay in character. Status-code header followed by terse dispatch-style bullets.

- **Subject:** ALL-CAPS verb in operator voice, then `//` separator, then a short clause. Examples:
  - `COMPRESS // copy.ts strings to laconic mode`
  - `DEPLOY // GitHub Pages splash with install buttons`
  - `INGEST // zod-validate the RSS feed at the boundary`
  - `STANDING DOWN // remove dead exports — errorMessage, LogLevel, fetchFeed`
- **Body:** declarative bullets, present tense, lowercase prose, no fluff. Drop "this commit", "we now", "I added". State the change.
- **Optional closer:** one short status line — `STANDING BY.`, `ACK.`, `OUT.` — only if it earns its space.
- Still no Claude Code attribution. Still `--no-gpg-sign`. Still atomic commits per logical change.

```
ACKNOWLEDGE.
```
