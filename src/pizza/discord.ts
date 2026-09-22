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
	MessageFlags,
	Partials,
	PermissionFlagsBits,
	REST,
	Routes,
	SlashCommandBuilder,
	type Snowflake,
	type TextBasedChannel,
} from "discord.js";
import {
	BASE_INTENT_PATTERNS,
	classifyWelcomeError,
	classifyWith,
	formatOperatorDm,
	pickWelcomeChannelFrom,
	stripMention,
	type WelcomeChannelCandidate,
} from "../intent.js";
import { childLogger } from "../log.js";
import {
	DISCLAIMER,
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
	type LatestView,
	latestPayload,
	MENTION_INSUFFICIENT_PRIVILEGES,
	MENTION_UNKNOWN,
	pingPongLine,
	postUrl,
	signalChangePayload,
	statusLine,
} from "./copy.js";
import {
	type EventPayloadByKind,
	type PizzaDB,
	type PizzaIntent,
	type SignalChange,
	type Subscriber,
	type SubscriberKind,
	type SubscribeVia,
	subscriberAddress,
} from "./db.js";
import type { Busyness, SignalLevel } from "./signal.js";

const log = childLogger("pizza-discord");

const PIZZA_INTENT_PATTERNS = {
	...BASE_INTENT_PATTERNS,
	latest: [/^latest$/, /^last$/, /^now$/, /\blatest\b/, /\blast (?:report|reading|post)\b/],
} as const;

export function classifyPizzaText(raw: string): PizzaIntent {
	return classifyWith(PIZZA_INTENT_PATTERNS, raw);
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
		.setDescription("Receive Pentagon pizza signal changes (this channel, or you in a DM).")
		.addChannelOption((opt) =>
			opt
				.setName("channel")
				.setDescription("Server only: channel to post alerts in (defaults to current).")
				.addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
		)
		// ManageGuild only gates this in guild contexts; DMs are unrestricted.
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setIntegrationTypes(ALL_INSTALLS)
		.setContexts(ALL_CONTEXTS),
	new SlashCommandBuilder()
		.setName("unsubscribe")
		.setDescription("Stop receiving signal changes (this channel, or you in a DM).")
		.setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
		.setIntegrationTypes(ALL_INSTALLS)
		.setContexts(ALL_CONTEXTS),
	new SlashCommandBuilder()
		.setName("status")
		.setDescription("Show subscription state and the current signal level.")
		.setIntegrationTypes(ALL_INSTALLS)
		.setContexts(ALL_CONTEXTS),
	new SlashCommandBuilder()
		.setName("latest")
		.setDescription("Show the most recent reading from the source account.")
		.setIntegrationTypes(ALL_INSTALLS)
		.setContexts(ALL_CONTEXTS),
	new SlashCommandBuilder()
		.setName("help")
		.setDescription("How to use the Pentagon Pizza Watch bot.")
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

export interface PizzaDeps {
	db: PizzaDB;
	devAdminUserId?: Snowflake | undefined;
	operatorUserId?: Snowflake | undefined;
}

function asLevel(value: number | null): SignalLevel | null {
	if (value == null) return null;
	return value >= 1 && value <= 5 ? (value as SignalLevel) : null;
}

function asBusyness(value: number | null): Busyness | null {
	if (value == null) return null;
	return value >= -3 && value <= 3 ? (value as Busyness) : null;
}

/** Reconstructs the `/latest` view from the stored snapshot. */
export function latestViewFrom(deps: PizzaDeps): LatestView | null {
	const state = deps.db.getSignalState();
	const level = asLevel(state.level);
	if (level == null || !state.post_id || !state.post_text) return null;
	return {
		level,
		pizza: asBusyness(state.pizza),
		bar: asBusyness(state.bar),
		postText: state.post_text,
		postedAt: state.posted_at,
		url: postUrl(state.post_id),
	};
}

export function createClient(deps: PizzaDeps): Client {
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
		void onGuildCreate(guild, deps, client).catch((err) =>
			log.error("guildCreate failed", { err, guildId: guild.id }),
		);
	});

	client.on(Events.GuildDelete, (guild) => {
		const tenureMs = guild.joinedAt ? Date.now() - guild.joinedAt.getTime() : null;
		const payload = {
			name: guild.name,
			memberCount: guild.memberCount ?? null,
			tenureMs,
		};
		deps.db.recordEvent({ kind: "guild_delete", guildId: guild.id, payload });
		log.info("guild remove", { guildId: guild.id, ...payload });
		void notifyOperator(
			client,
			deps,
			formatOperatorDm({
				header: "REMOVE",
				guildId: guild.id,
				guildName: guild.name,
				extras: [{ label: "members", value: String(guild.memberCount ?? "?") }],
			}),
		);
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
		// In guild channels: only react when the bot is mentioned.
		const me = client.user;
		if (!me || !message.mentions.users.has(me.id)) return;
		void handleMention(message, deps, client, me.id).catch((err) =>
			log.error("mention handler failed", { err, channelId: message.channelId }),
		);
	});

	return client;
}

