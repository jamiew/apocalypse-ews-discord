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

Two Discord bots, one repo, one toolchain. Each has one job.

1. **Apocalypse EWS** (`src/`) — mirror of the [Apocalypse EWS](https://ews.kylemcdonald.net) ([upstream](https://github.com/kylemcdonald/ews)) and its [Telegram channel](https://t.me/apocalypse_ews). When the upstream `current.emergencyLevel` (1..5) changes, fan out to subscribed channels and DMs. Plus an annual reminder.
2. **Pentagon Pizza Watch** (`src/pizza/`) — mirror of [@PenPizzaReport](https://x.com/PenPizzaReport). Reads its posts through the Xpoz API, derives a 1..5 signal level, fans out on transition.

Discord-only by design. Don't reintroduce SMS / iMessage / email / Slack / Mastodon / Bluesky.

**The bots share `log.ts` and `intent.ts` and nothing else.** Separate Discord applications, separate env files, separate database files, separate `EventKind` unions. Don't merge their state. Don't make one import the other's `copy.ts` or `db.ts`.

## // ARCHITECTURE

Single long-running Bun process. **Discord gateway = persistent WebSocket. Not serverless.**

```
src/index.ts          BOOT — db, client, four crons (rss + level + reminders + heartbeat)
src/discord.ts        GATEWAY — commands, DM + mention handlers, fan-out, events
src/poller.ts         INGEST — fetch RSS (zod), diff seen_alerts, dispatch
src/level-poller.ts   INGEST — fetch dashboard.json, diff level_state, dispatch
src/reminders.ts      HEARTBEAT — annual reminder cron
src/heartbeat.ts      HEARTBEAT — jittered standing-by broadcast
src/db.ts             STATE — bun:sqlite, EventKind, recordEvent
src/copy.ts           VOICE — every user-facing string
src/env.ts            CONFIG — zod-validated env

src/intent.ts         SHARED — free-text intents, mention stripping, operator DM format
src/log.ts            SHARED — zero-dep stdout + file sink

src/pizza/index.ts    BOOT — db, client, one cron (poll)
src/pizza/discord.ts  GATEWAY — same surface plus /latest
src/pizza/poller.ts   INGEST — fetch posts, diff seen_posts, diff signal_state, dispatch
src/pizza/xpoz.ts     BOUNDARY — Xpoz SDK wrapper, zod-validated
src/pizza/signal.ts   ANALYSIS — pure post text -> 1..5 level
src/pizza/db.ts       STATE — its own EventKind union, its own db file
src/pizza/copy.ts     VOICE
src/pizza/env.ts      CONFIG

migrations/        0001 subscribers + seen_alerts · 0002 events · 0003 level_state
migrations/pizza/  0001 subscribers + seen_posts + events + signal_state
```

Four tables per bot. `seen_alerts` / `seen_posts` are the idempotency boundaries (mid-flight restart skips, never doubles). `events` is the durable activity log keyed by an `EventKind` closed union. `level_state` / `signal_state` are single-row "last observed level" trackers.

Canonical helpers — use these instead of inlining:

- `db.lastAlertForDisplay()` — `SeenAlert` → `LastAlert`. Don't reconstruct.
- `announceSubscribe(client, deps, args)` / `announceUnsubscribe(...)` — record event AND DM operator atomically.
- `fanOutAlert` (RSS-driven) and `fanOutLevelChange` (level-poller-driven) for the dispatch.
- Pizza bot: `fanOutSignalChange` for the dispatch, `latestViewFrom(deps)` to rebuild the `/latest` view from `signal_state`. Don't read the state columns by hand.
- Both bots: `classifyWith(patterns, raw)` from `intent.ts`. Don't re-declare an intent table — extend one.

## // VOICE — `copy.ts`

Deadpan / War Games / 80s console. **No emojis. No exclamation points.** UPPERCASE for status declarations ("STANDING BY.", "ATTENTION."). Sentence-case for prose. Wryness comes from framing, never prose.

Both bots carry a `copy.test.ts` tone-guard: rejects emoji and `!`, requires welcome to mention source URL + uninstall path + @-mention surface, requires mention-error strings to name the operator commands. Don't disable; change the test alongside the code.

The pizza bot's copy is emoji-free throughout, including its alert banners. The EWS `levelChangePayload` predates that rule and still uses an emoji ladder — leave it, but don't copy the pattern into new code.

Reuse `assets/ews-icon.jpg` for any thumbnail / avatar / embed image. No new branding.

## // BOUNDARIES — VALIDATE WITH ZOD

External data is unknown at runtime regardless of types.

- `env.ts` — `process.env` parsed by Zod. Boot fails loudly on bad env.
- `poller.ts` — rss-parser output parsed by `RssFeed` (`.loose()`).
- `level-poller.ts` — dashboard JSON parsed by `Dashboard` (`.loose()`, validates `current.emergencyLevel ∈ 1..5`).
- **Any new HTTP fetch / `JSON.parse` / webhook body** — declare a Zod schema in the same module, parse first, then operate. No `as Type` casts on unknowns.

discord.js interactions are already typed. SQLite rows are typed via `query<Result, Bind>` generics on bun:sqlite.

## // TYPED EVENTS

`EventPayloadByKind` in `src/db.ts` is a closed map: each `EventKind` has a known payload shape. `RecordEventInput` is a discriminated union — passing the wrong payload for a kind is a compile error. **When adding a new event kind, extend both `EventKind` and `EventPayloadByKind` first; the `_AssertCovered` line will refuse to compile otherwise.**

## // TOOLING

- **Bun.** Runtime, package manager, test runner, script runner. No pnpm, no node, no tsx, no vitest.
- **Biome 2.4:** tabs, line width 100. Strict rules: `noNonNullAssertion`, `useImportType`, `noExplicitAny`, `noUnusedVariables`, `noUnusedImports` all `error`. `useLiteralKeys` is `off` (collides with TS `noPropertyAccessFromIndexSignature`).
- **TypeScript strict** + `noUncheckedIndexedAccess` + `noImplicitOverride` + `noImplicitReturns` + `noFallthroughCasesInSwitch` + `noPropertyAccessFromIndexSignature` + `exactOptionalPropertyTypes`. `tsconfig.json` carries `types: ["bun"]` to pull in bun-types for `bun:*` modules.
- **`bun:test`.** In-memory SQLite for db tests, fake client object for the dispatch tests, a fake `PostSource` for the pizza poller. **No test hits the network.**
- **`@xpoz/xpoz`** for the pizza bot's ingest. It speaks MCP to `mcp.xpoz.ai` under the hood; `XPOZ_API_KEY` authenticates.

**PRE-COMMIT:** `bun run ci` (== `biome ci . && tsc --noEmit && bun test src`). All three green. No "fix lint" follow-ups.

## // GOTCHAS

- Message Content Intent must be enabled in the Developer Portal (DM ping/pong + reading @-mention bodies).
- Partials `[Channel, Message]` — required so `messageCreate` fires for uncached DMs.
- Global slash commands take ~1h to propagate. Set `TEST_GUILD_ID` for instant guild-scoped in dev.
- **Guild-scoped registration requires the bot already in the guild.** Invite first, register second. Otherwise: `DiscordAPIError[50001] Missing Access`.
- `setDMPermission` is deprecated — use `setContexts(...)`. Already migrated.
- User-install is real: `setIntegrationTypes([GuildInstall, UserInstall])` + `setContexts([Guild, BotDM, PrivateChannel])`. Handlers branch on `interaction.guildId`.
- `seen_alerts` skips on restart by design — don't "fix" the dedup unless an alert was actually missed.
- `lastBuildDate` in the live RSS feed is `Thu, 01 Jan 1970 00:00:00 GMT` and items are absent. Not a bug. Test with synthetic feeds.
- The level-poller's first observation does NOT fire `onLevelChange` (no previous to compare against; bot booting is not a level change). Same rule in the pizza poller — see `shouldAnnounce`.
- `log.ts` defaults `LOG_FILE` to `./data/ews.log`. The pizza bot MUST set `LOG_FILE` explicitly or it writes into the EWS log. `.env.pizza.example` and the compose service both do.
- Pizza signal terms are matched with word boundaries. Without them `low` fires inside `below` and every downgrade reads as a stronger downgrade. Don't drop the `\b`s.
- The pizza poller emits ONE dispatch per tick, carrying the newest readable post. A burst of six posts is one message, not six.
- `PIZZA_MIN_ALERT_LEVEL` is a fan-out floor, not a classification floor. Sub-floor transitions still move `signal_state` and still record events.
- Cron strings validated by `node-cron` at runtime, not Zod. Typos crash on first tick.
- `bun:sqlite`'s `.get()` returns `null`, not `undefined`. Coerce with `?? undefined` if your interface says `T | undefined`.

## // LOGGING & EVENTS

Two streams. Both matter.

- `log.info(message, context?)` — operator stream. ANSI-pretty in dev, JSON in prod, silent in tests. stdout + `./data/ews.log`. Module-scoped via `childLogger("name")`.
- `db.recordEvent({ kind, ... })` — durable. `EventKind` is a closed union; payload is typed per-kind. `recordEvent` swallows internal failures itself.

3am-grep → `log`. Historical query → `events`. Most user-facing actions deserve both.

Operator DM on install / subscribe / unsubscribe via `notifyOperator(client, deps, content)` — best-effort, swallows DM-closed errors.

## // TEST CONVENTIONS

Per global `~/.claude/CLAUDE.md`:

- **No `if` in tests.** Use `import { ok as assert } from "node:assert/strict"` for narrowing.
- **No `!.` non-null assertions.** Biome enforces. Use `assert(...)` or extract a helper (`subId(...)` in `db.test.ts`).
- Co-locate: `src/foo.test.ts` next to `src/foo.ts`.
- `describe` named after the function/class under test.
- Don't construct full discord.js fixtures. Extract a pure helper and test it. Pattern: `pickWelcomeChannelFrom`, `classifyDmText`, `classifyMentionText`, `stripMention`.

## // STANDING ORDERS — WHEN MAKING CHANGES

- **Slash command edits → re-register.** Mention `bun run register-commands` in the end-of-turn summary.
- **Copy edit → re-read VOICE section.** Bar: would this feel out of place on the source website?
- **New handler → record an event.** Extend `EventKind` AND `EventPayloadByKind` first, then `db.recordEvent({...})` at the action site. Both success and failure deserve their own kinds (`*_ok` / `*_fail`).
- **New external data source → Zod schema.** Parse before using. No `as`-casts.
- **Touching `src/pizza/signal.ts` → extend the corpus.** `signal.test.ts` is pinned to verbatim posts from the account. Add the post that motivated the change; don't tune against a paraphrase.
- **Slash command edits on the pizza bot → `bun run pizza:register-commands`.** Separate application, separate registration.
- **Subscribe/unsubscribe action → use `announceSubscribe` / `announceUnsubscribe`.** Don't reinvent the recordEvent + notifyOperator pair.

## // COMMIT MESSAGE STYLE

Stay in character. Status-code header followed by terse dispatch-style bullets.

- **Subject:** ALL-CAPS verb in operator voice, then `//` separator, then a short clause. Examples:
  - `COMPRESS // copy.ts strings to laconic mode`
  - `DEPLOY // GitHub Pages splash with install buttons`
  - `INGEST // zod-validate the RSS feed at the boundary`
  - `SWITCH // pnpm + node + better-sqlite3 → bun all the way`
- **Body:** declarative bullets, present tense, lowercase prose, no fluff. Drop "this commit", "we now", "I added". State the change.
- **Optional closer:** one short status line — `STANDING BY.`, `ACK.`, `OUT.` — only if it earns its space.
- Still no Claude Code attribution. Still `--no-gpg-sign`. Still atomic commits per logical change.

```
ACKNOWLEDGE.
```
