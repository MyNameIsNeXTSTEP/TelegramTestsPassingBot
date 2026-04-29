import { randomUUID } from "node:crypto";

import type {
  Question,
  Session,
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
  }): Promise<StartSessionResponse> {
    const user = await this.userRepository.findById(params.userId);
    if (!user) {
      throw new Error(`Пользователь '${params.userId}' не найден`);
    }

    await this.subscriptionService.assertCanStartSession(user);
    const limits = await this.subscriptionService.resolveLimitsForUser(user);

    const questions = await this.testRepository.getQuestions(params.subjectId);
    if (questions.length === 0) {
      throw new Error(`Вопросы не найдены для предмета '${params.subjectId}'`);
    }

    const questionIds = pickQuestionIds(params.mode, questions);
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
      maxAllowedErrors:
        params.mode === "exam-prep" ? limits.maxErrorsInExamPrep : SESSION_RULES.examPrepMaxErrors,
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

  public async getSessionState(params: {
    userId: string;
    sessionId: string;
  }): Promise<{ session: Session; currentQuestion: Question | null }> {
    const session = await this.requireOwnedSession(params.userId, params.sessionId);
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

    const correctOption = question.options.find((item) => item.isCorrect);
    if (!correctOption) {
      throw new Error(`Вопрос '${question.id}' не имеет правильного варианта`);
    }

    const now = new Date().toISOString();
    const isCorrect = selectedOption.isCorrect;
    session.progress.answeredQuestions += 1;
    if (isCorrect) {
      session.progress.correctAnswers += 1;
    } else {
      session.errors.push({
        questionId: question.id,
        selectedOptionId: params.selectedOptionId,
        correctOptionId: correctOption.optionId,
        createdAtIso: now,
      });
    }

    if (session.mode === "exam-prep" && !isCorrect && session.errors.length < session.maxAllowedErrors) {
      const user = await this.userRepository.findById(session.userId);
      if (!user) {
        throw new Error(`Пользователь '${session.userId}' не найден`);
      }
      const limits = await this.subscriptionService.resolveLimitsForUser(user);
      const penalties = pickPenaltyQuestionIds(session.questionIds, questions, limits.examPrepPenaltyQuestions);
      session.questionIds.push(...penalties);
      session.progress.totalQuestions = session.questionIds.length;
    }

    session.progress.currentQuestionIndex += 1;
    finalizeSessionStatus(session);
    session.updatedAtIso = now;

    await this.sessionRepository.upsert(session);
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

    const nextQuestionId = session.questionIds[session.progress.currentQuestionIndex];
    return {
      session,
      isCorrect,
      correctOptionId: correctOption.optionId,
      nextQuestion: nextQuestionId ? map.get(nextQuestionId) ?? null : null,
    };
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

function pickQuestionIds(mode: SessionMode, questions: Question[]): number[] {
  const ids = shuffle(questions.map((question) => question.id));
  if (mode === "single") {
    return ids.slice(0, 1);
  }
  if (mode === "pack") {
    return ids.slice(0, Math.min(SESSION_RULES.packQuestions, ids.length));
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
