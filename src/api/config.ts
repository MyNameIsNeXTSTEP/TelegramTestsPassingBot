import { resolve } from "node:path";

export interface ApiConfig {
  port: number;
  host: string;
  dbDir: string;
  dataDir: string;
  adminTelegramId: string;
}

export function loadConfig(): ApiConfig {
  const dbDir = process.env.DB_DIR ?? resolve(process.cwd(), "db");
  const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), "data");
  const adminTelegramId = process.env.ADMIN_TELEGRAM_ID ?? '';

  return {
    port: parseNumber(process.env.API_PORT, 3001),
    host: process.env.API_HOST ?? "0.0.0.0",
    dbDir,
    dataDir,
    adminTelegramId,
  };
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
