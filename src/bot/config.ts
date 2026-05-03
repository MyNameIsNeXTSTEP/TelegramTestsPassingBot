export interface BotConfig {
  token: string;
  apiBaseUrl: string;
  testYooKassaToken: string;
  testYooKassaShopId: string;
  testYooKassaSecretKey: string;
}

export function loadBotConfig(): BotConfig {
  const token = process.env.BOT_TOKEN?.trim();
  if (!token) {
    throw new Error("BOT_TOKEN is required");
  }
  const testYooKassaToken = process.env.TEST_YOOKASSA_TOKEN?.trim();
  if (!testYooKassaToken) {
    throw new Error("TEST_YOOKASSA_TOKEN is required");
  }
  const testYooKassaShopId = process.env.TEST_YOOKASSA_SHOP_ID?.trim();
  if (!testYooKassaShopId) {
    throw new Error("TEST_YOOKASSA_SHOP_ID is required");
  }
  const testYooKassaSecretKey = process.env.TEST_YOOKASSA_SECRET_KEY?.trim();
  if (!testYooKassaSecretKey) {
    throw new Error("TEST_YOOKASSA_SECRET_KEY is required");
  }

  return {
    token,
    apiBaseUrl: (process.env.BOT_API_BASE_URL ?? "http://127.0.0.1:3001").replace(/\/+$/, ""),
    testYooKassaToken,
    testYooKassaShopId,
    testYooKassaSecretKey,
  };
}
