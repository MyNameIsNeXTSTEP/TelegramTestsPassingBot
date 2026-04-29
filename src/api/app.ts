import Fastify, { type FastifyInstance } from "fastify";

import { loadConfig, type ApiConfig } from "./config.js";
import { statisticsRoutes } from "./routes/statisticsRoutes.js";
import { authRoutes } from "./routes/authRoutes.js";
import { testRoutes } from "./routes/testRoutes.js";
import { StatisticsRepository } from "./repositories/statisticsRepository.js";
import { TestRepository } from "./repositories/testRepository.js";
import { UserRepository } from "./repositories/userRepository.js";

export function buildApi(config: ApiConfig = loadConfig()): FastifyInstance {
  const app = Fastify({
    logger: true,
  });

  app.decorate("apiConfig", config);
  app.decorate("userRepository", new UserRepository(config.dataDir));
  app.decorate("testRepository", new TestRepository(config.dbDir));
  app.decorate("statisticsRepository", new StatisticsRepository(config.dataDir));

  app.get("/health", async () => ({ ok: true }));
  app.register(authRoutes, { prefix: "/auth" });
  app.register(testRoutes, { prefix: "/tests" });
  app.register(statisticsRoutes, { prefix: "/statistics" });

  return app;
}
