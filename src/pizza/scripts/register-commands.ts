// TEST_GUILD_ID = guild-scoped (instant). Unset = global (~1h propagation).

import { childLogger } from "../../log.js";
import { commandDefinitions, registerCommands } from "../discord.js";
import { loadPizzaEnv } from "../env.js";

const log = childLogger("pizza-register");

async function main() {
	const env = loadPizzaEnv();
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
	childLogger("pizza-register").error("register failed", { err });
	process.exit(1);
});
