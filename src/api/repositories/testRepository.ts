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
      throw new Error(`Предмет '${subjectId}' не найден`);
    }

    return readQuestionsFile(record.path);
  }

  public async upsertQuestion(subjectId: string, question: Question): Promise<Question> {
    const validQuestion = validateQuestion(question);
    const record = await this.getSubjectById(subjectId);
    if (!record) {
      throw new Error(`Предмет '${subjectId}' не найден`);
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
      throw new Error(`Предмет '${subjectId}' не найден`);
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
    throw new Error("Файл предмета должен содержать массив вопросов");
  }

  const questions = value.map((item, index) => parseQuestion(item, index));
  const ids = new Set<number>();
  for (const question of questions) {
    if (ids.has(question.id)) {
      throw new Error(`Дублирующийся ID вопроса '${question.id}' в файле предмета`);
    }
    ids.add(question.id);
  }

  return questions;
}

function parseQuestion(value: unknown, index?: number): Question {
  if (!isRecord(value)) {
    throw new Error(withQuestionPrefix(index, "Вопрос должен быть объектом"));
  }

  const id = value.id;
  if (!isPositiveInt(id)) {
    throw new Error(withQuestionPrefix(index, "ID вопроса должен быть положительным целым числом"));
  }

  const title = value.title;
  if (typeof title !== "string" || !title.trim()) {
    throw new Error(withQuestionPrefix(index, "Заголовок вопроса не должен быть пустым"));
  }

  const options = value.options;
  if (!Array.isArray(options) || options.length < 2) {
    throw new Error(withQuestionPrefix(index, "Вопрос должен иметь минимум два варианта ответа"));
  }

  const parsedOptions = options.map((option, optionIndex) =>
    parseQuestionOption(option, id, optionIndex),
  );
  const correctCount = parsedOptions.filter((option) => option.isCorrect).length;
  if (correctCount < 1) {
    console.log("parsedOptions", parsedOptions);
    throw new Error(withQuestionPrefix(index, "Вопрос должен иметь хотя бы один правильный ответ"));
  }

  const optionIds = new Set<number>();
  for (const option of parsedOptions) {
    if (optionIds.has(option.optionId)) {
      throw new Error(withQuestionPrefix(index, `Дублирующийся ID варианта '${option.optionId}'`));
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
    throw new Error(`Вопрос ${questionId} вариант №${optionIndex + 1} должен быть объектом`);
  }

  if (!isPositiveInt(value.optionId)) {
    throw new Error(
      `Вопрос ${questionId} вариант №${optionIndex + 1} optionId должен быть положительным целым числом`,
    );
  }

  if (typeof value.text !== "string" || !value.text.trim()) {
    throw new Error(`Вопрос ${questionId} вариант №${optionIndex + 1} текст не должен быть пустым`);
  }

  if (typeof value.isCorrect !== "boolean") {
    throw new Error(`Вопрос ${questionId} вариант №${optionIndex + 1} isCorrect должен быть булевым значением`);
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

  return `Вопрос №${index + 1}: ${message}`;
}
