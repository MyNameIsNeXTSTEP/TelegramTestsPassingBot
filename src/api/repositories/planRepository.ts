import { join } from "node:path";

import type { SubscriptionPlan } from "../../shared/index.js";
import { SESSION_RULES } from "../../shared/index.js";
import { readJsonFileValidated, updateJsonFileValidated } from "../storage/jsonStore.js";

interface PlansStore {
  plans: SubscriptionPlan[];
}

const DEFAULT_STORE: PlansStore = {
  plans: [
    createDefaultPlan({
      code: "free",
      name: "Free",
      description: "Limited daily access for practicing tests",
      priceCents: 0,
      currency: "RUB",
      limits: {
        dailySessionsLimit: 3,
        maxErrorsInExamPrep: SESSION_RULES.examPrepMaxErrors,
        examPrepPenaltyQuestions: SESSION_RULES.examPrepPenaltyQuestions,
      },
    }),
    createDefaultPlan({
      code: "pro-student",
      name: "Pro Student",
      description: "Unlimited daily sessions with full access",
      priceCents: 299,
      currency: "RUB",
      limits: {
        dailySessionsLimit: null,
        maxErrorsInExamPrep: SESSION_RULES.examPrepMaxErrors,
        examPrepPenaltyQuestions: SESSION_RULES.examPrepPenaltyQuestions,
      },
    }),
  ],
};

export class PlanRepository {
  private readonly path: string;

  public constructor(dataDir: string) {
    this.path = join(dataDir, "plans.json");
  }

  public async listPlans(): Promise<SubscriptionPlan[]> {
    const store = await this.readStore();
    return store.plans;
  }

  public async getByCode(code: string): Promise<SubscriptionPlan | null> {
    const plans = await this.listPlans();
    return plans.find((plan) => plan.code === code) ?? null;
  }

  public async upsertPlan(plan: SubscriptionPlan): Promise<SubscriptionPlan> {
    const normalized = normalizePlan(plan);
    await updateJsonFileValidated({
      path: this.path,
      fallback: DEFAULT_STORE,
      validate: parsePlansStore,
      update: (store) => {
        const plans = [...store.plans];
        const index = plans.findIndex((item) => item.code === normalized.code);
        if (index >= 0) {
          plans[index] = normalized;
        } else {
          plans.push(normalized);
        }

        return { plans };
      },
    });

    return normalized;
  }

  private async readStore(): Promise<PlansStore> {
    return readJsonFileValidated(this.path, DEFAULT_STORE, parsePlansStore);
  }
}

function createDefaultPlan(input: {
  code: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  limits: SubscriptionPlan["limits"];
}): SubscriptionPlan {
  const now = new Date().toISOString();
  return {
    ...input,
    isActive: true,
    createdAtIso: now,
    updatedAtIso: now,
  };
}

function parsePlansStore(value: unknown): PlansStore {
  if (!isRecord(value)) {
    throw new Error("Plans store must be an object");
  }

  const plans = value.plans;
  if (!Array.isArray(plans)) {
    throw new Error("Plans store must contain plans array");
  }

  return {
    plans: plans.map((item) => normalizePlan(item)),
  };
}

function normalizePlan(value: unknown): SubscriptionPlan {
  if (!isRecord(value)) {
    throw new Error("Plan must be an object");
  }

  const code = asNonEmptyString(value.code, "code");
  const now = new Date().toISOString();
  const limits = normalizeLimits(value.limits);

  return {
    code,
    name: asNonEmptyString(value.name, "name"),
    description: asNonEmptyString(value.description, "description"),
    priceCents: asNonNegativeInt(value.priceCents, "priceCents"),
    currency: asNonEmptyString(value.currency, "currency").toUpperCase(),
    isActive: typeof value.isActive === "boolean" ? value.isActive : true,
    limits,
    createdAtIso: asIso(value.createdAtIso) ?? now,
    updatedAtIso: now,
  };
}

function normalizeLimits(value: unknown): SubscriptionPlan["limits"] {
  if (!isRecord(value)) {
    throw new Error("Plan limits must be an object");
  }

  const rawDailyLimit = value.dailySessionsLimit;
  const dailySessionsLimit =
    rawDailyLimit === null ? null : asNonNegativeInt(rawDailyLimit, "dailySessionsLimit");

  return {
    dailySessionsLimit,
    maxErrorsInExamPrep: asPositiveInt(value.maxErrorsInExamPrep, "maxErrorsInExamPrep"),
    examPrepPenaltyQuestions: asPositiveInt(
      value.examPrepPenaltyQuestions,
      "examPrepPenaltyQuestions",
    ),
  };
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Plan ${field} must be a non-empty string`);
  }

  return value.trim();
}

function asIso(value: unknown): string | null {
  return typeof value === "string" && value.includes("T") ? value : null;
}

function asNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Plan ${field} must be a non-negative integer`);
  }

  return value;
}

function asPositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Plan ${field} must be a positive integer`);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
