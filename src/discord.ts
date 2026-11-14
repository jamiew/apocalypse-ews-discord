import {
	ActivityType,
	ApplicationIntegrationType,
	AuditLogEvent,
	ChannelType,
	type ChatInputCommandInteraction,
	Client,
	Events,
	GatewayIntentBits,
	type Guild,
	type GuildMember,
	InteractionContextType,
	type Message,
	MessageFlags,
	Partials,
	PermissionFlagsBits,
	type PermissionsBitField,
	REST,
	RESTJSONErrorCodes,
	Routes,
	SlashCommandBuilder,
	type Snowflake,
	type TextBasedChannel,
} from "discord.js";
import {
	type AlertItem,
	alertPayload,
	blockedNotice,
	DM_ALREADY_SUBSCRIBED,
	DM_NOT_SUBSCRIBED,
	DM_OPT_IN_PROMPT,
	DM_SUBSCRIBE_OK,
	DM_UNSUBSCRIBE_OK,
	dmStatusReport,
	GUILD_ALREADY_SUBSCRIBED,
	GUILD_BOT_ABSENT,
	GUILD_NOT_SUBSCRIBED,
	GUILD_SUBSCRIBE_OK,
	GUILD_UNSUBSCRIBE_OK,
	GUILD_WELCOME,
	guildCannotPost,
	guildStatusReport,
	HELP,
	type LevelChange,
	levelChangePayload,
	levelPresenceName,
	MENTION_INSUFFICIENT_PRIVILEGES,
	MENTION_UNKNOWN,
	pingPongLine,
	SUBSCRIBE_COMMAND_DESCRIPTION,
	type SubscribedChannel,
} from "./copy.js";
import {
	type DB,
	type DmIntent,
	type EventPayloadByKind,
	type MentionIntent,
	type PruneReason,
	type Subscriber,
	type SubscriberKind,
	type SubscribeVia,
	subscriberAddress,
} from "./db.js";
import { childLogger } from "./log.js";

const log = childLogger("discord");

type FreeTextIntent = Exclude<MentionIntent, "other">;

