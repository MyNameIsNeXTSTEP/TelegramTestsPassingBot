import "fastify";

import type { ApiConfig } from "./config.js";
import type { PlanRepository } from "./repositories/planRepository.js";
import type { SessionRepository } from "./repositories/sessionRepository.js";
import type { StatisticsRepository } from "./repositories/statisticsRepository.js";
import type { TestRepository } from "./repositories/testRepository.js";
import type { UserRepository } from "./repositories/userRepository.js";
import type { SessionService } from "./services/sessionService.js";
import type { SubscriptionService } from "./services/subscriptionService.js";

declare module "fastify" {
  interface FastifyInstance {
    apiConfig: ApiConfig;
    userRepository: UserRepository;
    testRepository: TestRepository;
    statisticsRepository: StatisticsRepository;
    planRepository: PlanRepository;
    sessionRepository: SessionRepository;
    subscriptionService: SubscriptionService;
    sessionService: SessionService;
  }
}
