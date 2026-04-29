import type { FastifyPluginAsync } from "fastify";

import type {
  ChangeUserPlanRequest,
  ListPlansResponse,
  UpsertPlanRequest,
} from "../../shared/index.js";
import { isAdminRequest } from "../authz.js";
import { sendError, sendOk } from "../http.js";

export const subscriptionRoutes: FastifyPluginAsync = async (app) => {
  app.get("/plans", async (_request, reply) => {
    const plans = await app.subscriptionService.listPlans();
    const payload: ListPlansResponse = { plans };
    sendOk(reply, payload);
  });

  app.post<{ Body: UpsertPlanRequest }>("/admin/plans", async (request, reply) => {
    if (!isAdminRequest(request)) {
      sendError(reply, 403, "FORBIDDEN", "Admin role required");
      return;
    }

    try {
      const plan = request.body?.plan;
      if (!plan) {
        sendError(reply, 400, "VALIDATION_ERROR", "plan payload is required");
        return;
      }

      const saved = await app.subscriptionService.upsertPlan(plan);
      sendOk(reply, { plan: saved });
    } catch (error) {
      sendError(reply, 400, "UPSERT_PLAN_FAILED", toErrorMessage(error));
    }
  });

  app.patch<{ Body: ChangeUserPlanRequest }>("/admin/users/plan", async (request, reply) => {
    if (!isAdminRequest(request)) {
      sendError(reply, 403, "FORBIDDEN", "Admin role required");
      return;
    }

    const { userId, planCode } = request.body ?? {};
    if (!userId?.trim() || !planCode?.trim()) {
      sendError(reply, 400, "VALIDATION_ERROR", "userId and planCode are required");
      return;
    }

    try {
      const user = await app.subscriptionService.changeUserPlan(userId.trim(), planCode.trim());
      sendOk(reply, { user });
    } catch (error) {
      sendError(reply, 400, "CHANGE_USER_PLAN_FAILED", toErrorMessage(error));
    }
  });

  app.patch<{ Body: { planCode: string } }>("/me/plan", async (request, reply) => {
    const userId = readUserIdFromHeader(request.headers["x-user-id"]);
    if (!userId) {
      sendError(reply, 400, "VALIDATION_ERROR", "x-user-id header is required");
      return;
    }

    const { planCode } = request.body ?? {};
    if (!planCode?.trim()) {
      sendError(reply, 400, "VALIDATION_ERROR", "planCode is required");
      return;
    }

    try {
      const user = await app.subscriptionService.changeUserPlan(userId, planCode.trim());
      sendOk(reply, { user });
    } catch (error) {
      sendError(reply, 400, "CHANGE_USER_PLAN_FAILED", toErrorMessage(error));
    }
  });
};

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function readUserIdFromHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  return null;
}
