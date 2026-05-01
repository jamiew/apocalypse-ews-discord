// One-shot: registers slash commands. Run after changing command definitions
// in src/discord.ts, or after first deploy.
//
// If TEST_GUILD_ID is set, registers as guild-scoped to that guild only —
// commands appear instantly. Otherwise registers globally, which takes ~1h
// to propagate.

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
