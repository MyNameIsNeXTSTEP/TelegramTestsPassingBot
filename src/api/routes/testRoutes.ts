import type { FastifyPluginAsync } from "fastify";

import type {
  AbandonSessionRequest,
  AbandonSessionResponse,
  DeleteQuestionRequest,
  GetActiveSessionQuery,
  GetActiveSessionResponse,
  GetSessionResponse,
  ListQuestionIdsQuery,
  ListQuestionIdsResponse,
  ListQuestionsQuery,
  ListQuestionsResponse,
  ListSubjectsQuery,
  ListSubjectsResponse,
  StartSessionRequest,
  StartSessionResponse,
  SubmitAnswerRequest,
  SubmitAnswerResponse,
  TestType,
  UpsertQuestionRequest,
} from "../../shared/index.js";
import { isAdminRequest } from "../authz.js";
import { sendError, sendOk } from "../http.js";

export const testRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: ListSubjectsQuery }>("/subjects", async (request, reply) => {
    const testType = sanitizeTestType(request.query.testType);
    if (request.query.testType && !testType) {
      sendError(reply, 400, "VALIDATION_ERROR", "testType must be 'exam' or 'credit'");
      return;
    }
    const course = sanitizeCourse(request.query.course);
    if (request.query.course !== undefined && course === null) {
      sendError(reply, 400, "VALIDATION_ERROR", "course must be an integer from 1 to 9");
      return;
    }

    const subjects = await app.testRepository.listSubjects({
      course: course ?? undefined,
      faculty: request.query.faculty?.trim() || undefined,
      testType: testType ?? undefined,
    });

    const payload: ListSubjectsResponse = { subjects };
    sendOk(reply, payload);
  });

  app.get<{ Querystring: ListQuestionsQuery }>("/questions", async (request, reply) => {
    const { subjectId, limit, offset } = request.query;
    if (!subjectId?.trim()) {
      sendError(reply, 400, "VALIDATION_ERROR", "subjectId is required");
      return;
    }

    try {
      const all = await app.testRepository.getQuestions(subjectId);
      const safeOffset = Number.isFinite(offset) ? Math.max(0, Number(offset)) : 0;
      const safeLimit = Number.isFinite(limit) ? Math.max(1, Number(limit)) : 50;
      const paged = all.slice(safeOffset, safeOffset + safeLimit);

      const payload: ListQuestionsResponse = {
        subjectId,
        total: all.length,
        questions: paged,
      };

      sendOk(reply, payload);
    } catch (error) {
      sendError(reply, 404, "SUBJECT_NOT_FOUND", toErrorMessage(error));
    }
  });

  app.get<{ Querystring: ListQuestionIdsQuery }>("/questions/ids", async (request, reply) => {
    const { subjectId } = request.query;
    if (!subjectId?.trim()) {
      sendError(reply, 400, "VALIDATION_ERROR", "subjectId is required");
      return;
    }

    try {
      const all = await app.testRepository.getQuestions(subjectId.trim());
      const payload: ListQuestionIdsResponse = {
        subjectId: subjectId.trim(),
        total: all.length,
        questionIds: all.map((question) => question.id).sort((a, b) => a - b),
      };
      sendOk(reply, payload);
    } catch (error) {
      sendError(reply, 404, "SUBJECT_NOT_FOUND", toErrorMessage(error));
    }
  });

  app.post<{ Body: StartSessionRequest }>("/sessions/start", async (request, reply) => {
    const userId = readUserIdFromHeader(request.headers["x-user-id"]);
    if (!userId) {
      sendError(reply, 400, "VALIDATION_ERROR", "x-user-id header is required");
      return;
    }

    const { subjectId, mode, intervalConfig } = request.body ?? {};
    if (!subjectId?.trim() || !isMode(mode)) {
      sendError(reply, 400, "VALIDATION_ERROR", "subjectId and valid mode are required");
      return;
    }
    if (mode === "interval" && !isIntervalConfig(intervalConfig)) {
      sendError(
        reply,
        400,
        "VALIDATION_ERROR",
        "intervalConfig with packSize(50|100), startQuestionId and endQuestionId is required",
      );
      return;
    }

    try {
      const result = await app.sessionService.startSession({
        userId,
        subjectId: subjectId.trim(),
        mode,
        ...(mode === "interval" && intervalConfig ? { intervalConfig } : {}),
      });

      const payload: StartSessionResponse = result;
      sendOk(reply, payload);
    } catch (error) {
      sendError(reply, 400, "START_SESSION_FAILED", toErrorMessage(error));
    }
  });

  app.post<{ Body: SubmitAnswerRequest }>("/sessions/answer", async (request, reply) => {
    const userId = readUserIdFromHeader(request.headers["x-user-id"]);
    if (!userId) {
      sendError(reply, 400, "VALIDATION_ERROR", "x-user-id header is required");
      return;
    }

    const { sessionId, questionId, selectedOptionId } = request.body ?? {};
    if (
      !sessionId?.trim() ||
      typeof questionId !== "number" ||
      typeof selectedOptionId !== "number"
    ) {
      sendError(
        reply,
        400,
        "VALIDATION_ERROR",
        "sessionId, questionId and selectedOptionId are required",
      );
      return;
    }

    try {
      const result = await app.sessionService.submitAnswer({
        userId,
        sessionId: sessionId.trim(),
        questionId,
        selectedOptionId,
      });

      const payload: SubmitAnswerResponse = result;
      sendOk(reply, payload);
    } catch (error) {
      sendError(reply, 400, "SUBMIT_ANSWER_FAILED", toErrorMessage(error));
    }
  });

  app.post<{ Body: AbandonSessionRequest }>("/sessions/abandon", async (request, reply) => {
    const userId = readUserIdFromHeader(request.headers["x-user-id"]);
    if (!userId) {
      sendError(reply, 400, "VALIDATION_ERROR", "x-user-id header is required");
      return;
    }

    const { sessionId } = request.body ?? {};
    if (!sessionId?.trim()) {
      sendError(reply, 400, "VALIDATION_ERROR", "sessionId is required");
      return;
    }

    try {
      const session = await app.sessionService.abandonSession({
        userId,
        sessionId: sessionId.trim(),
      });
      const payload: AbandonSessionResponse = { session };
      sendOk(reply, payload);
    } catch (error) {
      sendError(reply, 400, "ABANDON_SESSION_FAILED", toErrorMessage(error));
    }
  });

  app.get<{ Params: { sessionId: string } }>("/sessions/:sessionId", async (request, reply) => {
    const userId = readUserIdFromHeader(request.headers["x-user-id"]);
    if (!userId) {
      sendError(reply, 400, "VALIDATION_ERROR", "x-user-id header is required");
      return;
    }

    const { sessionId } = request.params;
    if (!sessionId?.trim()) {
      sendError(reply, 400, "VALIDATION_ERROR", "sessionId is required");
      return;
    }

    try {
      const result = await app.sessionService.getSessionState({
        userId,
        sessionId: sessionId.trim(),
      });

      const payload: GetSessionResponse = result;
      sendOk(reply, payload);
    } catch (error) {
      sendError(reply, 400, "GET_SESSION_FAILED", toErrorMessage(error));
    }
  });

  app.get<{ Querystring: GetActiveSessionQuery }>("/sessions/active", async (request, reply) => {
    const userId = readUserIdFromHeader(request.headers["x-user-id"]);
    if (!userId) {
      sendError(reply, 400, "VALIDATION_ERROR", "x-user-id header is required");
      return;
    }

    const subjectId = request.query.subjectId?.trim();
    const mode = request.query.mode;
    if (mode !== undefined && !isMode(mode)) {
      sendError(reply, 400, "VALIDATION_ERROR", "mode must be single, pack, exam-prep or interval");
      return;
    }

    try {
      const result = await app.sessionService.getLatestActiveSessionState({
        userId,
        ...(subjectId ? { subjectId } : {}),
        ...(mode ? { mode } : {}),
      });
      const payload: GetActiveSessionResponse = result;
      sendOk(reply, payload);
    } catch (error) {
      sendError(reply, 400, "GET_SESSION_FAILED", toErrorMessage(error));
    }
  });

  app.post<{ Body: UpsertQuestionRequest }>("/admin/questions", async (request, reply) => {
    if (!isAdminRequest(request)) {
      sendError(reply, 403, "FORBIDDEN", "Admin role required");
      return;
    }

    const { subjectId, question } = request.body ?? {};
    if (!subjectId?.trim() || !question) {
      sendError(reply, 400, "VALIDATION_ERROR", "subjectId and question are required");
      return;
    }

    try {
      const saved = await app.testRepository.upsertQuestion(subjectId.trim(), question);
      sendOk(reply, { question: saved });
    } catch (error) {
      sendError(reply, 400, "UPSERT_FAILED", toErrorMessage(error));
    }
  });

  app.delete<{ Body: DeleteQuestionRequest }>(
    "/admin/questions",
    async (request, reply) => {
      if (!isAdminRequest(request)) {
        sendError(reply, 403, "FORBIDDEN", "Admin role required");
        return;
      }

      const { subjectId, questionId } = request.body ?? {};
      if (!subjectId?.trim() || typeof questionId !== "number") {
        sendError(
          reply,
          400,
          "VALIDATION_ERROR",
          "subjectId and numeric questionId are required",
        );
        return;
      }

      try {
        const deleted = await app.testRepository.deleteQuestion(subjectId.trim(), questionId);
        if (!deleted) {
          sendError(reply, 404, "QUESTION_NOT_FOUND", "Question was not found");
          return;
        }

        sendOk(reply, { deleted: true });
      } catch (error) {
        sendError(reply, 404, "SUBJECT_NOT_FOUND", toErrorMessage(error));
      }
    },
  );
};

function sanitizeTestType(value?: string): TestType | null {
  if (value === "exam" || value === "credit") {
    return value;
  }

  return null;
}

function sanitizeCourse(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function isMode(value: string | undefined): value is StartSessionRequest["mode"] {
  return value === "single" || value === "pack" || value === "exam-prep" || value === "interval";
}

function isIntervalConfig(value: unknown): value is NonNullable<StartSessionRequest["intervalConfig"]> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const maybeConfig = value as {
    packSize?: unknown;
    startQuestionId?: unknown;
    endQuestionId?: unknown;
  };
  if (maybeConfig.packSize !== 50 && maybeConfig.packSize !== 100) {
    return false;
  }
  if (
    typeof maybeConfig.startQuestionId !== "number" ||
    !Number.isInteger(maybeConfig.startQuestionId) ||
    maybeConfig.startQuestionId <= 0
  ) {
    return false;
  }
  if (
    typeof maybeConfig.endQuestionId !== "number" ||
    !Number.isInteger(maybeConfig.endQuestionId) ||
    maybeConfig.endQuestionId <= 0
  ) {
    return false;
  }
  return maybeConfig.endQuestionId >= maybeConfig.startQuestionId;
}

function readUserIdFromHeader(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
