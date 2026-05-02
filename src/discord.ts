import {
	ApplicationIntegrationType,
	ChannelType,
	type ChatInputCommandInteraction,
	Client,
	Events,
	GatewayIntentBits,
	type Guild,
	InteractionContextType,
	type Message,
	Partials,
	PermissionFlagsBits,
	REST,
	Routes,
	SlashCommandBuilder,
	type Snowflake,
	type TextBasedChannel,
} from "discord.js";
import {
	type AlertItem,
	alertPayload,
	DM_ALREADY_SUBSCRIBED,
	DM_NOT_SUBSCRIBED,
	DM_OPT_IN_PROMPT,
	DM_SUBSCRIBE_OK,
	DM_UNSUBSCRIBE_OK,
	GUILD_ALREADY_SUBSCRIBED,
	GUILD_NOT_SUBSCRIBED,
	GUILD_SUBSCRIBE_OK,
	GUILD_UNSUBSCRIBE_OK,
	GUILD_WELCOME,
	HELP,
	MENTION_INSUFFICIENT_PRIVILEGES,
	MENTION_UNKNOWN,
	pingPongLine,
	statusLine,
} from "./copy.js";
import type { DB, Subscriber } from "./db.js";
import { childLogger } from "./log.js";

const log = childLogger("discord");

/** What the user meant when they sent a DM. */
export type DmIntent = "subscribe" | "unsubscribe" | "other";

/** What the user meant when they @-mentioned the bot in a guild channel. */
export type MentionIntent = "subscribe" | "unsubscribe" | "status" | "help" | "other";

const SUBSCRIBE_KEYWORDS = new Set(["subscribe", "start", "yes", "y"]);
const UNSUBSCRIBE_KEYWORDS = new Set(["unsubscribe", "stop", "cancel", "quit", "end"]);
const STATUS_KEYWORDS = new Set(["status", "state"]);
const HELP_KEYWORDS = new Set(["help", "?"]);

/** Maps a raw DM body to a {@link DmIntent}. Trim + case-insensitive keyword set. */
export function classifyDmText(raw: string): DmIntent {
	const text = raw.trim().toLowerCase();
	if (SUBSCRIBE_KEYWORDS.has(text)) return "subscribe";
	if (UNSUBSCRIBE_KEYWORDS.has(text)) return "unsubscribe";
	return "other";
}

/**
 * Maps a raw @-mention body (with the mention prefix already stripped) to a
 * {@link MentionIntent}. Recognizes the same subscribe/unsubscribe keywords
 * as DMs, plus `status` and `help`.
 */
export function classifyMentionText(raw: string): MentionIntent {
	const text = raw.trim().toLowerCase();
	if (SUBSCRIBE_KEYWORDS.has(text)) return "subscribe";
	if (UNSUBSCRIBE_KEYWORDS.has(text)) return "unsubscribe";
	if (STATUS_KEYWORDS.has(text)) return "status";
	if (HELP_KEYWORDS.has(text)) return "help";
	return "other";
}

/** Strips bot user mentions (`<@id>` / `<@!id>`) from a message body. */
export function stripMention(content: string, botUserId: Snowflake): string {
	const re = new RegExp(`<@!?${botUserId}>`, "g");
	return content.replace(re, "").trim();
}

/**
 * Channel-shape just enough to pick a welcome channel. Lets us test the
 * selection logic without constructing a full discord.js Guild fixture.
 */
export interface WelcomeChannelCandidate {
	id: Snowflake;
	type: ChannelType;
	position: number;
	canSend: boolean;
}

/**
 * Picks where to post the install-welcome message: prefer the guild's system
 * channel if the bot can speak there; otherwise the lowest-position text
 * channel the bot can send to. Returns null if there's nowhere to post.
 */
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

// Commands work in three contexts: server channels (guild install), DMs with
// the bot (user install or guild install), and other private channels (user
// install). The handler reads `interaction.guildId` to decide whether the
// command targets a guild channel or the invoking user.
const allContexts = (): InteractionContextType[] => [
	InteractionContextType.Guild,
	InteractionContextType.BotDM,
	InteractionContextType.PrivateChannel,
];
const guildOnly = (): InteractionContextType[] => [InteractionContextType.Guild];
const allInstalls = (): ApplicationIntegrationType[] => [
	ApplicationIntegrationType.GuildInstall,
	ApplicationIntegrationType.UserInstall,
];

