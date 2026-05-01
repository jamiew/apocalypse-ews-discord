import {
  ChannelType,
  type ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
  type Message,
  Partials,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
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
  pingPongLine,
  statusLine,
} from "./copy.js";
import type { DB, Subscriber } from "./db.js";
import { childLogger } from "./log.js";

const log = childLogger("discord");

export type DmIntent = "subscribe" | "unsubscribe" | "other";

const SUBSCRIBE_KEYWORDS = new Set(["subscribe", "start", "yes", "y"]);
const UNSUBSCRIBE_KEYWORDS = new Set(["unsubscribe", "stop", "cancel", "quit", "end"]);

export function classifyDmText(raw: string): DmIntent {
  const text = raw.trim().toLowerCase();
  if (SUBSCRIBE_KEYWORDS.has(text)) return "subscribe";
  if (UNSUBSCRIBE_KEYWORDS.has(text)) return "unsubscribe";
  return "other";
}

// Channel-shape just enough to pick a welcome channel. Lets us test the
// selection logic without constructing a full discord.js Guild fixture.
export interface WelcomeChannelCandidate {
  id: string;
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

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("subscribe")
    .setDescription("Receive emergency level 5 alerts in a channel.")
    .addChannelOption((opt) =>
      opt
        .setName("channel")
        .setDescription("Channel to post alerts in (defaults to current).")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("unsubscribe")
    .setDescription("Stop receiving alerts in this channel.")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show subscription state and the last alert on record.")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("How to use the Apocalypse EWS bot.")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("dev-fire")
    .setDescription("Admin only — synthesize an alert event for testing.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
].map((c) => c.toJSON());

export async function registerCommands(args: { token: string; clientId: string }): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(args.token);
  await rest.put(Routes.applicationCommands(args.clientId), {
    body: commandDefinitions,
  });
}

export interface BotDeps {
  db: DB;
  devAdminUserId?: string;
}

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
    void onGuildCreate(guild).catch((err) =>
      log.error("guildCreate failed", { err, guildId: guild.id }),
    );
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    void handleCommand(interaction, deps, client).catch((err) => {
      log.error("command failed", { err, command: interaction.commandName });
    });
  });

  client.on(Events.MessageCreate, (message) => {
    if (message.author.bot) return;
    if (message.channel.type !== ChannelType.DM) return;
    void handleDM(message, deps).catch((err) =>
      log.error("dm handler failed", { err, userId: message.author.id }),
    );
  });

  return client;
}

async function onGuildCreate(guild: Guild): Promise<void> {
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
}

async function handleCommand(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
  client: Client,
): Promise<void> {
  switch (interaction.commandName) {
    case "subscribe":
      return cmdSubscribe(interaction, deps);
    case "unsubscribe":
      return cmdUnsubscribe(interaction, deps);
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
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "Run this command in a server.",
      ephemeral: true,
    });
    return;
  }
  const target = interaction.options.getChannel("channel") ?? interaction.channel;
  if (!target || !("id" in target)) {
    await interaction.reply({
      content: "Could not resolve a channel.",
      ephemeral: true,
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
      ephemeral: true,
    });
    return;
  }
  await interaction.reply({ content: GUILD_SUBSCRIBE_OK });
}

async function cmdUnsubscribe(
  interaction: ChatInputCommandInteraction,
  deps: BotDeps,
): Promise<void> {
  if (!interaction.channelId) {
    await interaction.reply({
      content: "Run this command in a server channel.",
      ephemeral: true,
    });
    return;
  }
  const removed = deps.db.markUnsubscribed("guild_channel", interaction.channelId);
  await interaction.reply({
    content: removed ? GUILD_UNSUBSCRIBE_OK : GUILD_NOT_SUBSCRIBED,
    ephemeral: !removed,
  });
}

async function cmdStatus(interaction: ChatInputCommandInteraction, deps: BotDeps): Promise<void> {
  if (!interaction.channelId) return;
  const sub = deps.db.findSubscriber("guild_channel", interaction.channelId);
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

async function handleDM(message: Message, deps: BotDeps): Promise<void> {
  const userId = message.author.id;
  const intent = classifyDmText(message.content);

  if (intent === "subscribe") {
    const result = deps.db.upsertSubscribed({
      kind: "dm",
      discordId: userId,
      guildId: null,
      now: new Date().toISOString(),
    });
    await message.reply(
      result.created || result.reactivated ? DM_SUBSCRIBE_OK : DM_ALREADY_SUBSCRIBED,
    );
    return;
  }

  if (intent === "unsubscribe") {
    const removed = deps.db.markUnsubscribed("dm", userId);
    await message.reply(removed ? DM_UNSUBSCRIBE_OK : DM_NOT_SUBSCRIBED);
    return;
  }

  const sub = deps.db.findSubscriber("dm", userId);

  // First-contact prompt for never-subscribed users.
  if (!sub) {
    await message.reply(DM_OPT_IN_PROMPT);
    return;
  }

  // Ping/pong for any other input.
  await message.reply(
    pingPongLine({
      subscribed: sub.status === "active",
      lastAlert: deps.db.lastAlertForDisplay(),
    }),
  );
}

export async function fanOutAlert(
  client: Client,
  deps: BotDeps,
  alert: AlertItem,
): Promise<{ sent: number; failed: number }> {
  const subs = deps.db.listActive();
  let sent = 0;
  let failed = 0;
  const body = alertPayload(alert);
  for (const sub of subs) {
    try {
      await sendToSubscriber(client, sub, body);
      sent++;
    } catch (err) {
      failed++;
      log.error("deliver failed", { err, kind: sub.kind, address: sub.discord_id });
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
