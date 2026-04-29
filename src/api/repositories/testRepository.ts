import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Question, Subject, TestType } from "../../shared/index.js";
import {
  readJsonFileValidated,
  updateJsonFileValidated,
} from "../storage/jsonStore.js";

interface SubjectRecord {
  subject: Subject;
  path: string;
}

export class TestRepository {
  public constructor(private readonly dbDir: string) {}

  public async listSubjects(filters?: {
    faculty?: string;
    testType?: TestType;
  }): Promise<Subject[]> {
    const records = await this.getSubjectRecords();
    return records
      .map((record) => record.subject)
      .filter((subject) => {
        if (filters?.faculty && subject.faculty !== filters.faculty) {
          return false;
        }

        if (filters?.testType && subject.testType !== filters.testType) {
          return false;
        }

        return true;
      });
  }

  public async getQuestions(subjectId: string): Promise<Question[]> {
    const record = await this.getSubjectById(subjectId);
    if (!record) {
      throw new Error(`Subject '${subjectId}' not found`);
    }

    return readQuestionsFile(record.path);
  }

  public async upsertQuestion(subjectId: string, question: Question): Promise<Question> {
    const validQuestion = validateQuestion(question);
    const record = await this.getSubjectById(subjectId);
    if (!record) {
      throw new Error(`Subject '${subjectId}' not found`);
    }

    await updateJsonFileValidated({
      path: record.path,
      fallback: [],
      validate: parseQuestionsArray,
      update: (questions) => {
        const next = [...questions];
        const index = next.findIndex((item) => item.id === validQuestion.id);

        if (index >= 0) {
          next[index] = validQuestion;
        } else {
          next.push(validQuestion);
        }

        return next;
      },
    });
    return validQuestion;
  }

  public async deleteQuestion(subjectId: string, questionId: number): Promise<boolean> {
    const record = await this.getSubjectById(subjectId);
    if (!record) {
      throw new Error(`Subject '${subjectId}' not found`);
    }

    let deleted = false;
    await updateJsonFileValidated({
      path: record.path,
      fallback: [],
      validate: parseQuestionsArray,
      update: (questions) => {
        const next = questions.filter((item) => item.id !== questionId);
        deleted = next.length !== questions.length;
        return next;
      },
    });

    return deleted;
  }

  private async getSubjectById(subjectId: string): Promise<SubjectRecord | null> {
    const records = await this.getSubjectRecords();
    return records.find((record) => record.subject.id === subjectId) ?? null;
  }

  private async getSubjectRecords(): Promise<SubjectRecord[]> {
    const entries = await readdir(this.dbDir, { withFileTypes: true });
    const files = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith("_tests.json"),
    );

    return files
      .map((entry) => {
        const fileName = entry.name;
        const stem = fileName.replace("_tests.json", "");
        const subjectLabel = stem.replaceAll("_", " ").trim();

        const subject: Subject = {
          id: stem,
          faculty: "general",
          subject: subjectLabel,
          testType: inferTestType(stem),
          sourceFile: fileName,
        };

        return { subject, path: join(this.dbDir, fileName) };
      })
      .sort((a, b) => a.subject.subject.localeCompare(b.subject.subject));
  }
}

function inferTestType(stem: string): TestType {
  return stem.includes("credit") ? "credit" : "exam";
}

function validateQuestion(question: Question): Question {
  return parseQuestion(question);
}

function readQuestionsFile(path: string): Promise<Question[]> {
  return readJsonFileValidated(path, [], parseQuestionsArray);
}

function parseQuestionsArray(value: unknown): Question[] {
  if (!Array.isArray(value)) {
    throw new Error("Subject file must contain an array of questions");
  }

  const questions = value.map((item, index) => parseQuestion(item, index));
  const ids = new Set<number>();
  for (const question of questions) {
    if (ids.has(question.id)) {
      throw new Error(`Duplicate question id '${question.id}' in subject file`);
    }
    ids.add(question.id);
  }

  return questions;
}

function parseQuestion(value: unknown, index?: number): Question {
  if (!isRecord(value)) {
    throw new Error(withQuestionPrefix(index, "Question must be an object"));
  }

  const id = value.id;
  if (!isPositiveInt(id)) {
    throw new Error(withQuestionPrefix(index, "Question id must be a positive integer"));
  }

  const title = value.title;
  if (typeof title !== "string" || !title.trim()) {
    throw new Error(withQuestionPrefix(index, "Question title must not be empty"));
  }

  const options = value.options;
  if (!Array.isArray(options) || options.length < 2) {
    throw new Error(withQuestionPrefix(index, "Question must have at least two options"));
  }

  const parsedOptions = options.map((option, optionIndex) =>
    parseQuestionOption(option, id, optionIndex),
  );
  const correctCount = parsedOptions.filter((option) => option.isCorrect).length;
  if (correctCount !== 1) {
    throw new Error(withQuestionPrefix(index, "Question must have exactly one correct option"));
  }

  const optionIds = new Set<number>();
  for (const option of parsedOptions) {
    if (optionIds.has(option.optionId)) {
      throw new Error(withQuestionPrefix(index, `Duplicate option id '${option.optionId}'`));
    }
    optionIds.add(option.optionId);
  }

  return {
    id,
    title: title.trim(),
    options: parsedOptions,
  };
}

function parseQuestionOption(value: unknown, questionId: number, optionIndex: number) {
  if (!isRecord(value)) {
    throw new Error(`Question ${questionId} option #${optionIndex + 1} must be an object`);
  }

  if (!isPositiveInt(value.optionId)) {
    throw new Error(
      `Question ${questionId} option #${optionIndex + 1} optionId must be a positive integer`,
    );
  }

  if (typeof value.text !== "string" || !value.text.trim()) {
    throw new Error(`Question ${questionId} option #${optionIndex + 1} text must not be empty`);
  }

  if (typeof value.isCorrect !== "boolean") {
    throw new Error(`Question ${questionId} option #${optionIndex + 1} isCorrect must be boolean`);
  }

  return {
    optionId: value.optionId,
    text: value.text.trim(),
    isCorrect: value.isCorrect,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function withQuestionPrefix(index: number | undefined, message: string): string {
  if (index === undefined) {
    return message;
  }

  return `Question #${index + 1}: ${message}`;
}
