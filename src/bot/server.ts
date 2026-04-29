import { buildBot } from "./bot.js";
import { loadBotConfig } from "./config.js";

async function start(): Promise<void> {
  const config = loadBotConfig();
  const bot = buildBot(config);

  await bot.launch();

  const stop = async (): Promise<void> => {
    await bot.stop();
    process.exit(0);
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

void start();
