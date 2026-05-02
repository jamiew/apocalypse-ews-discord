// TEST_GUILD_ID = guild-scoped (instant). Unset = global (~1h propagation).

import { commandDefinitions, registerCommands } from "../discord.js";
import { loadEnv } from "../env.js";
import { childLogger } from "../log.js";

const log = childLogger("register-commands");

async function main() {
	const env = loadEnv();
	await registerCommands({
		token: env.DISCORD_TOKEN,
		clientId: env.DISCORD_CLIENT_ID,
		guildId: env.TEST_GUILD_ID,
	});
	log.info("registered slash commands", {
		count: commandDefinitions.length,
		scope: env.TEST_GUILD_ID ? `guild=${env.TEST_GUILD_ID}` : "global",
	});
}

main().catch((err) => {
	childLogger("register-commands").error("register failed", { err });
	process.exit(1);
});
