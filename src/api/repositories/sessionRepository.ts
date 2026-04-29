import { join } from "node:path";

import type { Session } from "../../shared/index.js";
import { readJsonFileValidated, updateJsonFileValidated } from "../storage/jsonStore.js";

export class SessionRepository {
  private readonly path: string;

  public constructor(dataDir: string) {
    this.path = join(dataDir, "sessions.json");
  }

  public async findById(sessionId: string): Promise<Session | null> {
    const sessions = await this.readAll();
    return sessions.find((session) => session.id === sessionId) ?? null;
  }

  public async upsert(session: Session): Promise<Session> {
    const normalized = normalizeSession(session);
    await updateJsonFileValidated({
      path: this.path,
      fallback: [],
      validate: parseSessions,
      update: (sessions) => {
        const next = [...sessions];
        const index = next.findIndex((item) => item.id === normalized.id);
        if (index >= 0) {
          next[index] = normalized;
        } else {
          next.push(normalized);
        }

        return next;
      },
    });
    return normalized;
  }

  private async readAll(): Promise<Session[]> {
    return readJsonFileValidated(this.path, [], parseSessions);
  }
}

function parseSessions(value: unknown): Session[] {
  if (!Array.isArray(value)) {
    throw new Error("Sessions file must be an array");
  }

  return value.map((item) => normalizeSession(item));
}

function normalizeSession(value: unknown): Session {
  if (!isRecord(value)) {
    throw new Error("Session must be an object");
  }

  if (typeof value.id !== "string" || !value.id) {
    throw new Error("Session id is required");
  }
  if (typeof value.userId !== "string" || !value.userId) {
    throw new Error("Session userId is required");
  }
  if (typeof value.subjectId !== "string" || !value.subjectId) {
    throw new Error("Session subjectId is required");
  }
  if (value.mode !== "single" && value.mode !== "pack" && value.mode !== "exam-prep") {
    throw new Error("Session mode is invalid");
  }
  if (
    value.status !== "active" &&
    value.status !== "passed" &&
    value.status !== "failed" &&
    value.status !== "abandoned"
  ) {
    throw new Error("Session status is invalid");
  }
  if (!Array.isArray(value.questionIds) || !value.questionIds.every(isPositiveInteger)) {
    throw new Error("Session questionIds must be an array of positive integers");
  }
  if (!isRecord(value.progress)) {
    throw new Error("Session progress is required");
  }

  const progress = value.progress;
  const parsedProgress = {
    totalQuestions: asNonNegativeInteger(progress.totalQuestions, "totalQuestions"),
    currentQuestionIndex: asNonNegativeInteger(progress.currentQuestionIndex, "currentQuestionIndex"),
    answeredQuestions: asNonNegativeInteger(progress.answeredQuestions, "answeredQuestions"),
    correctAnswers: asNonNegativeInteger(progress.correctAnswers, "correctAnswers"),
  };

  const errors = Array.isArray(value.errors) ? value.errors : [];
  const parsedErrors = errors.map((error) => {
    if (!isRecord(error)) {
      throw new Error("Session error entry must be an object");
    }

    return {
      questionId: asPositiveInteger(error.questionId, "questionId"),
      selectedOptionId: asPositiveInteger(error.selectedOptionId, "selectedOptionId"),
      correctOptionId: asPositiveInteger(error.correctOptionId, "correctOptionId"),
      createdAtIso: typeof error.createdAtIso === "string" ? error.createdAtIso : new Date().toISOString(),
    };
  });

  return {
    id: value.id,
    userId: value.userId,
    subjectId: value.subjectId,
    mode: value.mode,
    status: value.status,
    questionIds: value.questionIds,
    progress: parsedProgress,
    errors: parsedErrors,
    currentQuestionSelectedOptionIds: parsePositiveIntegerArray(
      value.currentQuestionSelectedOptionIds,
      "currentQuestionSelectedOptionIds",
    ),
    currentQuestionHadWrongAttempt:
      typeof value.currentQuestionHadWrongAttempt === "boolean"
        ? value.currentQuestionHadWrongAttempt
        : false,
    maxAllowedErrors: asNonNegativeInteger(value.maxAllowedErrors, "maxAllowedErrors"),
    startedAtIso: asNonEmptyString(value.startedAtIso, "startedAtIso"),
    updatedAtIso: asNonEmptyString(value.updatedAtIso, "updatedAtIso"),
    completedAtIso: typeof value.completedAtIso === "string" ? value.completedAtIso : undefined,
  };
}

function parsePositiveIntegerArray(value: unknown, field: string): number[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every(isPositiveInteger)) {
    throw new Error(`Session ${field} must be an array of positive integers`);
  }
  return [...new Set(value)];
}

function asPositiveInteger(value: unknown, field: string): number {
  if (!isPositiveInteger(value)) {
    throw new Error(`Session ${field} must be a positive integer`);
  }

  return value;
}

function asNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Session ${field} must be a non-negative integer`);
  }

  return value;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Session ${field} must be a non-empty string`);
  }

  return value;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
