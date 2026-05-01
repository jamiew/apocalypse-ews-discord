// One-shot: registers slash commands globally for the bot's application.
// Global commands take up to ~1h to propagate. Run after deploying changes
// to command definitions in src/discord.ts.

import { registerCommands } from "../discord.js";
import { loadEnv } from "../env.js";

async function main() {
  const env = loadEnv();
  await registerCommands({
    token: env.DISCORD_TOKEN,
    clientId: env.DISCORD_CLIENT_ID,
  });
  console.log("registered global slash commands");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
