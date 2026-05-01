// One-shot: registers slash commands globally for the bot's application.
// Global commands take up to ~1h to propagate. Run after deploying changes
// to command definitions in src/discord.ts.

import { commandDefinitions, registerCommands } from "../discord.js";
import { loadEnv } from "../env.js";
import { childLogger } from "../log.js";

const log = childLogger("register-commands");

async function main() {
  const env = loadEnv();
  await registerCommands({
    token: env.DISCORD_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
  });
  log.info("registered global slash commands", { count: commandDefinitions.length });
}

main().catch((err) => {
  childLogger("register-commands").error("register failed", { err });
  process.exit(1);
});
