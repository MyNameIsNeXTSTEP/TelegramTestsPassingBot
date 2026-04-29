import { resolve } from "node:path";

export interface ApiConfig {
  port: number;
  host: string;
  dbDir: string;
  dataDir: string;
  adminTelegramIds: Set<string>;
}

export function loadConfig(): ApiConfig {
  const dbDir = process.env.DB_DIR ?? resolve(process.cwd(), "db");
  const dataDir = process.env.DATA_DIR ?? resolve(process.cwd(), "data");
  const adminTelegramIds = new Set(
    (process.env.ADMIN_TELEGRAM_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );

  return {
    port: parseNumber(process.env.API_PORT, 3000),
    host: process.env.API_HOST ?? "0.0.0.0",
    dbDir,
    dataDir,
    adminTelegramIds,
  };
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