export const commandDefinitions = [
	new SlashCommandBuilder()
		.setName("subscribe")
		.setDescription("Receive emergency level 5 alerts (this channel in a server, or you in a DM).")
		.addChannelOption((opt) =>
			opt
				.setName("channel")
				.setDescription("Server only: channel to post alerts in (defaults to current).")
				.addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
		)
		// ManageGuild only gates the command in guild contexts; in DMs / private
		// channels the user is operating on themselves, so no permission is needed.
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setIntegrationTypes(allInstalls())
		.setContexts(allContexts()),
	new SlashCommandBuilder()
		.setName("unsubscribe")
		.setDescription("Stop receiving alerts (this channel in a server, or you in a DM).")
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setIntegrationTypes(allInstalls())
		.setContexts(allContexts()),
	new SlashCommandBuilder()
		.setName("status")
		.setDescription("Show subscription state and the last incident on record.")
		.setIntegrationTypes(allInstalls())
		.setContexts(allContexts()),
	new SlashCommandBuilder()
		.setName("help")
		.setDescription("How to use the Apocalypse EWS bot.")
		.setIntegrationTypes(allInstalls())
		.setContexts(allContexts()),
	new SlashCommandBuilder()
		.setName("dev-fire")
		.setDescription("Admin only — synthesize an alert event for testing.")
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
		.setIntegrationTypes(allInstalls())
		.setContexts(guildOnly()),
].map((c) => c.toJSON());

/**
 * Push the {@link commandDefinitions} to Discord. If `guildId` is provided,
 * registers them as guild-scoped (instant propagation, what you want in dev);
 * otherwise registers them globally (~1h propagation, what you want in prod).
 */
export async function registerCommands(args: {
	token: string;
	clientId: string;
	guildId?: Snowflake;
}): Promise<void> {
	const rest = new REST({ version: "10" }).setToken(args.token);
	const route = args.guildId
		? Routes.applicationGuildCommands(args.clientId, args.guildId)
		: Routes.applicationCommands(args.clientId);
	await rest.put(route, { body: commandDefinitions });
}

/** Shared dependencies threaded through the client's event handlers. */
export interface BotDeps {
	db: DB;
	/** Discord user id allowed to invoke the hidden /dev-fire admin command. */
	devAdminUserId?: Snowflake;
	/**
	 * Discord user id that gets DM'd on guild install / subscribe / unsubscribe.
	 * Used by {@link notifyOperator}. Falls back to {@link devAdminUserId}
	 * at the call site.
	 */
	operatorUserId?: Snowflake;
}

/** Builds and configures the discord.js client; caller is responsible for `login`. */
export function createClient(deps: BotDeps): Client {
	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.DirectMessages,
			GatewayIntentBits.MessageContent,
		],
		// Required so messageCreate fires for DM channels not yet cached.
		partials: [Partials.Channel, Partials.Message],
	});

	client.once(Events.ClientReady, (c) => {
		log.info("logged in", { tag: c.user.tag, id: c.user.id });
	});

	client.on(Events.GuildCreate, (guild) => {
		deps.db.recordEvent({
			kind: "guild_create",
			guildId: guild.id,
			payload: { name: guild.name, memberCount: guild.memberCount },
		});
		void notifyOperator(
			client,
			deps,
			`INSTALL. Guild "${guild.name}" (id=${guild.id}, members=${guild.memberCount}) added the bot.`,
		);
		void onGuildCreate(guild, deps).catch((err) =>
			log.error("guildCreate failed", { err, guildId: guild.id }),
		);
	});

	client.on(Events.GuildDelete, (guild) => {
		deps.db.recordEvent({
			kind: "guild_delete",
			guildId: guild.id,
			payload: { name: guild.name },
		});
	});

	client.on(Events.InteractionCreate, (interaction) => {
		if (!interaction.isChatInputCommand()) return;
		void handleCommand(interaction, deps, client).catch((err) => {
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
			void handleDM(message, deps, client).catch((err) =>
				log.error("dm handler failed", { err, userId: message.author.id }),
			);
			return;
		}
		// Guild channel: only react when the bot itself is mentioned. Avoids
		// chiming in on every message in a subscribed channel.
		const me = client.user;
		if (!me || !message.mentions.users.has(me.id)) return;
		void handleMention(message, deps, client, me.id).catch((err) =>
			log.error("mention handler failed", { err, channelId: message.channelId }),
		);
	});

	return client;
}

