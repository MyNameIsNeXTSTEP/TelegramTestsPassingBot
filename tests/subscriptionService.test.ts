import assert from "node:assert/strict";
import test from "node:test";

import type { SessionMode, SubscriptionPlan, User } from "../src/shared/index.js";
import { SubscriptionService } from "../src/api/services/subscriptionService.js";

test("free plan blocks single mode after 3 sessions per day", async () => {
  const service = createService({
    sessionCounts: { single: 3 },
    plan: createPlan("free"),
  });

  await assert.rejects(
    () => service.assertCanStartSession(createUser("free"), "single"),
    /3 раза в день/,
  );
});

test("free plan blocks practice mode after one session per day", async () => {
  const service = createService({
    sessionCounts: { pack: 1 },
    plan: createPlan("free"),
  });

  await assert.rejects(
    () => service.assertCanStartSession(createUser("free"), "pack"),
    /1 раз в день/,
  );
});

test("free plan allows first practice session even after 3 single sessions", async () => {
  const service = createService({
    sessionCounts: { single: 3, pack: 0 },
    plan: createPlan("free"),
  });

  await assert.doesNotReject(() => service.assertCanStartSession(createUser("free"), "pack"));
});

test("free plan blocks exam mode", async () => {
  const service = createService({
    sessionCounts: { "exam-prep": 0 },
    plan: createPlan("free"),
  });

  await assert.rejects(
    () => service.assertCanStartSession(createUser("free"), "exam-prep"),
    /доступен только на тарифах "Базовый" и "Pro"/,
  );
});

test("basic plan allows one exam mode session per day", async () => {
  const service = createService({
    sessionCounts: { "exam-prep": 1 },
    plan: createPlan("basic"),
  });

  await assert.rejects(
    () => service.assertCanStartSession(createUser("basic"), "exam-prep"),
    /тарифе "Базовый" доступен только 1 раз в день/,
  );
});

test("pro plan allows exam mode without restrictions", async () => {
  const service = createService({
    sessionCounts: { "exam-prep": 100 },
    plan: createPlan("pro"),
  });

  await assert.doesNotReject(() => service.assertCanStartSession(createUser("pro"), "exam-prep"));
});

test("interval mode is blocked for free and basic plans", async () => {
  const freeService = createService({
    sessionCounts: { interval: 0 },
    plan: createPlan("free"),
  });
  const basicService = createService({
    sessionCounts: { interval: 0 },
    plan: createPlan("basic"),
  });

  await assert.rejects(
    () => freeService.assertCanStartSession(createUser("free"), "interval"),
    /доступен только на тарифе "Pro"/,
  );
  await assert.rejects(
    () => basicService.assertCanStartSession(createUser("basic"), "interval"),
    /доступен только на тарифе "Pro"/,
  );
});

test("interval mode is available for pro plan", async () => {
  const service = createService({
    sessionCounts: { interval: 999 },
    plan: createPlan("pro"),
  });

  await assert.doesNotReject(() => service.assertCanStartSession(createUser("pro"), "interval"));
});

function createService(input: {
  sessionCounts: Partial<Record<SessionMode, number>>;
  plan: SubscriptionPlan;
}): SubscriptionService {
  return new SubscriptionService(
    {
      listPlans: async () => [input.plan],
      getByCode: async (code: string) => (code === input.plan.code ? input.plan : null),
      upsertPlan: async () => input.plan,
    } as never,
    {} as never,
    {
      countStartedByUser: async (params: { mode?: SessionMode }) => input.sessionCounts[params.mode ?? "single"] ?? 0,
    } as never,
  );
}

function createPlan(code: string): SubscriptionPlan {
  return {
    code,
    name: code,
    description: code,
    price: 0,
    currency: "RUB",
    isActive: true,
    limits: {
      dailySessionsLimit: null,
      maxErrorsInExamPrep: 3,
      examPrepPenaltyQuestions: 3,
    },
    createdAtIso: "2026-01-01T00:00:00.000Z",
    updatedAtIso: "2026-01-01T00:00:00.000Z",
  };
}

function createUser(planCode: string): User {
  return {
    id: "user-1",
    telegramId: "tg-1",
    name: "Test User",
    role: "student",
    planCode,
    planStartAtIso: null,
    planEndAtIso: null,
    dailyUsage: {
      dateIso: "2026-01-01",
      sessionsStarted: 0,
      questionsAnswered: 0,
    },
    createdAtIso: "2026-01-01T00:00:00.000Z",
    updatedAtIso: "2026-01-01T00:00:00.000Z",
  };
}
