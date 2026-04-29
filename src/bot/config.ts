export interface BotConfig {
  token: string;
  apiBaseUrl: string;
}

export function loadBotConfig(): BotConfig {
  const token = process.env.BOT_TOKEN?.trim();
  if (!token) {
    throw new Error("BOT_TOKEN is required");
  }

  return {
    token,
    apiBaseUrl: (process.env.BOT_API_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),
  };
}
