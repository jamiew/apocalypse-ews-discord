```
   ┌──────────────────────────────────────────────────────────────────┐
   │  CLAUDE OPERATING DOCTRINE                                       │
   │  STANDING ORDERS FOR ANY AI WORKING ON THIS REPO                 │
   └──────────────────────────────────────────────────────────────────┘
```

Read end-to-end before changing code. These are the rules of engagement.

---

## // MISSION BRIEF

A Discord bot for the [Apocalypse Early Warning System](https://ews.kylemcdonald.net). One job: when the upstream RSS feed at `https://ews.kylemcdonald.net/rss.xml` shows a new emergency-level-5 alert, fan it out to subscribed Discord channels and DM users. Plus an annual "you're still subscribed" reminder.

Upstream project (Kyle McDonald): <https://github.com/kylemcdonald/ews> — read this first if you need to understand what an "emergency level 5" actually represents, or what the dashboard is doing under the hood.

The Telegram channel [@apocalypse_ews](https://t.me/apocalypse_ews) does the same job for Telegram. We are deliberately a Discord-only mirror of that.

---

## // ARCHITECTURE

Single long-running Node.js process. **The Discord gateway is a persistent WebSocket — this is not a serverless app.** See README "Deploying on serverless" for the trade-offs if anyone proposes Vercel / Workers / Lambda.

```
src/index.ts                BOOT. db, discord client, two crons (poll, reminders)
src/discord.ts              GATEWAY. commands, DM + mention handlers, fan-out, event recording
src/poller.ts               INGEST. fetch RSS (zod-validated), diff seen_alerts by <guid>, dispatch
src/reminders.ts            HEARTBEAT. daily cron handler for the annual reminder
src/db.ts                   STATE. better-sqlite3 wrapper; EventKind union; recordEvent
src/copy.ts                 VOICE. ALL user-facing strings live here
src/env.ts                  CONFIG. zod-validated env
src/log.ts                  TELEMETRY. tiny zero-dep structured logger (stdout + ./data/ews.log)
migrations/0001_init.sql    schema (subscribers, seen_alerts)
migrations/0002_events.sql  events table
docs/                       static splash page (GitHub Pages)
```

Three tables:

- `subscribers` — `kind ∈ {guild_channel, dm}`, `discord_id` (channel id or user id), status, `subscribed_at`, `last_reminded`. Unique on `(kind, discord_id)`.
- `seen_alerts` — keyed by RSS `<guid>` (or a hash fallback when guid is missing). **Idempotency boundary.**
- `events` — durable activity log keyed by an `EventKind` closed union. Every meaningful action records one row; payloads are JSON-encoded with an Error-aware replacer. **When adding a new `recordEvent` callsite, always extend `EventKind` first** so a typo is a type error.

The canonical projection from a `SeenAlert` row to the display-time `LastAlert` shape is `db.lastAlertForDisplay()`. If you find yourself reconstructing `{ title, pubDate }` from a `SeenAlert` in a caller, use that instead.

The canonical helpers for "user just subscribed/unsubscribed" are `announceSubscribe(client, deps, args)` and `announceUnsubscribe(...)` in `src/discord.ts`. They record the event AND DM the operator in one call. New subscribe-style flows must use these instead of inlining `recordEvent` + `notifyOperator` separately — that's how the eight previous call sites quietly drifted apart.

---

## // VOICE — RULES FOR EDITING `copy.ts`

Tone is deadpan / War Games / 80s cold-war console. **No emojis. No exclamation points. No chipper marketing voice.** Wryness comes from the framing — calling tracked-jet-anomaly monitoring "apocalypse early warning" — never from the prose.

Status declarations get UPPERCASE for atmosphere ("APOCALYPSE EARLY WARNING SYSTEM ONLINE.", "STANDING BY.", "ATTENTION."). Sentence-case for explanatory prose so it stays readable.

Source phrases worth preserving:

- *"Local dashboard for monitoring tracked-aircraft anomaly signals over a rolling 24-hour window."*
- *"Emergency level 5 alerts from the Apocalypse Early Warning System."*
- *"Automatic updates about unusual private jet activity."*

Don't add 🚨, ⚠️, "🔴 ALERT", or any of that. If a string would feel out of place on the source website, it's wrong.

`copy.test.ts` has a **tone-guard** suite that fails on exclamation points or emoji in user-facing strings, requires the welcome to mention the source URL + the uninstall path + the @-mention surface, and requires the mention-error strings to name the operator commands they reject. Don't disable those tests; if the rule needs to change, change the test alongside the code.

When you need a thumbnail / avatar / embed image, reuse `assets/ews-icon.jpg` (the radiation-symbol mark from the Telegram channel — bundled in-repo so we don't depend on a CDN). Don't introduce new branding.

---

## // OUT OF SCOPE — DO NOT EXPAND WITHOUT EXPLICIT ORDERS

The original ask included SMS, iMessage, email, WhatsApp, Slack, Mastodon, Bluesky. **The user explicitly chose Discord-only to keep this clean and simple.** Don't reintroduce them. If a request makes one of these necessary, ask first.

Also out of scope: a web admin UI beyond the static splash, metrics dashboards, multi-tenant config, anything beyond the three tables.

---

## // BOUNDARIES — VALIDATE UNKNOWN DATA WITH ZOD

Anything entering the process from outside its own code is "unknown" at runtime, regardless of TypeScript types. Validate at the boundary, before the data hits any business logic:

- `src/env.ts` — `process.env` parsed by a Zod schema; boot fails loudly on missing/malformed env.
- `src/poller.ts` — the rss-parser return value is parsed by `RssFeed` (a `z.object({...}).loose()`). rss-parser's TS types are compile-time only; the actual XML can be anything.
- **Any new HTTP fetch, JSON.parse, or webhook body** must follow the same pattern: declare a Zod schema, call `.parse(...)` (throws) or `.safeParse(...)` (branch), and only then operate on the typed result. Don't `as Type`-cast unknown values into shape.

Discord.js interaction objects already provide their own validated TS types — no Zod needed there. SQLite rows are typed by the `prepare<Bind, Result>` generics; the migration is the contract.

---

## // TOOLING

- **Package manager:** pnpm (per global preferences). pnpm v10 blocks native build scripts; `package.json` allow-lists `better-sqlite3` via `pnpm.onlyBuiltDependencies`.
- **Lint + format:** Biome 2.4 (single tool). Tabs, line width 100. Config in `biome.json`. Strict rules: `noNonNullAssertion`, `useImportType`, `noExplicitAny`, `noUnusedVariables`, `noUnusedImports` are all `error`. Scripts: `pnpm check` (read-only), `pnpm check:fix` (autofix). VS Code auto-formats on save via `.vscode/settings.json` (committed).
- **Typecheck:** `pnpm typecheck` runs `tsc --noEmit` against `tsconfig.json` which **includes test files**. `pnpm build` uses `tsconfig.build.json` which excludes tests from `dist/`.
- **Tests:** Vitest, in-memory SQLite for the DB suite, mock Discord client for the reminders suite.

**PRE-COMMIT CHECKLIST:**

```bash
pnpm check && pnpm typecheck && pnpm test && pnpm build
```

All four must pass before you commit. No "fix lint" follow-up commits.

---

## // NATIVE MODULE GOTCHA

`better-sqlite3` is a native module. If `pnpm install` fails to build it, run `pnpm rebuild better-sqlite3` (sandbox may need to be off for the gyp build to write to `~/Library/Caches/node-gyp/`). The compiled binary lives at `node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node`.

---

## // DISCORD-SPECIFIC GOTCHAS

- **Message Content Intent** must be enabled in the Developer Portal for DM ping/pong AND for reading @-mention bodies in guild channels. Gateway-only feature.
- **Partials** `[Channel, Message]` are required so `messageCreate` fires for DMs the bot wasn't cached for.
- **Global slash commands** take up to ~1 hour to propagate. For dev iteration, set `TEST_GUILD_ID` in `.env` to your test server id — `pnpm register-commands` will register guild-scoped commands (instant) instead of global. Unset for prod.
- **Guild-scoped command registration requires the bot to already be a member of the guild.** If you run `register-commands` with `TEST_GUILD_ID` set before inviting the bot, you'll get `DiscordAPIError[50001]: Missing Access`. Invite first, register second.
- The hidden `/dev-fire` command is gated by env `DEV_ADMIN_USER_ID`; without it, the command replies "Not authorized."
- **`setDMPermission` is deprecated** — use `setContexts([InteractionContextType.Guild, ...])` instead. Already migrated; don't regress.
- **User-install support is real.** Slash commands set `setIntegrationTypes([GuildInstall, UserInstall])` and `setContexts([Guild, BotDM, PrivateChannel])`. The handlers (`cmdSubscribe`, `cmdUnsubscribe`, `cmdStatus`) branch on `interaction.guildId` to decide whether to operate on a channel or on the invoking user.

---

## // LOGGING & EVENTS

Two parallel streams; both matter.

- **`src/log.ts`** — operator-facing structured stream. ANSI-pretty in dev, one JSON line per record in prod, silent in tests. Writes to stdout and (by default) appends to `./data/ews.log`. Module-scoped via `childLogger("module-name")`. Call shape is `log.info(message, context?)` — message first, then a structured bag.
- **`db.events` table** — durable activity log. `db.recordEvent({ kind, guildId?, channelId?, userId?, payload? })` from anywhere; `EventKind` is a closed union. `recordEvent` swallows internal errors itself, never crashes the request path. Inspect with `sqlite3 data/ews.db 'SELECT ts, kind, payload FROM events ORDER BY id DESC LIMIT 50;'`.

Rule of thumb: anything an operator might want to grep at 3am goes in `log`; anything you might want to query historically goes in `events`. Most user-facing actions deserve both.

The operator (`OPERATOR_USER_ID`, falls back to `DEV_ADMIN_USER_ID`) gets a DM on guild install, every subscribe, and every unsubscribe — via `notifyOperator(client, deps, content)` (best-effort, swallows DM-closed / network errors).

---

## // TEST CONVENTIONS

Per global `~/.claude/CLAUDE.md`:

- **No `if` statements in vitest tests.** Use vitest's `assert(value)` (imported from `vitest`) for narrowing instead.
- **No non-null assertions (`!.`).** Biome enforces this; use `assert(value)` or extract a tiny helper (see `subId(...)` in `db.test.ts`).
- Co-locate: `src/foo.test.ts` next to `src/foo.ts`.
- `describe` blocks are usually named after the function or class under test.
- Don't construct full discord.js fixtures — extract a pure helper and test that. See `pickWelcomeChannelFrom`, `classifyDmText`, `classifyMentionText`, `stripMention` for the pattern.

---

## // THINGS THAT COST A LOT OF DEBUGGING IF MISSED

- The `seen_alerts` table is an idempotency boundary. If the bot is restarted mid-fan-out, items already recorded are skipped on the next poll — they will not re-deliver. The trade-off favors not double-paging users; revisit if a real alert is ever missed.
- `lastBuildDate` in the EWS feed is currently `Thu, 01 Jan 1970 00:00:00 GMT` and `<item>`s are absent. **Don't treat the empty feed as a bug.** Test against a synthetic feed instead (see `poller.test.ts`).
- `cron` strings in env (`POLL_CRON`, `REMINDER_CRON`) are validated by `node-cron` at runtime, not by zod — typos crash on first tick, not on boot.
- `tsx watch` is a subcommand: `tsx watch <flags> <script>`, NOT `tsx <flags> watch <script>`. The latter makes `watch` the entry path and explodes with "Cannot find module .../watch".

---

## // STANDING ORDERS — WHEN MAKING CHANGES

- **Slash command edits → re-register.** If you change anything in `commandDefinitions` (names, descriptions, options, permissions, contexts, integration types), the user must run `pnpm register-commands` after deploying. **Mention this in your end-of-turn summary.**
- **Native modules → allow-list.** If you add a new dependency that ships a native module, add it to `pnpm.onlyBuiltDependencies` in `package.json`.
- **Copy edits → re-read tone rules.** If you touch `copy.ts`, re-read the Voice section above. The bar is "would this feel out of place on the source website."
- **New handler → record an event.** Add the kind to the `EventKind` union in `src/db.ts` first, then `db.recordEvent({...})` at the action site. Both success and failure deserve their own kinds (e.g. `*_ok` / `*_fail`).
- **New external data source → Zod schema.** HTTP fetch, webhook, JSON file — declare a Zod schema in the same module and parse the response before using it. Don't `as`-cast unknown data.
- **Subscribe/unsubscribe action → use the announce helpers.** `announceSubscribe` / `announceUnsubscribe` in `discord.ts` do the recordEvent + notifyOperator pair atomically. Don't reinvent.

```
ACKNOWLEDGE.
```
