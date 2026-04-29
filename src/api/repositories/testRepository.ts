import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { Question, Subject, TestType } from "../../shared/index.js";
import { readJsonFile, writeJsonFile } from "../storage/jsonStore.js";

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

    return readJsonFile<Question[]>(record.path, []);
  }

  public async upsertQuestion(subjectId: string, question: Question): Promise<Question> {
    validateQuestion(question);
    const record = await this.getSubjectById(subjectId);
    if (!record) {
      throw new Error(`Subject '${subjectId}' not found`);
    }

    const questions = await readJsonFile<Question[]>(record.path, []);
    const index = questions.findIndex((item) => item.id === question.id);

    if (index >= 0) {
      questions[index] = question;
    } else {
      questions.push(question);
    }

    await writeJsonFile(record.path, questions);
    return question;
  }

  public async deleteQuestion(subjectId: string, questionId: number): Promise<boolean> {
    const record = await this.getSubjectById(subjectId);
    if (!record) {
      throw new Error(`Subject '${subjectId}' not found`);
    }

    const questions = await readJsonFile<Question[]>(record.path, []);
    const initialLength = questions.length;
    const next = questions.filter((item) => item.id !== questionId);

    if (next.length === initialLength) {
      return false;
    }

    await writeJsonFile(record.path, next);
    return true;
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

function validateQuestion(question: Question): void {
  if (!question.title.trim()) {
    throw new Error("Question title must not be empty");
  }

  if (!Array.isArray(question.options) || question.options.length < 2) {
    throw new Error("Question must have at least two options");
  }

  const correctCount = question.options.filter((option) => option.isCorrect).length;
  if (correctCount !== 1) {
    throw new Error("Question must have exactly one correct option");
  }
}
