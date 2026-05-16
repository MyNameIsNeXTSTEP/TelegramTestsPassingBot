import { randomUUID } from "node:crypto";

import type {
  GetActiveSessionResponse,
  Question,
  Session,
  SessionIntervalConfig,
  SessionMode,
  SessionStatus,
  StartSessionResponse,
  SubmitAnswerResponse,
} from "../../shared/index.js";
import { SESSION_RULES } from "../../shared/index.js";
import type { SessionRepository } from "../repositories/sessionRepository.js";
import type { StatisticsRepository } from "../repositories/statisticsRepository.js";
import type { TestRepository } from "../repositories/testRepository.js";
import type { UserRepository } from "../repositories/userRepository.js";
import type { SubscriptionService } from "./subscriptionService.js";

export class SessionService {
  public constructor(
    private readonly testRepository: TestRepository,
    private readonly sessionRepository: SessionRepository,
    private readonly statisticsRepository: StatisticsRepository,
    private readonly userRepository: UserRepository,
    private readonly subscriptionService: SubscriptionService,
  ) {}

  public async startSession(params: {
    userId: string;
    subjectId: string;
    mode: SessionMode;
    intervalConfig?: SessionIntervalConfig;
  }): Promise<StartSessionResponse> {
    const user = await this.userRepository.findById(params.userId);
    if (!user) {
      throw new Error(`Пользователь '${params.userId}' не найден`);
    }

    await this.subscriptionService.assertCanStartSession(user, params.mode);
    const limits = await this.subscriptionService.resolveLimitsForUser(user);

    const questions = await this.testRepository.getQuestions(params.subjectId);
    if (questions.length === 0) {
      throw new Error(`Вопросы не найдены для предмета '${params.subjectId}'`);
    }

    const intervalConfig =
      params.mode === "interval"
        ? normalizeIntervalConfig(params.intervalConfig)
        : undefined;
    const questionIds = pickQuestionIds(params.mode, questions, intervalConfig);
    if (questionIds.length === 0) {
      throw new Error("Для выбранного интервала не найдено вопросов");
    }

    if (params.mode === "interval") {
      const activeIntervalSession = await this.sessionRepository.findLatestActiveByUser({
        userId: params.userId,
        subjectId: params.subjectId,
        mode: "interval",
      });
      if (activeIntervalSession) {
        activeIntervalSession.status = "abandoned";
        activeIntervalSession.updatedAtIso = new Date().toISOString();
        activeIntervalSession.completedAtIso = activeIntervalSession.updatedAtIso;
        await this.sessionRepository.upsert(activeIntervalSession);
      }
    }
    const now = new Date().toISOString();
    const session: Session = {
      id: randomUUID(),
      userId: params.userId,
      subjectId: params.subjectId,
      mode: params.mode,
      status: "active",
      questionIds,
      progress: {
        totalQuestions: questionIds.length,
        currentQuestionIndex: 0,
        answeredQuestions: 0,
        correctAnswers: 0,
      },
      errors: [],
      currentQuestionSelectedOptionIds: [],
      currentQuestionHadWrongAttempt: false,
      maxAllowedErrors:
        params.mode === "exam-prep" ? limits.maxErrorsInExamPrep : SESSION_RULES.examPrepMaxErrors,
      intervalConfig,
      startedAtIso: now,
      updatedAtIso: now,
    };

    await this.sessionRepository.upsert(session);
    await this.userRepository.incrementDailyUsage(params.userId, { sessionsStarted: 1 }, now);

    const firstQuestionId = session.questionIds[0];
    return {
      session,
      firstQuestion:
        typeof firstQuestionId === "number" ? questionById(questions).get(firstQuestionId) ?? null : null,
    };
  }

  public async getLatestActiveSessionState(params: {
    userId: string;
    subjectId?: string;
    mode?: SessionMode;
  }): Promise<GetActiveSessionResponse> {
    const session = await this.sessionRepository.findLatestActiveByUser({
      userId: params.userId,
      ...(params.subjectId ? { subjectId: params.subjectId } : {}),
      ...(params.mode ? { mode: params.mode } : {}),
    });
    if (!session) {
      return {
        session: null,
        currentQuestion: null,
      };
    }

    const questions = await this.testRepository.getQuestions(session.subjectId);
    const currentQuestionId = session.questionIds[session.progress.currentQuestionIndex];
    return {
      session,
      currentQuestion: typeof currentQuestionId === "number" ? questionById(questions).get(currentQuestionId) ?? null : null,
    };
  }

  public async getSessionState(params: {
    userId: string;
    sessionId: string;
  }): Promise<{ session: Session; currentQuestion: Question | null }> {
    const session = await this.requireOwnedSession(params.userId, params.sessionId);
    if (session.status !== "active") {
      return { session, currentQuestion: null };
    }

    const questions = await this.testRepository.getQuestions(session.subjectId);
    const currentQuestionId = session.questionIds[session.progress.currentQuestionIndex];

    return {
      session,
      currentQuestion: currentQuestionId ? questionById(questions).get(currentQuestionId) ?? null : null,
    };
  }

