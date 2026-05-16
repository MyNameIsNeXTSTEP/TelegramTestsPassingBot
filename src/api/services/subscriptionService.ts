import type { PlanLimits, SessionMode, SubscriptionPlan, User } from "../../shared/index.js";
import { SESSION_RULES } from "../../shared/index.js";
import type { PlanRepository } from "../repositories/planRepository.js";
import type { SessionRepository } from "../repositories/sessionRepository.js";
import type { UserRepository } from "../repositories/userRepository.js";

const FALLBACK_LIMITS: PlanLimits = {
  dailySessionsLimit: 3,
  maxErrorsInExamPrep: SESSION_RULES.examPrepMaxErrors,
  examPrepPenaltyQuestions: SESSION_RULES.examPrepPenaltyQuestions,
};

export class SubscriptionService {
  public constructor(
    private readonly planRepository: PlanRepository,
    private readonly userRepository: UserRepository,
    private readonly sessionRepository: SessionRepository,
  ) {}

  public async listPlans(): Promise<SubscriptionPlan[]> {
    return this.planRepository.listPlans();
  }

  public async upsertPlan(plan: SubscriptionPlan): Promise<SubscriptionPlan> {
    return this.planRepository.upsertPlan(plan);
  }

  public async changeUserPlan(userId: string, planCode: string): Promise<User> {
    const plan = await this.planRepository.getByCode(planCode);
    if (!plan || !plan.isActive) {
      throw new Error(`Тариф '${planCode}' недоступен`);
    }

    const nowIso = new Date().toISOString();
    const planPeriod = resolvePlanPeriod(planCode, nowIso);
    return this.userRepository.updatePlanCode(userId, planCode, planPeriod);
  }

  public async resolveLimitsForUser(user: User): Promise<PlanLimits> {
    const plan = await this.planRepository.getByCode(user.planCode);
    if (!plan || !plan.isActive) {
      return FALLBACK_LIMITS;
    }

    return plan.limits;
  }

  public async assertCanStartSession(user: User, mode: SessionMode): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    const startedInModeToday = await this.sessionRepository.countStartedByUser({
      userId: user.id,
      dateIso: today,
      mode,
    });

    console.info("mode", mode);
    console.info("user.planCode", user.planCode);

    if (mode === "interval" && user.planCode !== "pro") {
      throw new Error('Интервальный режим доступен только на тарифе "Pro".');
    }

    if (user.planCode === "free") {
      if (mode === "single" && startedInModeToday >= 3) {
        throw new Error("Одиночный режим на бесплатном тарифе доступен только 3 раза в день.");
      }
      if (mode === "pack" && startedInModeToday >= 1) {
        throw new Error("Режим Практика на бесплатном тарифе доступен только 1 раз в день.");
      }
      if (mode === "exam-prep") {
        throw new Error('Режим Экзамен доступен только на тарифах "Базовый" и "Pro".');
      }
      if (mode === "interval") {
        throw new Error('Интервальный режим доступен только на тарифе "Pro".');
      }
    }

    if (user.planCode === "basic" && mode === "exam-prep" && startedInModeToday >= 1) {
      throw new Error('Режим Экзамен на тарифе "Базовый" доступен только 1 раз в день.');
    }

    const limits = await this.resolveLimitsForUser(user);
    const dailyLimit = limits.dailySessionsLimit;
    if (dailyLimit === null) {
      return;
    }
    const currentUsage = startedInModeToday;

    if (currentUsage >= dailyLimit) {
      throw new Error(
        `Достигнут дневной лимит (${dailyLimit} сессий).\nПерейдите на тариф "Базовый" или "Pro" для неограниченного доступа.`,
      );
    }
  }
}

function resolvePlanPeriod(
  planCode: string,
  startAtIso: string,
): { startAtIso: string | null; endAtIso: string | null } {
  if (planCode === "basic" || planCode === "pro") {
    return {
      startAtIso,
      endAtIso: addDays(startAtIso, 30),
    };
  }

  return {
    startAtIso: null,
    endAtIso: null,
  };
}

function addDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}
