import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";

import { loadConfig, type ApiConfig } from "./config.js";
import { SessionRepository } from "./repositories/sessionRepository.js";
import { statisticsRoutes } from "./routes/statisticsRoutes.js";
import { authRoutes } from "./routes/authRoutes.js";
import { subscriptionRoutes } from "./routes/subscriptionRoutes.js";
import { testRoutes } from "./routes/testRoutes.js";
import { PlanRepository } from "./repositories/planRepository.js";
import { StatisticsRepository } from "./repositories/statisticsRepository.js";
import { TestRepository } from "./repositories/testRepository.js";
import { UserRepository } from "./repositories/userRepository.js";
import { SessionService } from "./services/sessionService.js";
import { SubscriptionService } from "./services/subscriptionService.js";

export function buildApi(config: ApiConfig = loadConfig()): FastifyInstance {
  const app = Fastify({
    logger: true,
  });

  app.decorate("apiConfig", config);
  const userRepository = new UserRepository(config.dataDir);
  const testRepository = new TestRepository(config.dbDir);
  const statisticsRepository = new StatisticsRepository(config.dataDir);
  const sessionRepository = new SessionRepository(config.dataDir);
  const planRepository = new PlanRepository(config.dataDir);
  const subscriptionService = new SubscriptionService(planRepository, userRepository);
  const sessionService = new SessionService(
    testRepository,
    sessionRepository,
    statisticsRepository,
    userRepository,
    subscriptionService,
  );

  app.decorate("userRepository", userRepository);
  app.decorate("testRepository", testRepository);
  app.decorate("statisticsRepository", statisticsRepository);
  app.decorate("planRepository", planRepository);
  app.decorate("sessionRepository", sessionRepository);
  app.decorate("subscriptionService", subscriptionService);
  app.decorate("sessionService", sessionService);

  void app.register(cors, {
    origin: true,
  });

  app.get("/health", async () => ({ ok: true }));
  app.register(authRoutes, { prefix: "/auth" });
  app.register(testRoutes, { prefix: "/tests" });
  app.register(statisticsRoutes, { prefix: "/statistics" });
  app.register(subscriptionRoutes, { prefix: "/subscriptions" });

  return app;
}
