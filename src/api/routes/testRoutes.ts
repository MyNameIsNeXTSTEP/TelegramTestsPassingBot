import type { FastifyPluginAsync } from "fastify";

import type {
  DeleteQuestionRequest,
  ListQuestionsQuery,
  ListQuestionsResponse,
  ListSubjectsQuery,
  ListSubjectsResponse,
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

    const subjects = await app.testRepository.listSubjects({
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

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}