async function onGuildCreate(guild: Guild, deps: PizzaDeps, client: Client): Promise<void> {
	const me = guild.members.me;
	if (!me) return;

	const owner = await guild.fetchOwner().catch(() => null);
	const info: EventPayloadByKind["guild_create"] = {
		name: guild.name,
		memberCount: guild.memberCount,
		ownerId: owner?.id ?? guild.ownerId,
		ownerTag: owner?.user.tag ?? null,
		channelCount: guild.channels.cache.size,
		botJoinedAt: guild.joinedAt?.toISOString() ?? null,
	};

	deps.db.recordEvent({ kind: "guild_create", guildId: guild.id, payload: info });
	log.info("guild install", { guildId: guild.id, ...info });
	void notifyOperator(
		client,
		deps,
		formatOperatorDm({
			header: "INSTALL",
			guildId: guild.id,
			guildName: guild.name,
			extras: [
				{ label: "owner", value: `${info.ownerTag ?? "<unknown>"} (${info.ownerId})` },
				{ label: "members", value: String(info.memberCount) },
				{ label: "channels", value: String(info.channelCount) },
			],
		}),
	);

	const candidates: WelcomeChannelCandidate[] = guild.channels.cache.map((c) => ({
		id: c.id,
		type: c.type,
		position: "position" in c ? (c.position ?? 0) : 0,
		canSend: c.permissionsFor(me)?.has(PermissionFlagsBits.SendMessages) === true,
	}));
	const sys = guild.systemChannel;
	const sysCandidate = sys ? (candidates.find((c) => c.id === sys.id) ?? null) : null;
	const picked = pickWelcomeChannelFrom(sysCandidate, candidates);
	const channel = picked ? guild.channels.cache.get(picked.id) : undefined;

	if (!picked || !isSendable(channel)) {
		deps.db.recordEvent({
			kind: "guild_welcome_failed",
			guildId: guild.id,
			payload: { reason: "no_channel" },
		});
		return;
	}

	try {
		await channel.send(GUILD_WELCOME);
	} catch (err) {
		const reason = classifyWelcomeError(err);
		deps.db.recordEvent({
			kind: "guild_welcome_failed",
			guildId: guild.id,
			payload: { reason, err },
		});
		log.warn("welcome send failed", { guildId: guild.id, reason, err });
		return;
	}

	deps.db.recordEvent({
		kind: "guild_welcome_sent",
		guildId: guild.id,
		channelId: picked.id,
	});

	// Auto-subscribe the welcome channel so a fresh server gets alerts without
	// anyone having to run /subscribe.
	const result = deps.db.upsertSubscribed({
		kind: "guild_channel",
		discordId: picked.id,
		guildId: guild.id,
		now: new Date().toISOString(),
	});
	if (result.created || result.reactivated) {
		announceSubscribe(client, deps, {
			kind: "guild_channel",
			via: "install",
			guildId: guild.id,
			channelId: picked.id,
			guildName: guild.name,
			channelName: "name" in channel ? channel.name : "",
			userId: owner?.id ?? guild.ownerId,
			userTag: owner?.user.tag ?? "<server owner>",
			reactivated: result.reactivated,
		});
	}
}

