import type { FastifyPluginAsync } from "fastify";

import type {
  GetDailyStatisticsQuery,
  GetModeStatisticsQuery,
  GetWeakAreasQuery,
  SessionMode,
  SessionStatus,
} from "../../shared/index.js";
import { sendError, sendOk } from "../http.js";

interface RecordSessionBody {
  userId: string;
  subjectId: string;
  mode: SessionMode;
  status: SessionStatus;
  answeredQuestions: number;
  correctAnswers: number;
  createdAtIso?: string;
}

interface RecordAnswerBody {
  userId: string;
  sessionId: string;
  subjectId: string;
  questionId: number;
  selectedOptionId: number;
  isCorrect: boolean;
  answeredAtIso?: string;
}

export const statisticsRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: RecordSessionBody }>("/sessions", async (request, reply) => {
    const body = request.body;
    if (
      !body?.userId?.trim() ||
      !body.subjectId?.trim() ||
      !isMode(body.mode) ||
      !isStatus(body.status)
    ) {
      sendError(reply, 400, "VALIDATION_ERROR", "Invalid session payload");
      return;
    }

    const session = await app.statisticsRepository.recordSession({
      userId: body.userId.trim(),
      subjectId: body.subjectId.trim(),
      mode: body.mode,
      status: body.status,
      answeredQuestions: Math.max(0, body.answeredQuestions ?? 0),
      correctAnswers: Math.max(0, body.correctAnswers ?? 0),
      createdAtIso: body.createdAtIso,
    });

    sendOk(reply, { session });
  });

  app.post<{ Body: RecordAnswerBody }>("/answers", async (request, reply) => {
    const body = request.body;
    if (
      !body?.userId?.trim() ||
      !body.sessionId?.trim() ||
      !body.subjectId?.trim() ||
      typeof body.questionId !== "number" ||
      typeof body.selectedOptionId !== "number" ||
      typeof body.isCorrect !== "boolean"
    ) {
      sendError(reply, 400, "VALIDATION_ERROR", "Invalid answer payload");
      return;
    }

    const answer = await app.statisticsRepository.recordAnswer({
      userId: body.userId.trim(),
      sessionId: body.sessionId.trim(),
      subjectId: body.subjectId.trim(),
      questionId: body.questionId,
      selectedOptionId: body.selectedOptionId,
      isCorrect: body.isCorrect,
      answeredAtIso: body.answeredAtIso,
    });

    sendOk(reply, { answer });
  });

  app.get<{ Querystring: GetDailyStatisticsQuery }>("/daily", async (request, reply) => {
    const { userId, dateIso } = request.query;
    if (!userId?.trim()) {
      sendError(reply, 400, "VALIDATION_ERROR", "userId is required");
      return;
    }

    const stats = await app.statisticsRepository.getDailyStatistics(userId.trim(), dateIso);
    sendOk(reply, { stats });
  });

  app.get<{ Querystring: GetWeakAreasQuery }>("/weak-areas", async (request, reply) => {
    const { userId, fromDateIso, toDateIso } = request.query;
    if (!userId?.trim()) {
      sendError(reply, 400, "VALIDATION_ERROR", "userId is required");
      return;
    }

    const subjects = await app.testRepository.listSubjects();
    const subjectMap = new Map(subjects.map((subject) => [subject.id, subject.subject]));

    const weakAreas = await app.statisticsRepository.getWeakAreas(
      userId.trim(),
      { fromDateIso, toDateIso },
      subjectMap,
    );
    sendOk(reply, { weakAreas });
  });

  app.get<{ Querystring: GetModeStatisticsQuery }>("/modes", async (request, reply) => {
    const { userId, fromDateIso, toDateIso } = request.query;
    if (!userId?.trim()) {
      sendError(reply, 400, "VALIDATION_ERROR", "userId is required");
      return;
    }

    const modes = await app.statisticsRepository.getModeStatistics(userId.trim(), {
      fromDateIso,
      toDateIso,
    });
    sendOk(reply, { modes });
  });
};

function isMode(value: string): value is SessionMode {
  return value === "single" || value === "pack" || value === "exam-prep";
}

function isStatus(value: string): value is SessionStatus {
  return value === "active" || value === "passed" || value === "failed" || value === "abandoned";
}