async function onGuildCreate(guild: Guild, deps: BotDeps): Promise<void> {
	const me = guild.members.me;
	if (!me) return;
	const candidates: WelcomeChannelCandidate[] = guild.channels.cache.map((c) => ({
		id: c.id,
		type: c.type,
		position: "position" in c ? (c.position ?? 0) : 0,
		canSend: c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) === true,
	}));
	const sys = guild.systemChannel;
	const sysCandidate = sys ? (candidates.find((c) => c.id === sys.id) ?? null) : null;
	const picked = pickWelcomeChannelFrom(sysCandidate, candidates);
	if (!picked) return;
	const channel = guild.channels.cache.get(picked.id);
	if (!isSendable(channel)) return;
	await channel.send(GUILD_WELCOME);
	deps.db.recordEvent({
		kind: "guild_welcome_sent",
		guildId: guild.id,
		channelId: picked.id,
	});
}

async function handleCommand(
	interaction: ChatInputCommandInteraction,
	deps: BotDeps,
	client: Client,
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
	switch (interaction.commandName) {
		case "subscribe":
			return cmdSubscribe(interaction, deps, client);
		case "unsubscribe":
			return cmdUnsubscribe(interaction, deps, client);
		case "status":
			return cmdStatus(interaction, deps);
		case "help":
			await interaction.reply({ content: HELP, ephemeral: true });
			return;
		case "dev-fire":
			return cmdDevFire(interaction, deps, client);
	}
}

async function cmdSubscribe(
	interaction: ChatInputCommandInteraction,
	deps: BotDeps,
	client: Client,
): Promise<void> {
	if (interaction.guildId) {
		const target = interaction.options.getChannel("channel") ?? interaction.channel;
		if (!target || !("id" in target)) {
			await interaction.reply({ content: "Could not resolve a channel.", ephemeral: true });
			return;
		}
		const result = deps.db.upsertSubscribed({
			kind: "guild_channel",
			discordId: target.id,
			guildId: interaction.guildId,
			now: new Date().toISOString(),
		});
		if (!result.created && !result.reactivated) {
			await interaction.reply({ content: GUILD_ALREADY_SUBSCRIBED, ephemeral: true });
			return;
		}
		deps.db.recordEvent({
			kind: "subscribe",
			guildId: interaction.guildId,
			channelId: target.id,
			userId: interaction.user.id,
			payload: { kind: "guild_channel", reactivated: result.reactivated },
		});
		void notifyOperator(
			client,
			deps,
			`SUBSCRIBE. guild_channel guild=${interaction.guildId} channel=${target.id} by user=${interaction.user.tag} (${interaction.user.id})${result.reactivated ? " (reactivated)" : ""}`,
		);
		await interaction.reply({ content: GUILD_SUBSCRIBE_OK });
		return;
	}

	// DM / private channel: subscribe the invoking user to DM alerts.
	const userId = interaction.user.id;
	const result = deps.db.upsertSubscribed({
		kind: "dm",
		discordId: userId,
		guildId: null,
		now: new Date().toISOString(),
	});
	const fresh = result.created || result.reactivated;
	if (fresh) {
		deps.db.recordEvent({
			kind: "subscribe",
			userId,
			payload: { kind: "dm", reactivated: result.reactivated, via: "command" },
		});
		void notifyOperator(
			client,
			deps,
			`SUBSCRIBE. dm user=${interaction.user.tag} (${userId})${result.reactivated ? " (reactivated)" : ""} via=command`,
		);
	}
	await interaction.reply({ content: fresh ? DM_SUBSCRIBE_OK : DM_ALREADY_SUBSCRIBED });
}