async function handleCommand(
	interaction: ChatInputCommandInteraction,
	deps: PizzaDeps,
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
	log.info("slash command", {
		name: interaction.commandName,
		scope: interaction.guildId ? "guild" : "dm",
		guildId: interaction.guildId,
		channelId: interaction.channelId,
		userId: interaction.user.id,
		userTag: interaction.user.tag,
	});
	switch (interaction.commandName) {
		case "subscribe":
			return cmdSubscribe(interaction, deps, client);
		case "unsubscribe":
			return cmdUnsubscribe(interaction, deps, client);
		case "status":
			await interaction.reply({
				content: statusForContext(interaction, deps),
				flags: MessageFlags.Ephemeral,
			});
			return;
		case "latest":
			await interaction.reply({ content: latestPayload(latestViewFrom(deps)) });
			return;
		case "help":
			await interaction.reply({
				content: `${HELP}\n\n${DISCLAIMER}`,
				flags: MessageFlags.Ephemeral,
			});
			return;
	}
}

function statusForContext(interaction: ChatInputCommandInteraction, deps: PizzaDeps): string {
	const sub = interaction.guildId
		? interaction.channelId
			? deps.db.findSubscriber("guild_channel", interaction.channelId)
			: undefined
		: deps.db.findSubscriber("dm", interaction.user.id);
	const state = deps.db.getSignalState();
	return statusLine({
		subscribed: sub?.status === "active",
		level: asLevel(state.level),
		postedAt: state.posted_at,
	});
}

