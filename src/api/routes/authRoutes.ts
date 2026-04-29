import type { FastifyPluginAsync } from "fastify";

import type { AuthLoginRequest, AuthLoginResponse, UserRole } from "../../shared/index.js";
import { sendError, sendOk } from "../http.js";

export const authRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: AuthLoginRequest }>("/login", async (request, reply) => {
    const { telegramId, name } = request.body ?? {};

    if (!telegramId?.trim() || !name?.trim()) {
      sendError(reply, 400, "VALIDATION_ERROR", "telegramId and name are required");
      return;
    }

    const role: UserRole = app.apiConfig.adminTelegramIds.has(telegramId) ? "admin" : "student";
    const user = await app.userRepository.upsertByTelegram(telegramId.trim(), name.trim(), role);
    const payload: AuthLoginResponse = { user };

    sendOk(reply, payload);
  });
};
