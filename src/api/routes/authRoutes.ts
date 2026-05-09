import type { FastifyPluginAsync } from "fastify";

import type {
  AuthLoginRequest,
  AuthLoginResponse,
  ListBroadcastTelegramIdsResponse,
  SessionMode,
  UpdatePreferencesRequest,
  UpdatePreferencesResponse,
  UserRole,
} from "../../shared/index.js";
import { isAdminRequest } from "../authz.js";
import { sendError, sendOk } from "../http.js";

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: AuthLoginRequest }>("/login", async (request, reply) => {
    const { telegramId, name } = request.body ?? {};

    if (!telegramId?.trim() || !name?.trim()) {
      sendError(reply, 400, "VALIDATION_ERROR", "telegramId and name are required");
      return;
    }

    const role: UserRole = app.apiConfig.adminTelegramId === telegramId ? "admin" : "student";
    const user = await app.userRepository.upsertByTelegram(telegramId.trim(), name.trim(), role);
    const payload: AuthLoginResponse = { user };

    sendOk(reply, payload);
  });

  app.patch<{ Body: UpdatePreferencesRequest }>("/preferences", async (request, reply) => {
    const userId = readUserIdFromHeader(request.headers["x-user-id"]);
    if (!userId) {
      sendError(reply, 400, "VALIDATION_ERROR", "x-user-id header is required");
      return;
    }

    const { mode, course, faculty, subjectId } = request.body ?? {};
    if (mode !== undefined && !isMode(mode)) {
      sendError(reply, 400, "VALIDATION_ERROR", "mode must be single, pack, exam-prep or interval");
      return;
    }
    if (course !== undefined && !isCourse(course)) {
      sendError(reply, 400, "VALIDATION_ERROR", "course must be an integer from 1 to 5");
      return;
    }
    if (faculty !== undefined && typeof faculty !== "string") {
      sendError(reply, 400, "VALIDATION_ERROR", "faculty must be a string");
      return;
    }
    if (subjectId !== undefined && typeof subjectId !== "string") {
      sendError(reply, 400, "VALIDATION_ERROR", "subjectId must be a string");
      return;
    }

    const user = await app.userRepository.updatePreferences(userId, {
      ...(mode ? { mode } : {}),
      ...(typeof course === "number" ? { course } : {}),
      ...(typeof faculty === "string" ? { faculty: faculty.trim() } : {}),
      ...(typeof subjectId === "string" ? { subjectId: subjectId.trim() } : {}),
    });
    const payload: UpdatePreferencesResponse = { user };
    sendOk(reply, payload);
  });

  app.get("/admin/broadcast/telegram-ids", async (request, reply) => {
    if (!isAdminRequest(request)) {
      sendError(reply, 403, "FORBIDDEN", "Admin role is required");
      return;
    }

    const adminTelegramId = readAdminTelegramIdFromHeader(request.headers["x-admin-telegram-id"]);
    if (!adminTelegramId) {
      sendError(reply, 400, "VALIDATION_ERROR", "x-admin-telegram-id header is required");
      return;
    }
    if (adminTelegramId !== app.apiConfig.adminTelegramId) {
      sendError(reply, 403, "FORBIDDEN", "Unknown admin telegram id");
      return;
    }

    const telegramIds = await app.userRepository.listTelegramIds();
    const payload: ListBroadcastTelegramIdsResponse = { telegramIds };
    sendOk(reply, payload);
  });
};

function readUserIdFromHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

function readAdminTelegramIdFromHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

function isMode(value: string): value is SessionMode {
  return value === "single" || value === "pack" || value === "exam-prep" || value === "interval";
}

function isCourse(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}
