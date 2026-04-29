import type { PlanLimits, SubscriptionPlan, User } from "../../shared/index.js";
import { SESSION_RULES } from "../../shared/index.js";
import type { PlanRepository } from "../repositories/planRepository.js";
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
      throw new Error(`Plan '${planCode}' is not available`);
    }

    return this.userRepository.updatePlanCode(userId, planCode);
  }

  public async resolveLimitsForUser(user: User): Promise<PlanLimits> {
    const plan = await this.planRepository.getByCode(user.planCode);
    if (!plan || !plan.isActive) {
      return FALLBACK_LIMITS;
    }

    return plan.limits;
  }

  public async assertCanStartSession(user: User): Promise<void> {
    const limits = await this.resolveLimitsForUser(user);
    const dailyLimit = limits.dailySessionsLimit;
    if (dailyLimit === null) {
      return;
    }

    const today = new Date().toISOString().slice(0, 10);
    const currentUsage =
      user.dailyUsage.dateIso === today
        ? user.dailyUsage.sessionsStarted
        : 0;

    if (currentUsage >= dailyLimit) {
      throw new Error(
        `Daily quota reached (${dailyLimit} sessions). Upgrade to pro-student for unlimited access.`,
      );
    }
  }
}
