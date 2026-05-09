import assert from "node:assert/strict";
import test from "node:test";

import { SessionService } from "../src/api/services/sessionService.js";
import type { Question, Session, User } from "../src/shared/index.js";

test("exam-prep failure does not return a next question", async () => {
  const user: User = {
    id: "user-1",
    telegramId: "telegram-1",
    name: "Test User",
    role: "student",
    planCode: "free",
    planStartAtIso: null,
    planEndAtIso: null,
    dailyUsage: {
      dateIso: "2026-05-08",
      sessionsStarted: 0,
      questionsAnswered: 0,
    },
    createdAtIso: "2026-05-08T00:00:00.000Z",
    updatedAtIso: "2026-05-08T00:00:00.000Z",
  };
  const questions = buildQuestions(35);
  let storedSession: Session | null = null;

  const service = new SessionService(
    {
      getQuestions: async (subjectId: string) => {
        assert.equal(subjectId, "subject-1");
        return questions;
      },
    } as never,
    {
      findById: async (sessionId: string) =>
        storedSession?.id === sessionId ? clone(storedSession) : null,
      upsert: async (session: Session) => {
        storedSession = clone(session);
        return clone(session);
      },
    } as never,
    {
      recordAnswer: async (input: {
        userId: string;
        sessionId: string;
        subjectId: string;
        questionId: number;
        selectedOptionId: number;
        isCorrect: boolean;
        answeredAtIso?: string;
      }) => ({ id: "answer-1", ...input, answeredAtIso: input.answeredAtIso ?? "" }),
      recordSession: async (input: {
        userId: string;
        subjectId: string;
        mode: "single" | "pack" | "exam-prep" | "interval";
        status: "active" | "passed" | "failed" | "abandoned";
        answeredQuestions: number;
        correctAnswers: number;
        createdAtIso?: string;
      }) => ({ id: "summary-1", ...input, createdAtIso: input.createdAtIso ?? "" }),
    } as never,
    {
      findById: async (userId: string) => (userId === user.id ? user : null),
      incrementDailyUsage: async () => user,
    } as never,
    {
      assertCanStartSession: async () => undefined,
      resolveLimitsForUser: async () => ({
        dailySessionsLimit: null,
        maxErrorsInExamPrep: 1,
        examPrepPenaltyQuestions: 3,
      }),
    } as never,
  );

  const started = await service.startSession({
    userId: user.id,
    subjectId: "subject-1",
    mode: "exam-prep",
  });
  assert.ok(started.firstQuestion);

  const result = await service.submitAnswer({
    userId: user.id,
    sessionId: started.session.id,
    questionId: started.firstQuestion.id,
    selectedOptionId: 1,
  });

  assert.equal(result.questionCompleted, true);
  assert.equal(result.session.status, "failed");
  assert.equal(result.currentQuestion, null);
  assert.equal(result.nextQuestion, null);

  const state = await service.getSessionState({
    userId: user.id,
    sessionId: started.session.id,
  });
  assert.equal(state.currentQuestion, null);
});

function buildQuestions(count: number): Question[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    title: `Question ${index + 1}`,
    options: [
      { optionId: 1, text: "Wrong", isCorrect: false },
      { optionId: 2, text: "Correct", isCorrect: true },
    ],
  }));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
