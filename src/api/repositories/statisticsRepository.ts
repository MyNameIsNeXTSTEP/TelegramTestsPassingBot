import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  AnswerEvent,
  ModeStatistics,
  SessionMode,
  SessionStatus,
  SubjectWeakArea,
  UserDailyStatistics,
} from "../../shared/index.js";
import { readJsonFile, writeJsonFile } from "../storage/jsonStore.js";

interface SessionSummary {
  id: string;
  userId: string;
  subjectId: string;
  mode: SessionMode;
  status: SessionStatus;
  answeredQuestions: number;
  correctAnswers: number;
  createdAtIso: string;
}

interface StatsStore {
  sessions: SessionSummary[];
  answerEvents: AnswerEvent[];
}

interface DateRange {
  fromDateIso?: string;
  toDateIso?: string;
}

const EMPTY_STORE: StatsStore = { sessions: [], answerEvents: [] };

export class StatisticsRepository {
  private readonly path: string;

  public constructor(dataDir: string) {
    this.path = join(dataDir, "statistics.json");
  }

  public async recordSession(input: {
    userId: string;
    subjectId: string;
    mode: SessionMode;
    status: SessionStatus;
    answeredQuestions: number;
    correctAnswers: number;
    createdAtIso?: string;
  }): Promise<SessionSummary> {
    const store = await this.read();
    const session: SessionSummary = {
      id: randomUUID(),
      userId: input.userId,
      subjectId: input.subjectId,
      mode: input.mode,
      status: input.status,
      answeredQuestions: input.answeredQuestions,
      correctAnswers: input.correctAnswers,
      createdAtIso: input.createdAtIso ?? new Date().toISOString(),
    };

    store.sessions.push(session);
    await this.write(store);
    return session;
  }

  public async recordAnswer(input: {
    userId: string;
    sessionId: string;
    subjectId: string;
    questionId: number;
    selectedOptionId: number;
    isCorrect: boolean;
    answeredAtIso?: string;
  }): Promise<AnswerEvent> {
    const store = await this.read();
    const event: AnswerEvent = {
      id: randomUUID(),
      userId: input.userId,
      sessionId: input.sessionId,
      subjectId: input.subjectId,
      questionId: input.questionId,
      selectedOptionId: input.selectedOptionId,
      isCorrect: input.isCorrect,
      answeredAtIso: input.answeredAtIso ?? new Date().toISOString(),
    };

    store.answerEvents.push(event);
    await this.write(store);
    return event;
  }

  public async getDailyStatistics(
    userId: string,
    dateIso = new Date().toISOString().slice(0, 10),
  ): Promise<UserDailyStatistics> {
    const store = await this.read();
    const sessions = store.sessions.filter(
      (session) => session.userId === userId && session.createdAtIso.startsWith(dateIso),
    );
    const events = store.answerEvents.filter(
      (event) => event.userId === userId && event.answeredAtIso.startsWith(dateIso),
    );

    const answeredQuestions = events.length;
    const correctAnswers = events.filter((event) => event.isCorrect).length;

    return {
      userId,
      dateIso,
      attempts: sessions.length,
      answeredQuestions,
      correctAnswers,
      accuracyRate: toRate(correctAnswers, answeredQuestions),
    };
  }

  public async getWeakAreas(
    userId: string,
    range: DateRange,
    subjectsById: Map<string, string>,
  ): Promise<SubjectWeakArea[]> {
    const store = await this.read();
    const filtered = store.answerEvents.filter(
      (event) => event.userId === userId && dateInRange(event.answeredAtIso, range),
    );

    const grouped = new Map<
      string,
      { answeredQuestions: number; incorrectAnswers: number }
    >();
    for (const event of filtered) {
      const current = grouped.get(event.subjectId) ?? {
        answeredQuestions: 0,
        incorrectAnswers: 0,
      };
      current.answeredQuestions += 1;
      if (!event.isCorrect) {
        current.incorrectAnswers += 1;
      }
      grouped.set(event.subjectId, current);
    }

    return Array.from(grouped.entries())
      .map(([subjectId, metric]) => ({
        subjectId,
        subjectName: subjectsById.get(subjectId) ?? subjectId,
        answeredQuestions: metric.answeredQuestions,
        incorrectAnswers: metric.incorrectAnswers,
        errorRate: toRate(metric.incorrectAnswers, metric.answeredQuestions),
      }))
      .sort((a, b) => b.errorRate - a.errorRate);
  }

  public async getModeStatistics(userId: string, range: DateRange): Promise<ModeStatistics[]> {
    const store = await this.read();
    const sessions = store.sessions.filter(
      (session) => session.userId === userId && dateInRange(session.createdAtIso, range),
    );

    const grouped = new Map<
      SessionMode,
      { sessions: number; passed: number; failed: number; totalAccuracy: number }
    >();

    for (const session of sessions) {
      const current = grouped.get(session.mode) ?? {
        sessions: 0,
        passed: 0,
        failed: 0,
        totalAccuracy: 0,
      };

      current.sessions += 1;
      if (session.status === "passed") {
        current.passed += 1;
      }
      if (session.status === "failed") {
        current.failed += 1;
      }
      current.totalAccuracy += toRate(session.correctAnswers, session.answeredQuestions);

      grouped.set(session.mode, current);
    }

    return Array.from(grouped.entries()).map(([mode, metric]) => ({
      mode,
      sessions: metric.sessions,
      passed: metric.passed,
      failed: metric.failed,
      averageAccuracyRate: toRate(metric.totalAccuracy, metric.sessions),
    }));
  }

  private async read(): Promise<StatsStore> {
    return readJsonFile<StatsStore>(this.path, EMPTY_STORE);
  }

  private async write(store: StatsStore): Promise<void> {
    await writeJsonFile(this.path, store);
  }
}

function toRate(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  return Number((value / total).toFixed(4));
}

function dateInRange(iso: string, range: DateRange): boolean {
  const date = iso.slice(0, 10);
  if (range.fromDateIso && date < range.fromDateIso) {
    return false;
  }

  if (range.toDateIso && date > range.toDateIso) {
    return false;
  }

  return true;
}