async function cmdSubscribe(
	interaction: ChatInputCommandInteraction,
	deps: PizzaDeps,
	client: Client,
): Promise<void> {
	if (interaction.guildId) {
		const target = interaction.options.getChannel("channel") ?? interaction.channel;
		if (!target || !("id" in target)) {
			await interaction.reply({
				content: "Could not resolve a channel.",
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
		announceSubscribe(client, deps, {
			kind: "guild_channel",
			via: "command",
			guildId: interaction.guildId,
			channelId: target.id,
			guildName: interaction.guild?.name,
			channelName: "name" in target ? (target.name ?? undefined) : undefined,
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
		announceSubscribe(client, deps, {
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
	deps: PizzaDeps,
	client: Client,
): Promise<void> {
	if (interaction.guildId) {
		if (!interaction.channelId) return;
		const removed = deps.db.markUnsubscribed("guild_channel", interaction.channelId);
		if (removed) {
			const ch = interaction.channel;
			announceUnsubscribe(client, deps, {
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
		announceUnsubscribe(client, deps, {
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

async function handleDM(message: Message, deps: PizzaDeps, client: Client): Promise<void> {
	const userId = message.author.id;
	const intent = classifyPizzaText(message.content);

	deps.db.recordEvent({ kind: "dm_in", userId, payload: { content: message.content, intent } });
	log.info("dm in", { userId, userTag: message.author.tag, intent, content: message.content });

	const reply = async (content: string) => {
		await message.reply(content);
		deps.db.recordEvent({ kind: "dm_out", userId, payload: { content } });
		log.info("dm out", { userId, userTag: message.author.tag, content });
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
			announceSubscribe(client, deps, {
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
			announceUnsubscribe(client, deps, {
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
		await reply(`${HELP}\n\n${DISCLAIMER}`);
		return;
	}

	if (intent === "latest") {
		await reply(latestPayload(latestViewFrom(deps)));
		return;
	}

	const sub = deps.db.findSubscriber("dm", userId);
	const state = deps.db.getSignalState();

	if (intent === "status") {
		await reply(
			statusLine({
				subscribed: sub?.status === "active",
				level: asLevel(state.level),
				postedAt: state.posted_at,
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
			level: asLevel(state.level),
			postedAt: state.posted_at,
		}),
	);
}

async function handleMention(
	message: Message,
	deps: PizzaDeps,
	client: Client,
	botUserId: Snowflake,
): Promise<void> {
	if (!message.guildId || !message.channelId) return;
	const userId = message.author.id;
	const guildId = message.guildId;
	const channelId = message.channelId;
	const stripped = stripMention(message.content, botUserId);
	const intent = classifyPizzaText(stripped);

	deps.db.recordEvent({
		kind: "mention_in",
		guildId,
		channelId,
		userId,
		payload: { content: message.content, stripped, intent },
	});
	log.info("mention in", { guildId, channelId, userId, intent, stripped });

	const reply = async (content: string) => {
		await message.reply(content);
		deps.db.recordEvent({ kind: "mention_out", guildId, channelId, userId, payload: { content } });
		log.info("mention out", { guildId, channelId, userId, content });
	};

	if (intent === "help") {
		await reply(`${HELP}\n\n${DISCLAIMER}`);
		return;
	}

	if (intent === "latest") {
		await reply(latestPayload(latestViewFrom(deps)));
		return;
	}

	if (intent === "status") {
		const sub = deps.db.findSubscriber("guild_channel", channelId);
		const state = deps.db.getSignalState();
		await reply(
			statusLine({
				subscribed: sub?.status === "active",
				level: asLevel(state.level),
				postedAt: state.posted_at,
			}),
		);
		return;
	}

	if (intent === "subscribe" || intent === "unsubscribe") {
		// message.member can be null in uncached cases — treat as no permission.
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
				announceSubscribe(client, deps, {
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
			announceUnsubscribe(client, deps, {
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

// Per-recipient failures are caught individually and never throw to the caller.
export async function fanOutSignalChange(
	client: Client,
	deps: PizzaDeps,
	change: SignalChange,
): Promise<{ sent: number; failed: number }> {
	const body = signalChangePayload(change);
	const subs = deps.db.listActive();
	let sent = 0;
	let failed = 0;
	for (const sub of subs) {
		const where = subscriberAddress(sub);
		const meta = {
			postId: change.postId,
			level: change.level,
			prevLevel: change.prevLevel,
			kind: sub.kind,
		};
		try {
			await sendToSubscriber(client, sub, body);
			sent++;
			deps.db.recordEvent({ kind: "dispatch_ok", ...where, payload: meta });
		} catch (err) {
			failed++;
			log.error("deliver failed", { err, kind: sub.kind, address: sub.discord_id });
			deps.db.recordEvent({ kind: "dispatch_fail", ...where, payload: { ...meta, err } });
		}
	}
	return { sent, failed };
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

// Best-effort DM to the operator — never throws.
async function notifyOperator(client: Client, deps: PizzaDeps, content: string): Promise<void> {
	const id = deps.operatorUserId ?? deps.devAdminUserId;
	if (!id) return;
	try {
		const user = await client.users.fetch(id);
		await user.send(content);
		log.info("operator dm sent", { operatorId: id, header: content.split("\n")[0] });
	} catch (err) {
		log.warn("operator notify failed", { err, operatorId: id });
	}
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

function announceSubscribe(
	client: Client,
	deps: PizzaDeps,
	args: AnnounceArgs & { reactivated: boolean },
): void {
	deps.db.recordEvent({
		kind: "subscribe",
		guildId: args.guildId,
		channelId: args.channelId,
		userId: args.userId,
		payload: { kind: args.kind, via: args.via, reactivated: args.reactivated },
	});
	log.info("subscribe", { ...args });
	void notifyOperator(
		client,
		deps,
		formatOperatorDm({
			header: `SUBSCRIBE ${args.kind} via ${args.via}${args.reactivated ? " (reactivated)" : ""}`,
			guildId: args.guildId,
			guildName: args.guildName,
			channelId: args.channelId,
			channelName: args.channelName,
			userId: args.userId,
			userTag: args.userTag,
		}),
	);
}

function announceUnsubscribe(client: Client, deps: PizzaDeps, args: AnnounceArgs): void {
	deps.db.recordEvent({
		kind: "unsubscribe",
		guildId: args.guildId,
		channelId: args.channelId,
		userId: args.userId,
		payload: { kind: args.kind, via: args.via },
	});
	log.info("unsubscribe", { ...args });
	void notifyOperator(
		client,
		deps,
		formatOperatorDm({
			header: `UNSUBSCRIBE ${args.kind} via ${args.via}`,
			guildId: args.guildId,
			guildName: args.guildName,
			channelId: args.channelId,
			channelName: args.channelName,
			userId: args.userId,
			userTag: args.userTag,
		}),
	);
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
		typeof (channel as { send: unknown }).send === "function"
	);
}
