import "fastify";

import type { ApiConfig } from "./config.js";
import type { StatisticsRepository } from "./repositories/statisticsRepository.js";
import type { TestRepository } from "./repositories/testRepository.js";
import type { UserRepository } from "./repositories/userRepository.js";

declare module "fastify" {
  interface FastifyInstance {
    apiConfig: ApiConfig;
    userRepository: UserRepository;
    testRepository: TestRepository;
    statisticsRepository: StatisticsRepository;
  }
}