async function cmdUnsubscribe(
	interaction: ChatInputCommandInteraction,
	deps: BotDeps,
	client: Client,
): Promise<void> {
	if (interaction.guildId) {
		if (!interaction.channelId) return;
		const removed = deps.db.markUnsubscribed("guild_channel", interaction.channelId);
		if (removed) {
			deps.db.recordEvent({
				kind: "unsubscribe",
				guildId: interaction.guildId,
				channelId: interaction.channelId,
				userId: interaction.user.id,
				payload: { kind: "guild_channel" },
			});
			void notifyOperator(
				client,
				deps,
				`UNSUBSCRIBE. guild_channel guild=${interaction.guildId} channel=${interaction.channelId} by user=${interaction.user.tag} (${interaction.user.id})`,
			);
		}
		await interaction.reply({
			content: removed ? GUILD_UNSUBSCRIBE_OK : GUILD_NOT_SUBSCRIBED,
			ephemeral: !removed,
		});
		return;
	}

	const userId = interaction.user.id;
	const removed = deps.db.markUnsubscribed("dm", userId);
	if (removed) {
		deps.db.recordEvent({
			kind: "unsubscribe",
			userId,
			payload: { kind: "dm", via: "command" },
		});
		void notifyOperator(
			client,
			deps,
			`UNSUBSCRIBE. dm user=${interaction.user.tag} (${userId}) via=command`,
		);
	}
	await interaction.reply({ content: removed ? DM_UNSUBSCRIBE_OK : DM_NOT_SUBSCRIBED });
}

async function cmdStatus(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
	const sub = interaction.guildId
		? interaction.channelId
			? deps.db.findSubscriber("guild_channel", interaction.channelId)
			: undefined
		: deps.db.findSubscriber("dm", interaction.user.id);
	await interaction.reply({
		content: statusLine({
			subscribed: sub?.status === "active",
			lastAlert: deps.db.lastAlertForDisplay(),
		}),
		ephemeral: true,
	});
}

async function cmdDevFire(
	interaction: ChatInputCommandInteraction,
	deps: BotDeps,
	client: Client,
): Promise<void> {
	if (!deps.devAdminUserId || interaction.user.id !== deps.devAdminUserId) {
		await interaction.reply({ content: "Not authorized.", ephemeral: true });
		return;
	}
	await interaction.reply({ content: "Firing test alert.", ephemeral: true });
	await fanOutAlert(client, deps, {
		title: "Test alert (dev-fire).",
		link: "https://ews.kylemcdonald.net/",
		pubDate: new Date().toUTCString(),
	});
}

async function handleDM(message: Message, deps: BotDeps, client: Client): Promise<void> {
	const userId = message.author.id;
	const intent = classifyDmText(message.content);

	deps.db.recordEvent({
		kind: "dm_in",
		userId,
		payload: { content: message.content, intent },
	});

	const reply = async (content: string) => {
		await message.reply(content);
		deps.db.recordEvent({ kind: "dm_out", userId, payload: { content } });
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
			deps.db.recordEvent({
				kind: "subscribe",
				userId,
				payload: { kind: "dm", reactivated: result.reactivated, via: "dm" },
			});
			void notifyOperator(
				client,
				deps,
				`SUBSCRIBE. dm user=${message.author.tag} (${userId})${result.reactivated ? " (reactivated)" : ""} via=dm`,
			);
		}
		await reply(fresh ? DM_SUBSCRIBE_OK : DM_ALREADY_SUBSCRIBED);
		return;
	}

	if (intent === "unsubscribe") {
		const removed = deps.db.markUnsubscribed("dm", userId);
		if (removed) {
			deps.db.recordEvent({ kind: "unsubscribe", userId, payload: { kind: "dm", via: "dm" } });
			void notifyOperator(
				client,
				deps,
				`UNSUBSCRIBE. dm user=${message.author.tag} (${userId}) via=dm`,
			);
		}
		await reply(removed ? DM_UNSUBSCRIBE_OK : DM_NOT_SUBSCRIBED);
		return;
	}

	const sub = deps.db.findSubscriber("dm", userId);

	// First-contact prompt for never-subscribed users.
	if (!sub) {
		await reply(DM_OPT_IN_PROMPT);
		return;
	}

	// Ping/pong for any other input.
	await reply(
		pingPongLine({
			subscribed: sub.status === "active",
			lastAlert: deps.db.lastAlertForDisplay(),
		}),
	);
}