  public async submitAnswer(params: {
    userId: string;
    sessionId: string;
    questionId: number;
    selectedOptionId: number;
  }): Promise<SubmitAnswerResponse> {
    const session = await this.requireOwnedSession(params.userId, params.sessionId);
    if (session.status !== "active") {
      throw new Error(`Сессия '${session.id}' не активна`);
    }

    const questions = await this.testRepository.getQuestions(session.subjectId);
    const map = questionById(questions);
    const currentQuestionId = session.questionIds[session.progress.currentQuestionIndex];
    if (!currentQuestionId || currentQuestionId !== params.questionId) {
      throw new Error("Ответ должен быть на текущий вопрос");
    }

    const question = map.get(params.questionId);
    if (!question) {
      throw new Error(`Вопрос '${params.questionId}' не найден`);
    }

    const selectedOption = question.options.find((item) => item.optionId === params.selectedOptionId);
    if (!selectedOption) {
      throw new Error(`Вариант '${params.selectedOptionId}' недопустим для вопроса '${question.id}'`);
    }

    const correctOptionIds = question.options.filter((item) => item.isCorrect).map((item) => item.optionId);
    if (correctOptionIds.length === 0) {
      throw new Error(`Вопрос '${question.id}' не имеет правильного варианта`);
    }

    const now = new Date().toISOString();
    const isCorrect = selectedOption.isCorrect;
    const selectedOptionIds = new Set(session.currentQuestionSelectedOptionIds ?? []);
    const isRepeatedSelection = selectedOptionIds.has(params.selectedOptionId);
    if (!isRepeatedSelection) {
      selectedOptionIds.add(params.selectedOptionId);
    }
    session.currentQuestionSelectedOptionIds = [...selectedOptionIds];

    if (!isCorrect && !isRepeatedSelection) {
      session.currentQuestionHadWrongAttempt = true;
      session.errors.push({
        questionId: question.id,
        selectedOptionId: params.selectedOptionId,
        correctOptionId: correctOptionIds[0] as number,
        createdAtIso: now,
      });
    }

    const selectedCorrectCount = session.currentQuestionSelectedOptionIds.filter((optionId) =>
      correctOptionIds.includes(optionId),
    ).length;
    const selectedOptionIdsForQuestion = [...(session.currentQuestionSelectedOptionIds ?? [])];
    const questionCompleted =
      correctOptionIds.length === 1 || selectedCorrectCount >= correctOptionIds.length;

    const isQuestionCorrect =
      questionCompleted &&
      !session.currentQuestionHadWrongAttempt &&
      correctOptionIds.every((optionId) => session.currentQuestionSelectedOptionIds?.includes(optionId));

    if (
      questionCompleted &&
      session.mode === "exam-prep" &&
      !isQuestionCorrect &&
      session.errors.length < session.maxAllowedErrors
    ) {
      const user = await this.userRepository.findById(session.userId);
      if (!user) {
        throw new Error(`Пользователь '${session.userId}' не найден`);
      }
      const limits = await this.subscriptionService.resolveLimitsForUser(user);
      const penalties = pickPenaltyQuestionIds(session.questionIds, questions, limits.examPrepPenaltyQuestions);
      session.questionIds.push(...penalties);
      session.progress.totalQuestions = session.questionIds.length;
    }

    if (questionCompleted) {
      session.progress.answeredQuestions += 1;
      if (isQuestionCorrect) {
        session.progress.correctAnswers += 1;
      }
      session.progress.currentQuestionIndex += 1;
      session.currentQuestionSelectedOptionIds = [];
      session.currentQuestionHadWrongAttempt = false;
    }

    finalizeSessionStatus(session);
    session.updatedAtIso = now;

    await this.sessionRepository.upsert(session);
    if (!isRepeatedSelection) {
      await this.userRepository.incrementDailyUsage(params.userId, { questionsAnswered: 1 }, now);
      await this.statisticsRepository.recordAnswer({
        userId: session.userId,
        sessionId: session.id,
        subjectId: session.subjectId,
        questionId: question.id,
        selectedOptionId: params.selectedOptionId,
        isCorrect,
        answeredAtIso: now,
      });
    }

    if (session.status !== "active") {
      await this.statisticsRepository.recordSession({
        userId: session.userId,
        subjectId: session.subjectId,
        mode: session.mode,
        status: session.status,
        answeredQuestions: session.progress.answeredQuestions,
        correctAnswers: session.progress.correctAnswers,
        createdAtIso: now,
      });
    }

    const nextQuestionId =
      session.status === "active" ? session.questionIds[session.progress.currentQuestionIndex] : undefined;
    return {
      session,
      question,
      isCorrect,
      correctOptionIds,
      selectedOptionIds: selectedOptionIdsForQuestion.filter((optionId) =>
        question.options.some((option) => option.optionId === optionId),
      ),
      questionCompleted,
      currentQuestion: questionCompleted ? null : question,
      nextQuestion: questionCompleted && nextQuestionId ? map.get(nextQuestionId) ?? null : null,
    };
  }

