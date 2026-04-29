import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { User, UserRole } from "../../shared/index.js";
import { readJsonFile, writeJsonFile } from "../storage/jsonStore.js";

export class UserRepository {
  private readonly path: string;

  public constructor(dataDir: string) {
    this.path = join(dataDir, "users.json");
  }

  public async findByTelegramId(telegramId: string): Promise<User | null> {
    const users = await this.readAll();
    return users.find((user) => user.telegramId === telegramId) ?? null;
  }

  public async findById(id: string): Promise<User | null> {
    const users = await this.readAll();
    return users.find((user) => user.id === id) ?? null;
  }

  public async upsertByTelegram(
    telegramId: string,
    name: string,
    role: UserRole,
  ): Promise<User> {
    const users = await this.readAll();
    const now = new Date().toISOString();
    const existing = users.find((user) => user.telegramId === telegramId);

    if (existing) {
      existing.name = name;
      existing.role = role;
      existing.updatedAtIso = now;
      await this.writeAll(users);
      return existing;
    }

    const newUser: User = {
      id: randomUUID(),
      telegramId,
      name,
      role,
      planCode: "free",
      dailyUsage: {
        dateIso: now.slice(0, 10),
        sessionsStarted: 0,
        questionsAnswered: 0,
      },
      createdAtIso: now,
      updatedAtIso: now,
    };

    users.push(newUser);
    await this.writeAll(users);
    return newUser;
  }

  private async readAll(): Promise<User[]> {
    return readJsonFile<User[]>(this.path, []);
  }

  private async writeAll(users: User[]): Promise<void> {
    await writeJsonFile(this.path, users);
  }
}