async function handleMention(
	message: Message,
	deps: BotDeps,
	client: Client,
	botUserId: Snowflake,
): Promise<void> {
	if (!message.guildId || !message.channelId) return;
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

	const reply = async (content: string) => {
		await message.reply(content);
		deps.db.recordEvent({ kind: "mention_out", guildId, channelId, userId, payload: { content } });
	};

	if (intent === "help") {
		await reply(HELP);
		return;
	}

	if (intent === "status") {
		const sub = deps.db.findSubscriber("guild_channel", channelId);
		await reply(
			statusLine({
				subscribed: sub?.status === "active",
				lastAlert: deps.db.lastAlertForDisplay(),
			}),
		);
		return;
	}

	if (intent === "subscribe" || intent === "unsubscribe") {
		// Same gate as the slash command. message.member can be null in rare
		// uncached cases — treat that as no permission rather than crashing.
		const hasPerm = message.member?.permissions.has(PermissionFlagsBits.ManageGuild) === true;
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
				deps.db.recordEvent({
					kind: "subscribe",
					guildId,
					channelId,
					userId,
					payload: { kind: "guild_channel", reactivated: result.reactivated, via: "mention" },
				});
				void notifyOperator(
					client,
					deps,
					`SUBSCRIBE. guild_channel guild=${guildId} channel=${channelId} by user=${message.author.tag} (${userId})${result.reactivated ? " (reactivated)" : ""} via=mention`,
				);
			}
			await reply(fresh ? GUILD_SUBSCRIBE_OK : GUILD_ALREADY_SUBSCRIBED);
			return;
		}
		const removed = deps.db.markUnsubscribed("guild_channel", channelId);
		if (removed) {
			deps.db.recordEvent({
				kind: "unsubscribe",
				guildId,
				channelId,
				userId,
				payload: { kind: "guild_channel", via: "mention" },
			});
			void notifyOperator(
				client,
				deps,
				`UNSUBSCRIBE. guild_channel guild=${guildId} channel=${channelId} by user=${message.author.tag} (${userId}) via=mention`,
			);
		}
		await reply(removed ? GUILD_UNSUBSCRIBE_OK : GUILD_NOT_SUBSCRIBED);
		return;
	}

	await reply(MENTION_UNKNOWN);
}

/**
 * Delivers `alert` to every active subscriber. Per-subscriber failures are
 * caught and recorded as `alert_dispatch_fail` events; the function never
 * throws to the caller. Returns aggregate sent/failed counts.
 */
export async function fanOutAlert(
	client: Client,
	deps: BotDeps,
	alert: AlertItem & { guid?: string },
): Promise<{ sent: number; failed: number }> {
	const subs = deps.db.listActive();
	let sent = 0;
	let failed = 0;
	const body = alertPayload(alert);
	for (const sub of subs) {
		const eventBase = {
			guildId: sub.guild_id,
			channelId: sub.kind === "guild_channel" ? sub.discord_id : null,
			userId: sub.kind === "dm" ? sub.discord_id : null,
		};
		try {
			await sendToSubscriber(client, sub, body);
			sent++;
			deps.db.recordEvent({
				kind: "alert_dispatch_ok",
				...eventBase,
				payload: { guid: alert.guid, kind: sub.kind },
			});
		} catch (err) {
			failed++;
			log.error("deliver failed", { err, kind: sub.kind, address: sub.discord_id });
			deps.db.recordEvent({
				kind: "alert_dispatch_fail",
				...eventBase,
				payload: { guid: alert.guid, kind: sub.kind, err },
			});
		}
	}
	return { sent, failed };
}

/**
 * Sends `body` to a single subscriber, routing by kind: REST send to a guild
 * channel, or a DM to a user. Throws if the channel is missing or unsendable.
 */
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

/**
 * DM the operator (if configured) with a short status line. Best-effort —
 * a closed DM, network blip, or missing operator id never throws.
 */
async function notifyOperator(client: Client, deps: BotDeps, content: string): Promise<void> {
	const id = deps.operatorUserId ?? deps.devAdminUserId;
	if (!id) return;
	try {
		const user = await client.users.fetch(id);
		await user.send(content);
	} catch (err) {
		log.warn("operator notify failed", { err, operatorId: id });
	}
}

function isSendable(channel: unknown): channel is TextBasedChannel & {
	send: (s: string) => Promise<unknown>;
} {
	return (
		typeof channel === "object" &&
		channel !== null &&
		"send" in channel &&
		typeof (channel as { send: unknown }).send === "function"
	);
}