const INTENT_PATTERNS: Record<FreeTextIntent, readonly RegExp[]> = {
	unsubscribe: [
		/^unsubscribe$/,
		/^unsub$/,
		/^stop$/,
		/^cancel$/,
		/^quit$/,
		/^end$/,
		/^remove$/,
		/\bunsubscribe\b/,
		/\bunsub\b/,
		/\bopt out\b/,
		/\bstand down\b/,
		/\bremove me\b/,
	],
	subscribe: [
		/^subscribe$/,
		/^sub$/,
		/^start$/,
		/^yes$/,
		/^y$/,
		/\bsubscribe\b/,
		/\bopt in\b/,
		/\bsign me up\b/,
		/\badd me\b/,
	],
	status: [
		/^status$/,
		/^state$/,
		/^level$/,
		/\bstatus\b/,
		/\bstate\b/,
		/\bcurrent level\b/,
		/\bwhat(?:'s| is) (?:the |my )?status\b/,
		/\bwhat(?:'s| is) (?:the |my )?level\b/,
	],
	help: [
		/^\?$/,
		/^help$/,
		/^commands?$/,
		/^options?$/,
		/^info$/,
		/\bhelp\b/,
		/\bcommands?\b/,
		/\boptions?\b/,
		/\bwhat can you do\b/,
		/\bhow does this work\b/,
	],
};

function normalizeFreeText(raw: string): string {
	return raw
		.trim()
		.toLowerCase()
		.replaceAll("’", "'")
		.replace(/[^a-z0-9?'\s]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function classifyFreeText(raw: string): MentionIntent {
	const text = normalizeFreeText(raw);
	if (!text) return "other";

	let best: { intent: FreeTextIntent; index: number; priority: number } | null = null;
	const intents = Object.entries(INTENT_PATTERNS) as [FreeTextIntent, readonly RegExp[]][];

	for (const [priority, [intent, patterns]] of intents.entries()) {
		for (const pattern of patterns) {
			const match = pattern.exec(text);
			const index = match?.index;
			if (index == null) continue;
			if (
				best == null ||
				index < best.index ||
				(index === best.index && priority < best.priority)
			) {
				best = { intent, index, priority };
			}
		}
	}

	return best?.intent ?? "other";
}

export function classifyDmText(raw: string): DmIntent {
	return classifyFreeText(raw);
}

export function classifyMentionText(raw: string): MentionIntent {
	return classifyFreeText(raw);
}

export function stripMention(content: string, botUserId: Snowflake): string {
	return content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
}

export interface WelcomeChannelCandidate {
	id: Snowflake;
	type: ChannelType;
	position: number;
	canSend: boolean;
}

export function pickWelcomeChannelFrom(
	systemChannel: WelcomeChannelCandidate | null,
	channels: readonly WelcomeChannelCandidate[],
): WelcomeChannelCandidate | null {
	if (systemChannel?.canSend) return systemChannel;
	const sendable = channels
		.filter((c) => c.type === ChannelType.GuildText && c.canSend)
		.sort((a, b) => a.position - b.position);
	return sendable[0] ?? null;
}

const ALL_CONTEXTS: InteractionContextType[] = [
	InteractionContextType.Guild,
	InteractionContextType.BotDM,
	InteractionContextType.PrivateChannel,
];
const ALL_INSTALLS: ApplicationIntegrationType[] = [
	ApplicationIntegrationType.GuildInstall,
	ApplicationIntegrationType.UserInstall,
];

export const commandDefinitions = [
	new SlashCommandBuilder()
		.setName("subscribe")
		.setDescription(SUBSCRIBE_COMMAND_DESCRIPTION)
		.addChannelOption((opt) =>
			opt
				.setName("channel")
				.setDescription("Server only: channel to post alerts in (defaults to current).")
				.addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
		)
		// ManageGuild only gates this in guild contexts; DMs/private channels are unrestricted.
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setIntegrationTypes(ALL_INSTALLS)
		.setContexts(ALL_CONTEXTS),
	new SlashCommandBuilder()
		.setName("unsubscribe")
		.setDescription("Stop receiving alerts (this channel in a server, or you in a DM).")
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setIntegrationTypes(ALL_INSTALLS)
		.setContexts(ALL_CONTEXTS),
	new SlashCommandBuilder()
		.setName("status")
		.setDescription("Show subscription state, current level, and the last level 5 alert.")
		.setIntegrationTypes(ALL_INSTALLS)
		.setContexts(ALL_CONTEXTS),
	new SlashCommandBuilder()
		.setName("help")
		.setDescription("How to use the Apocalypse EWS bot.")
		.setIntegrationTypes(ALL_INSTALLS)
		.setContexts(ALL_CONTEXTS),
].map((c) => c.toJSON());

// Guild-scoped registration is instant; global takes ~1h to propagate.
export async function registerCommands(args: {
	token: string;
	clientId: string;
	guildId?: Snowflake | undefined;
}): Promise<void> {
	const rest = new REST({ version: "10" }).setToken(args.token);
	const route = args.guildId
		? Routes.applicationGuildCommands(args.clientId, args.guildId)
		: Routes.applicationCommands(args.clientId);
	await rest.put(route, { body: commandDefinitions });
}

export interface BotDeps {
	db: DB;
}

export function updateLevelPresence(client: Client, db: DB): void {
	if (!client.isReady()) return;
	try {
		const state = db.getLevelState();
		const name = levelPresenceName(state.emergency_level, state.as_of, state.updated_at);
		const current = client.user.presence.activities[0];
		if (current?.name === name && current.type === ActivityType.Watching) return;
		client.user.setActivity(name, { type: ActivityType.Watching });
		log.debug("presence updated", { name });
	} catch (err) {
		log.warn("presence update failed", { err });
	}
}

export function createClient(deps: BotDeps): Client {
	const client = new Client({
		// DM and direct @mention content is available without privileged MessageContent access.
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.DirectMessages,
		],
		// Required so messageCreate fires for DM channels not yet cached.
		partials: [Partials.Channel, Partials.Message],
		// Outbound text carries upstream feed content; never let it ping users, roles, or @everyone.
		allowedMentions: { parse: [] },
	});

	client.once(Events.ClientReady, (c) => {
		log.debug("logged in", { tag: c.user.tag, id: c.user.id });
		updateLevelPresence(c, deps.db);
		void auditSubscriptions(c, deps.db).catch((err) =>
			log.error("subscription audit failed", { err }),
		);
	});

	client.on(Events.GuildCreate, (guild) => {
		void onGuildCreate(guild, deps, client).catch((err) =>
			log.error("guildCreate failed", { err, guildId: guild.id }),
		);
	});

	client.on(Events.GuildDelete, (guild) => {
		const botJoinedAt = guild.joinedAt?.toISOString() ?? null;
		const tenureMs = guild.joinedAt ? Date.now() - guild.joinedAt.getTime() : null;
		const payload = {
			name: guild.name,
			memberCount: guild.memberCount ?? null,
			botJoinedAt,
			tenureMs,
		};
		deps.db.recordEvent({ kind: "guild_delete", guildId: guild.id, payload });
		const subs = deps.db.listActive("guild_channel").filter((s) => s.guild_id === guild.id);
		for (const sub of subs) pruneSubscriber(deps.db, sub, "not_in_guild");
		log.info("guild remove", { guildId: guild.id, ...payload, prunedSubscriptions: subs.length });
	});

	client.on(Events.InteractionCreate, (interaction) => {
		if (!interaction.isChatInputCommand()) return;
		void handleCommand(interaction, deps).catch((err) => {
			log.error("command failed", { err, command: interaction.commandName });
			deps.db.recordEvent({
				kind: "error",
				guildId: interaction.guildId,
				channelId: interaction.channelId,
				userId: interaction.user.id,
				payload: { op: "command", command: interaction.commandName, err },
			});
		});
	});

	client.on(Events.MessageCreate, (message) => {
		if (message.author.bot) return;
		if (message.channel.type === ChannelType.DM) {
			void handleDM(message, deps).catch((err) =>
				log.error("dm handler failed", { err, userId: message.author.id }),
			);
			return;
		}
		// In guild channels: only react when the bot is mentioned, not every message.
		const me = client.user;
		if (!me || !message.mentions.users.has(me.id)) return;
		void handleMention(message, deps, me.id).catch((err) =>
			log.error("mention handler failed", { err, channelId: message.channelId }),
		);
	});

	return client;
}

async function fetchInstaller(
	guild: Guild,
	botUserId: Snowflake | undefined,
): Promise<{ id: Snowflake; tag: string | null } | null> {
	if (!botUserId) return null;
	try {
		const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 10 });
		const entry = logs.entries.find((e) => e.target?.id === botUserId);
		if (!entry?.executor) return null;
		return { id: entry.executor.id, tag: entry.executor.tag ?? null };
	} catch {
		// ViewAuditLog perm not granted, or transient — best-effort.
		return null;
	}
}

async function onGuildCreate(guild: Guild, deps: BotDeps, client: Client): Promise<void> {
	const me = guild.members.me;
	if (!me) return;

	const [owner, installer] = await Promise.all([
		guild.fetchOwner().catch(() => null),
		fetchInstaller(guild, client.user?.id),
	]);

	const botJoinedAt = guild.joinedAt?.toISOString() ?? null;
	const guildCreatedAt = guild.createdAt?.toISOString() ?? null;
	const info: EventPayloadByKind["guild_create"] = {
		name: guild.name,
		memberCount: guild.memberCount,
		ownerId: owner?.id ?? guild.ownerId,
		ownerTag: owner?.user.tag ?? null,
		channelCount: guild.channels.cache.size,
		preferredLocale: guild.preferredLocale ?? null,
		guildCreatedAt,
		botJoinedAt,
		installedById: installer?.id ?? null,
		installedByTag: installer?.tag ?? null,
		features: [...guild.features],
		large: guild.large,
		premiumTier: guild.premiumTier,
		description: guild.description ?? null,
	};

	deps.db.recordEvent({ kind: "guild_create", guildId: guild.id, payload: info });
	log.info("guild install", { guildId: guild.id, ...info });

	const channel = pickPostableChannel(guild, me);
	if (!channel) {
		recordWelcomeFailure(deps, guild.id, "no_channel");
		log.warn("welcome send failed", { guildId: guild.id, reason: "no_channel" });
		return;
	}

	try {
		await channel.send(GUILD_WELCOME);
	} catch (err) {
		const reason = classifyWelcomeError(err);
		recordWelcomeFailure(deps, guild.id, reason, err);
		log.warn("welcome send failed", { guildId: guild.id, reason, err });
		return;
	}

	deps.db.recordEvent({
		kind: "guild_welcome_sent",
		guildId: guild.id,
		channelId: channel.id,
	});

	// Auto-subscribe the welcome channel so the server gets alerts immediately
	// without anyone having to run /subscribe.
	const channelName = "name" in channel ? channel.name : "";
	const result = deps.db.upsertSubscribed({
		kind: "guild_channel",
		discordId: channel.id,
		guildId: guild.id,
		now: new Date().toISOString(),
	});
	if (result.created || result.reactivated) {
		announceSubscribe(deps, {
			kind: "guild_channel",
			via: "install",
			guildId: guild.id,
			channelId: channel.id,
			guildName: guild.name,
			channelName,
			userId: owner?.id ?? guild.ownerId,
			userTag: owner?.user.tag ?? "<server owner>",
			reactivated: result.reactivated,
		});
	}
}

export function classifyWelcomeError(err: unknown): "missing_access" | "other" {
	return discordErrorCode(err) === RESTJSONErrorCodes.MissingAccess ? "missing_access" : "other";
}

function discordErrorCode(err: unknown): unknown {
	return err != null && typeof err === "object" && "code" in err ? err.code : undefined;
}

export function botCanPost(
	perms: Readonly<PermissionsBitField> | null,
	isThread: boolean,
): boolean {
	const send = isThread
		? PermissionFlagsBits.SendMessagesInThreads
		: PermissionFlagsBits.SendMessages;
	return perms?.has([PermissionFlagsBits.ViewChannel, send]) === true;
}

// Only errors no retry can fix. Missing Access inside a server the bot still belongs to is a
// channel permission an admin can restore, so that subscription stays and keeps reporting.
export function pruneReasonFor(
	err: unknown,
	sub: Pick<Subscriber, "kind" | "guild_id">,
	botInGuild: (guildId: Snowflake) => boolean,
): PruneReason | null {
	const code = discordErrorCode(err);
	if (sub.kind === "dm") {
		if (code === RESTJSONErrorCodes.UnknownUser) return "unknown_user";
		if (code === RESTJSONErrorCodes.CannotSendMessagesToThisUserDueToHavingNoMutualGuilds) {
			return "no_mutual_guild";
		}
		return null;
	}
	if (code === RESTJSONErrorCodes.UnknownChannel) return "unknown_channel";
	if (
		code === RESTJSONErrorCodes.MissingAccess &&
		sub.guild_id !== null &&
		!botInGuild(sub.guild_id)
	) {
		return "not_in_guild";
	}
	return null;
}

function pruneSubscriber(db: DB, sub: Subscriber, reason: PruneReason, err?: unknown): void {
	if (!db.markUnsubscribed(sub.kind, sub.discord_id)) return;
	db.recordEvent({
		kind: "subscriber_pruned",
		...subscriberAddress(sub),
		payload: { kind: sub.kind, reason, err },
	});
	log.debug("subscription pruned", {
		kind: sub.kind,
		reason,
		address: sub.discord_id,
		guildId: sub.guild_id,
	});
}

// Unsubscribes `sub` when `err` means delivery can never succeed; returns the reason, else null.
function pruneIfDead(client: Client, db: DB, sub: Subscriber, err: unknown): PruneReason | null {
	const reason = pruneReasonFor(err, sub, (id) => client.guilds.cache.has(id));
	if (reason) pruneSubscriber(db, sub, reason, err);
	return reason;
}

function reportPruned(source: string, reasons: readonly PruneReason[]): void {
	if (reasons.length === 0) return;
	const byReason: Partial<Record<PruneReason, number>> = {};
	for (const r of reasons) byReason[r] = (byReason[r] ?? 0) + 1;
	log.info("dead subscriptions pruned", { source, count: reasons.length, ...byReason });
}

// System channel first, then the topmost text channel the bot can post in.
function pickPostableChannel(guild: Guild, me: GuildMember) {
	const candidates: WelcomeChannelCandidate[] = guild.channels.cache.map((c) => ({
		id: c.id,
		type: c.type,
		position: "position" in c ? (c.position ?? 0) : 0,
		canSend: botCanPost(c.permissionsFor(me), c.isThread()),
	}));
	const sys = guild.systemChannel;
	const sysCandidate = sys ? (candidates.find((c) => c.id === sys.id) ?? null) : null;
	const picked = pickWelcomeChannelFrom(sysCandidate, candidates);
	const channel = picked ? guild.channels.cache.get(picked.id) : undefined;
	return isSendable(channel) ? channel : undefined;
}

// Missing Access or Missing Permissions inside a server the bot still belongs to: an admin
// can fix it, so the subscription stays and the server is told how.
export function isBlockedError(
	err: unknown,
	sub: Pick<Subscriber, "kind" | "guild_id">,
	botInGuild: (guildId: Snowflake) => boolean,
): boolean {
	if (sub.kind !== "guild_channel" || sub.guild_id === null) return false;
	const code = discordErrorCode(err);
	if (code === RESTJSONErrorCodes.MissingPermissions) return true;
	return code === RESTJSONErrorCodes.MissingAccess && botInGuild(sub.guild_id);
}

export const BLOCKED_NOTICE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

// Tells each blocked server how to fix delivery or remove the app: in a channel the bot can
// post in, else by DM to the owner. At most once per subscription per cooldown, success or not.
export async function noticeBlocked(
	client: Client,
	db: DB,
	subs: readonly Subscriber[],
	now = new Date(),
): Promise<void> {
	let channel = 0;
	let ownerDm = 0;
	let failed = 0;
	for (const sub of subs) {
		const guild = sub.guild_id === null ? undefined : client.guilds.cache.get(sub.guild_id);
		const me = guild?.members.me;
		if (!guild || !me) continue;
		const last = db.lastBlockedNoticeTs(sub.discord_id);
		if (last !== null && now.getTime() - Date.parse(last) < BLOCKED_NOTICE_COOLDOWN_MS) continue;
		const where = subscriberAddress(sub);
		try {
			const target = pickPostableChannel(guild, me);
			if (target) {
				await target.send(blockedNotice(sub.discord_id));
				channel++;
				db.recordEvent({
					kind: "blocked_notice_ok",
					...where,
					payload: { route: "channel", noticeChannelId: target.id },
				});
			} else {
				const owner = await guild.fetchOwner();
				await owner.send(blockedNotice(sub.discord_id, guild.name));
				ownerDm++;
				db.recordEvent({
					kind: "blocked_notice_ok",
					...where,
					payload: { route: "owner_dm", noticeChannelId: null },
				});
			}
		} catch (err) {
			failed++;
			db.recordEvent({ kind: "blocked_notice_fail", ...where, payload: { err } });
			log.debug("blocked notice failed", { err, guildId: sub.guild_id, channelId: sub.discord_id });
		}
	}
	if (channel + ownerDm + failed > 0) {
		log.info("blocked subscriptions notified", { channel, ownerDm, failed });
	}
}

// One delivery pass: prunes dead subscriptions, queues blocked ones for a server notice, and
// leaves everything else for the caller to report as an error.
export class DeliveryTriage {
	private readonly client: Client;
	private readonly db: DB;
	private readonly pruned: PruneReason[] = [];
	private readonly blocked: Subscriber[] = [];

	constructor(client: Client, db: DB) {
		this.client = client;
		this.db = db;
	}

	classify(sub: Subscriber, err: unknown): "pruned" | "blocked" | "failed" {
		const reason = pruneIfDead(this.client, this.db, sub, err);
		if (reason) {
			this.pruned.push(reason);
			return "pruned";
		}
		if (isBlockedError(err, sub, (id) => this.client.guilds.cache.has(id))) {
			this.blocked.push(sub);
			return "blocked";
		}
		return "failed";
	}

	async finish(source: string): Promise<void> {
		reportPruned(source, this.pruned);
		await noticeBlocked(this.client, this.db, this.blocked);
	}
}

// READY delivers every guild the bot belongs to, so a subscription whose server is absent
// can never deliver: the bot was removed while offline, or `/subscribe` ran as a user-installed
// command in a server that never added the bot.
export async function auditSubscriptions(client: Client<true>, db: DB): Promise<void> {
	// An empty guild list means a broken READY, not removal from every server.
	if (client.guilds.cache.size === 0) return;
	const pruned: PruneReason[] = [];
	const blocked: Subscriber[] = [];
	let reachable = 0;
	let unverified = 0;
	for (const sub of db.listActive("guild_channel")) {
		const guild = sub.guild_id === null ? undefined : client.guilds.cache.get(sub.guild_id);
		if (sub.guild_id !== null && !guild) {
			pruneSubscriber(db, sub, "not_in_guild");
			pruned.push("not_in_guild");
			continue;
		}
		const me = guild?.members.me;
		let channel = guild?.channels.cache.get(sub.discord_id) ?? null;
		if (!channel && guild?.available && me) {
			// Not in the cache: deleted, or hidden from the bot. Ask the API which.
			try {
				const fetched = await client.channels.fetch(sub.discord_id);
				channel = fetched && !fetched.isDMBased() ? fetched : null;
			} catch (err) {
				const reason = pruneIfDead(client, db, sub, err);
				if (reason) {
					pruned.push(reason);
					continue;
				}
				if (isBlockedError(err, sub, (id) => client.guilds.cache.has(id))) {
					blocked.push(sub);
					continue;
				}
			}
		}
		if (!channel || !me) {
			unverified++;
		} else if (botCanPost(channel.permissionsFor(me), channel.isThread())) {
			reachable++;
		} else {
			blocked.push(sub);
		}
	}
	reportPruned("startup", pruned);
	log.info("subscriptions audited", {
		guilds: client.guilds.cache.size,
		reachable,
		cannotPost: blocked.length,
		unverified,
		dm: db.listActive("dm").length,
	});
	await noticeBlocked(client, db, blocked);
}

function subscribedChannelsIn(guild: Guild, db: DB): SubscribedChannel[] {
	const me = guild.members.me;
	return db
		.listActive("guild_channel")
		.filter((s) => s.guild_id === guild.id)
		.map((s) => {
			const channel = guild.channels.cache.get(s.discord_id);
			return {
				id: s.discord_id,
				canPost: channel && me ? botCanPost(channel.permissionsFor(me), channel.isThread()) : null,
			};
		});
}

function recordWelcomeFailure(
	deps: BotDeps,
	guildId: Snowflake,
	reason: "no_channel" | "missing_access" | "other",
	err?: unknown,
): void {
	deps.db.recordEvent({
		kind: "guild_welcome_failed",
		guildId,
		payload: err === undefined ? { reason } : { reason, err },
	});
}

async function handleCommand(
	interaction: ChatInputCommandInteraction,
	deps: BotDeps,
): Promise<void> {
	deps.db.recordEvent({
		kind: "command",
		guildId: interaction.guildId,
		channelId: interaction.channelId,
		userId: interaction.user.id,
		payload: {
			name: interaction.commandName,
			options: interaction.options.data.map((o) => ({ name: o.name, value: o.value })),
		},
	});
	log.debug("slash command", {
		name: interaction.commandName,
		scope: interaction.guildId ? "guild" : "dm",
		guildId: interaction.guildId,
		guildName: interaction.guild?.name,
		channelId: interaction.channelId,
		userId: interaction.user.id,
		userTag: interaction.user.tag,
	});
	switch (interaction.commandName) {
		case "subscribe":
			return cmdSubscribe(interaction, deps);
		case "unsubscribe":
			return cmdUnsubscribe(interaction, deps);
		case "status":
			return cmdStatus(interaction, deps);
		case "help":
			await interaction.reply({ content: HELP, flags: MessageFlags.Ephemeral });
			return;
	}
}

// Guild-channel subscribe/unsubscribe requires ManageGuild on every surface. The slash
// commands' default_member_permissions is only a default — admins can widen it per server,
// and user-installed commands carry no server permission gate — so the handler enforces it.
export function canManageGuildSubscriptions(perms: Readonly<PermissionsBitField> | null): boolean {
	return perms?.has(PermissionFlagsBits.ManageGuild) === true;
}

async function requireManageGuild(interaction: ChatInputCommandInteraction): Promise<boolean> {
	if (canManageGuildSubscriptions(interaction.memberPermissions)) return true;
	await interaction.reply({
		content: MENTION_INSUFFICIENT_PRIVILEGES,
		flags: MessageFlags.Ephemeral,
	});
	return false;
}

async function cmdSubscribe(
	interaction: ChatInputCommandInteraction,
	deps: BotDeps,
): Promise<void> {
	if (interaction.guildId) {
		if (!(await requireManageGuild(interaction))) return;
		if (!interaction.inCachedGuild()) {
			await interaction.reply({ content: GUILD_BOT_ABSENT, flags: MessageFlags.Ephemeral });
			return;
		}
		const target = interaction.options.getChannel("channel") ?? interaction.channel;
		if (!target) {
			await interaction.reply({
				content: "Could not resolve a channel.",
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
		const me = interaction.guild.members.me;
		if (!me || !botCanPost(target.permissionsFor(me), target.isThread())) {
			await interaction.reply({
				content: guildCannotPost(target.id),
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
		const result = deps.db.upsertSubscribed({
			kind: "guild_channel",
			discordId: target.id,
			guildId: interaction.guildId,
			now: new Date().toISOString(),
		});
		if (!result.created && !result.reactivated) {
			await interaction.reply({
				content: GUILD_ALREADY_SUBSCRIBED,
				flags: MessageFlags.Ephemeral,
			});
			return;
		}
		announceSubscribe(deps, {
			kind: "guild_channel",
			via: "command",
			guildId: interaction.guildId,
			channelId: target.id,
			guildName: interaction.guild.name,
			channelName: target.name,
			userId: interaction.user.id,
			userTag: interaction.user.tag,
			reactivated: result.reactivated,
		});
		await interaction.reply({ content: GUILD_SUBSCRIBE_OK });
		return;
	}

	const userId = interaction.user.id;
	const result = deps.db.upsertSubscribed({
		kind: "dm",
		discordId: userId,
		guildId: null,
		now: new Date().toISOString(),
	});
	const fresh = result.created || result.reactivated;
	if (fresh) {
		announceSubscribe(deps, {
			kind: "dm",
			via: "command",
			guildId: null,
			channelId: null,
			userId,
			userTag: interaction.user.tag,
			reactivated: result.reactivated,
		});
	}
	await interaction.reply({ content: fresh ? DM_SUBSCRIBE_OK : DM_ALREADY_SUBSCRIBED });
}

async function cmdUnsubscribe(
	interaction: ChatInputCommandInteraction,
	deps: BotDeps,
): Promise<void> {
	if (interaction.guildId) {
		if (!(await requireManageGuild(interaction))) return;
		if (!interaction.channelId) return;
		const removed = deps.db.markUnsubscribed("guild_channel", interaction.channelId);
		if (removed) {
			const ch = interaction.channel;
			announceUnsubscribe(deps, {
				kind: "guild_channel",
				via: "command",
				guildId: interaction.guildId,
				channelId: interaction.channelId,
				guildName: interaction.guild?.name,
				channelName: ch && "name" in ch ? (ch.name ?? undefined) : undefined,
				userId: interaction.user.id,
				userTag: interaction.user.tag,
			});
		}
		await interaction.reply({
			content: removed ? GUILD_UNSUBSCRIBE_OK : GUILD_NOT_SUBSCRIBED,
			...(removed ? {} : { flags: MessageFlags.Ephemeral }),
		});
		return;
	}

	const userId = interaction.user.id;
	const removed = deps.db.markUnsubscribed("dm", userId);
	if (removed) {
		announceUnsubscribe(deps, {
			kind: "dm",
			via: "command",
			guildId: null,
			channelId: null,
			userId,
			userTag: interaction.user.tag,
		});
	}
	await interaction.reply({ content: removed ? DM_UNSUBSCRIBE_OK : DM_NOT_SUBSCRIBED });
}

async function cmdStatus(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
	const lastAlert = deps.db.lastAlertForDisplay();
	const currentLevel = deps.db.getLevelState().emergency_level;
	const dmReport = () =>
		dmStatusReport({
			subscribed: deps.db.findSubscriber("dm", interaction.user.id)?.status === "active",
			lastAlert,
			currentLevel,
		});
	const content = !interaction.guildId
		? dmReport()
		: interaction.inCachedGuild()
			? guildStatusReport({
					channelId: interaction.channelId,
					channels: subscribedChannelsIn(interaction.guild, deps.db),
					lastAlert,
					currentLevel,
				})
			: `${GUILD_BOT_ABSENT}\n\n${dmReport()}`;
	await interaction.reply({ content, flags: MessageFlags.Ephemeral });
}

async function handleDM(message: Message, deps: BotDeps): Promise<void> {
	const userId = message.author.id;
	const intent = classifyDmText(message.content);

	deps.db.recordEvent({
		kind: "dm_in",
		userId,
		payload: { content: message.content, intent },
	});
	log.debug("dm in", {
		userId,
		userTag: message.author.tag,
		intent,
		content: message.content,
	});

	const reply = async (content: string) => {
		await message.reply(content);
		deps.db.recordEvent({ kind: "dm_out", userId, payload: { content } });
		log.debug("dm out", { userId, userTag: message.author.tag, content });
	};

	if (intent === "subscribe") {
		const result = deps.db.upsertSubscribed({
			kind: "dm",
			discordId: userId,
			guildId: null,
			now: new Date().toISOString(),
		});
		const fresh = result.created || result.reactivated;
		if (fresh) {
			announceSubscribe(deps, {
				kind: "dm",
				via: "dm",
				guildId: null,
				channelId: null,
				userId,
				userTag: message.author.tag,
				reactivated: result.reactivated,
			});
		}
		await reply(fresh ? DM_SUBSCRIBE_OK : DM_ALREADY_SUBSCRIBED);
		return;
	}

	if (intent === "unsubscribe") {
		const removed = deps.db.markUnsubscribed("dm", userId);
		if (removed) {
			announceUnsubscribe(deps, {
				kind: "dm",
				via: "dm",
				guildId: null,
				channelId: null,
				userId,
				userTag: message.author.tag,
			});
		}
		await reply(removed ? DM_UNSUBSCRIBE_OK : DM_NOT_SUBSCRIBED);
		return;
	}

	if (intent === "help") {
		await reply(HELP);
		return;
	}

	const sub = deps.db.findSubscriber("dm", userId);

	if (intent === "status") {
		await reply(
			dmStatusReport({
				subscribed: sub?.status === "active",
				lastAlert: deps.db.lastAlertForDisplay(),
				currentLevel: deps.db.getLevelState().emergency_level,
			}),
		);
		return;
	}

	if (!sub) {
		await reply(DM_OPT_IN_PROMPT);
		return;
	}

	await reply(
		pingPongLine({
			subscribed: sub.status === "active",
			lastAlert: deps.db.lastAlertForDisplay(),
			currentLevel: deps.db.getLevelState().emergency_level,
		}),
	);
}

async function handleMention(message: Message, deps: BotDeps, botUserId: Snowflake): Promise<void> {
	if (!message.inGuild()) return;
	const userId = message.author.id;
	const guildId = message.guildId;
	const channelId = message.channelId;
	const stripped = stripMention(message.content, botUserId);
	const intent = classifyMentionText(stripped);

	deps.db.recordEvent({
		kind: "mention_in",
		guildId,
		channelId,
		userId,
		payload: { content: message.content, stripped, intent },
	});
	log.debug("mention in", {
		guildId,
		guildName: message.guild?.name,
		channelId,
		channelName: mentionChannelName(message),
		userId,
		userTag: message.author.tag,
		intent,
		stripped,
	});

	const me = message.guild.members.me;
	const perms = me ? message.channel.permissionsFor(me) : null;
	// Without Send Messages the bot can neither confirm nor deliver; a subscription here would be dead.
	if (!botCanPost(perms, message.channel.isThread())) {
		log.debug("mention ignored: cannot post", { guildId, channelId });
		return;
	}
	// Replies need Read Message History, which the server invite does not request.
	const canReply = perms?.has(PermissionFlagsBits.ReadMessageHistory) === true;
	const reply = async (content: string) => {
		await (canReply ? message.reply(content) : message.channel.send(content));
		deps.db.recordEvent({ kind: "mention_out", guildId, channelId, userId, payload: { content } });
		log.debug("mention out", { guildId, channelId, userId, content });
	};

	if (intent === "help") {
		await reply(HELP);
		return;
	}

	if (intent === "status") {
		await reply(
			guildStatusReport({
				channelId,
				channels: subscribedChannelsIn(message.guild, deps.db),
				lastAlert: deps.db.lastAlertForDisplay(),
				currentLevel: deps.db.getLevelState().emergency_level,
			}),
		);
		return;
	}

	if (intent === "subscribe" || intent === "unsubscribe") {
		// message.member can be null in uncached cases — treat as no permission.
		const hasPerm = canManageGuildSubscriptions(message.member?.permissions ?? null);
		if (!hasPerm) {
			await reply(MENTION_INSUFFICIENT_PRIVILEGES);
			return;
		}
		if (intent === "subscribe") {
			const result = deps.db.upsertSubscribed({
				kind: "guild_channel",
				discordId: channelId,
				guildId,
				now: new Date().toISOString(),
			});
			const fresh = result.created || result.reactivated;
			if (fresh) {
				announceSubscribe(deps, {
					kind: "guild_channel",
					via: "mention",
					guildId,
					channelId,
					guildName: message.guild?.name,
					channelName: mentionChannelName(message),
					userId,
					userTag: message.author.tag,
					reactivated: result.reactivated,
				});
			}
			await reply(fresh ? GUILD_SUBSCRIBE_OK : GUILD_ALREADY_SUBSCRIBED);
			return;
		}
		const removed = deps.db.markUnsubscribed("guild_channel", channelId);
		if (removed) {
			announceUnsubscribe(deps, {
				kind: "guild_channel",
				via: "mention",
				guildId,
				channelId,
				guildName: message.guild?.name,
				channelName: mentionChannelName(message),
				userId,
				userTag: message.author.tag,
			});
		}
		await reply(removed ? GUILD_UNSUBSCRIBE_OK : GUILD_NOT_SUBSCRIBED);
		return;
	}

	await reply(MENTION_UNKNOWN);
}

type AlertDispatchPayload = EventPayloadByKind["alert_dispatch_ok"];

// Per-recipient failures are caught individually and never throw to the caller.
async function fanOut(
	client: Client,
	deps: BotDeps,
	body: string,
	buildMeta: (sub: Subscriber) => AlertDispatchPayload,
): Promise<{ sent: number; failed: number }> {
	const subs = deps.db.listActive();
	const triage = new DeliveryTriage(client, deps.db);
	let sent = 0;
	let failed = 0;
	for (const sub of subs) {
		const where = subscriberAddress(sub);
		const meta = buildMeta(sub);
		try {
			await sendToSubscriber(client, sub, body);
			sent++;
			deps.db.recordEvent({ kind: "alert_dispatch_ok", ...where, payload: meta });
		} catch (err) {
			failed++;
			deps.db.recordEvent({
				kind: "alert_dispatch_fail",
				...where,
				payload: { ...meta, err },
			});
			if (triage.classify(sub, err) === "failed") {
				log.error("deliver failed", { err, kind: sub.kind, address: sub.discord_id });
			}
		}
	}
	await triage.finish("alert");
	return { sent, failed };
}

export function fanOutAlert(
	client: Client,
	deps: BotDeps,
	alert: AlertItem & { guid: string },
): Promise<{ sent: number; failed: number }> {
	return fanOut(client, deps, alertPayload(alert), (sub) => ({
		source: "rss",
		guid: alert.guid,
		kind: sub.kind,
	}));
}

export function fanOutLevelChange(
	client: Client,
	deps: BotDeps,
	change: LevelChange,
): Promise<{ sent: number; failed: number }> {
	return fanOut(client, deps, levelChangePayload(change), (sub) => ({
		source: "level_change",
		level: change.level,
		prevLevel: change.prevLevel,
		kind: sub.kind,
	}));
}

export async function sendToSubscriber(
	client: Client,
	sub: Subscriber,
	body: string,
): Promise<void> {
	if (sub.kind === "guild_channel") {
		const channel = await client.channels.fetch(sub.discord_id);
		if (!isSendable(channel)) throw new Error("channel not sendable");
		await channel.send(body);
		return;
	}
	const user = await client.users.fetch(sub.discord_id);
	await user.send(body);
}

interface AnnounceArgs {
	kind: SubscriberKind;
	via: SubscribeVia;
	guildId: Snowflake | null;
	channelId: Snowflake | null;
	guildName?: string | undefined;
	channelName?: string | undefined;
	userId: Snowflake;
	userTag: string;
}

function announceSubscribe(deps: BotDeps, args: AnnounceArgs & { reactivated: boolean }): void {
	deps.db.recordEvent({
		kind: "subscribe",
		guildId: args.guildId,
		channelId: args.channelId,
		userId: args.userId,
		payload: { kind: args.kind, via: args.via, reactivated: args.reactivated },
	});
	log.debug("subscribe", {
		kind: args.kind,
		via: args.via,
		reactivated: args.reactivated,
		guildId: args.guildId,
		guildName: args.guildName,
		channelId: args.channelId,
		channelName: args.channelName,
		userId: args.userId,
		userTag: args.userTag,
	});
}

function announceUnsubscribe(deps: BotDeps, args: AnnounceArgs): void {
	deps.db.recordEvent({
		kind: "unsubscribe",
		guildId: args.guildId,
		channelId: args.channelId,
		userId: args.userId,
		payload: { kind: args.kind, via: args.via },
	});
	log.debug("unsubscribe", {
		kind: args.kind,
		via: args.via,
		guildId: args.guildId,
		guildName: args.guildName,
		channelId: args.channelId,
		channelName: args.channelName,
		userId: args.userId,
		userTag: args.userTag,
	});
}

function mentionChannelName(message: Message): string | undefined {
	const ch = message.channel;
	if (ch && "name" in ch && typeof ch.name === "string") return ch.name;
	return undefined;
}

function isSendable(channel: unknown): channel is TextBasedChannel & {
	send: (s: string) => Promise<unknown>;
} {
	return (
		typeof channel === "object" &&
		channel !== null &&
		"send" in channel &&
		typeof channel.send === "function"
	);
}