  public async abandonSession(params: { userId: string; sessionId: string }): Promise<Session> {
    const session = await this.requireOwnedSession(params.userId, params.sessionId);
    if (session.status !== "active") {
      return session;
    }

    const now = new Date().toISOString();
    session.status = "abandoned";
    session.updatedAtIso = now;
    session.completedAtIso = now;
    await this.sessionRepository.upsert(session);
    await this.statisticsRepository.recordSession({
      userId: session.userId,
      subjectId: session.subjectId,
      mode: session.mode,
      status: session.status,
      answeredQuestions: session.progress.answeredQuestions,
      correctAnswers: session.progress.correctAnswers,
      createdAtIso: now,
    });

    return session;
  }

  private async requireOwnedSession(userId: string, sessionId: string): Promise<Session> {
    const session = await this.sessionRepository.findById(sessionId);
    if (!session) {
      throw new Error(`Сессия '${sessionId}' не найдена`);
    }
    if (session.userId !== userId) {
      throw new Error("Доступ к сессии запрещен");
    }
    return session;
  }
}

function pickQuestionIds(
  mode: SessionMode,
  questions: Question[],
  intervalConfig?: SessionIntervalConfig,
): number[] {
  const ids = shuffle(questions.map((question) => question.id));
  if (mode === "single") {
    return ids.slice(0, 1);
  }
  if (mode === "pack") {
    return ids.slice(0, Math.min(SESSION_RULES.packQuestions, ids.length));
  }
  if (mode === "interval") {
    if (!intervalConfig) {
      throw new Error("Не переданы параметры интервала");
    }
    const sortedIds = questions.map((question) => question.id).sort((a, b) => a - b);
    return sortedIds.filter(
      (questionId) =>
        questionId >= intervalConfig.startQuestionId &&
        questionId <= intervalConfig.endQuestionId,
    );
  }

  if (ids.length >= SESSION_RULES.examPrepQuestions) {
    return ids.slice(0, SESSION_RULES.examPrepQuestions);
  }

  const extra = shuffle(ids);
  while (ids.length < SESSION_RULES.examPrepQuestions && extra.length > 0) {
    const next = extra[ids.length % extra.length];
    if (typeof next === "number") {
      ids.push(next);
    }
  }
  return ids;
}

function normalizeIntervalConfig(value: SessionIntervalConfig | undefined): SessionIntervalConfig {
  if (!value) {
    throw new Error("Для интервального режима требуется intervalConfig");
  }
  if (value.packSize !== 50 && value.packSize !== 100) {
    throw new Error("packSize для интервального режима должен быть 50 или 100");
  }
  if (!Number.isInteger(value.startQuestionId) || value.startQuestionId <= 0) {
    throw new Error("startQuestionId должен быть положительным целым числом");
  }
  if (!Number.isInteger(value.endQuestionId) || value.endQuestionId <= 0) {
    throw new Error("endQuestionId должен быть положительным целым числом");
  }
  if (value.endQuestionId < value.startQuestionId) {
    throw new Error("endQuestionId не может быть меньше startQuestionId");
  }
  return {
    packSize: value.packSize,
    startQuestionId: value.startQuestionId,
    endQuestionId: value.endQuestionId,
  };
}

function pickPenaltyQuestionIds(
  existingQuestionIds: number[],
  questions: Question[],
  amount: number,
): number[] {
  const allIds = questions.map((question) => question.id);
  const remaining = shuffle(allIds.filter((id) => !existingQuestionIds.includes(id)));
  const penalties: number[] = [];

  while (penalties.length < amount) {
    const source = remaining.length > 0 ? remaining : allIds;
    const next = source[penalties.length % source.length];
    if (typeof next !== "number") {
      break;
    }
    penalties.push(next);
  }

  return penalties;
}

function finalizeSessionStatus(session: Session): void {
  if (session.mode === "exam-prep" && session.errors.length >= session.maxAllowedErrors) {
    session.status = "failed";
    session.completedAtIso = new Date().toISOString();
    return;
  }

  if (session.progress.currentQuestionIndex >= session.progress.totalQuestions) {
    session.status = "passed";
    session.completedAtIso = new Date().toISOString();
    return;
  }

  session.status = "active";
}

function shuffle<T>(items: T[]): T[] {
  const next = [...items];
  for (let index = next.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    const current = next[index];
    next[index] = next[randomIndex] as T;
    next[randomIndex] = current as T;
  }
  return next;
}

function questionById(questions: Question[]): Map<number, Question> {
  return new Map(questions.map((question) => [question.id, question]));
}
