import { Markup, Telegraf } from "telegraf";

import type { BotConfig } from "./config.js";
import { BotApiClient } from "./apiClient.js";
import type { Question, SessionMode, Subject, TestType, User } from "../shared/index.js";

type ChatStep =
  | "idle"
  | "choose-faculty"
  | "choose-subject"
  | "choose-test-type"
  | "choose-mode"
  | "in-session";

interface ChatState {
  user: User;
  step: ChatStep;
  subjects: Subject[];
  selectedFaculty?: string;
  selectedSubject?: string;
  selectedTestType?: TestType;
  activeSessionId?: string;
  activeQuestionId?: number;
}

const MENU_KEYBOARD = Markup.keyboard([["Practice tests", "Plans"], ["Status"]]).resize();

export function buildBot(config: BotConfig): Telegraf {
  const bot = new Telegraf(config.token);
  const api = new BotApiClient(config.apiBaseUrl);
  const stateByChatId = new Map<number, ChatState>();

  bot.start(async (ctx) => {
    try {
      const state = await upsertUserState(ctx.chat.id, stateByChatId, api, ctx.from?.first_name);
      await ctx.reply(
        [
          `Welcome, ${state.user.name}!`,
          `Current plan: ${state.user.planCode}`,
          "Choose an action from the menu below.",
        ].join("\n"),
        MENU_KEYBOARD,
      );
    } catch (error) {
      await ctx.reply(toErrorText(error));
    }
  });

  bot.command("practice", async (ctx) => {
    await startPracticeFlow(ctx.chat.id, stateByChatId, api, ctx);
  });

  bot.command("plans", async (ctx) => {
    await showPlans(ctx.chat.id, stateByChatId, api, ctx);
  });

  bot.hears("Practice tests", async (ctx) => {
    await startPracticeFlow(ctx.chat.id, stateByChatId, api, ctx);
  });

  bot.hears("Plans", async (ctx) => {
    await showPlans(ctx.chat.id, stateByChatId, api, ctx);
  });

  bot.hears("Status", async (ctx) => {
    try {
      const state = await upsertUserState(ctx.chat.id, stateByChatId, api, ctx.from?.first_name);
      await ctx.reply(
        [
          `User: ${state.user.name}`,
          `Plan: ${state.user.planCode}`,
          `Daily sessions: ${state.user.dailyUsage.sessionsStarted}`,
          `Daily answered questions: ${state.user.dailyUsage.questionsAnswered}`,
        ].join("\n"),
      );
    } catch (error) {
      await ctx.reply(toErrorText(error));
    }
  });

  bot.action(/^faculty:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const state = requireState(ctx.chat?.id, stateByChatId);
      if (state.step !== "choose-faculty") {
        await ctx.reply("Restart flow with /practice.");
        return;
      }

      const index = Number(ctx.match[1]);
      const faculties = uniqueSorted(state.subjects.map((subject) => subject.faculty));
      const faculty = faculties[index];
      if (!faculty) {
        await ctx.reply("Faculty not found. Run /practice again.");
        return;
      }

      state.selectedFaculty = faculty;
      state.step = "choose-subject";

      const subjectNames = uniqueSorted(
        state.subjects.filter((subject) => subject.faculty === faculty).map((subject) => subject.subject),
      );
      await ctx.reply(
        `Faculty: ${faculty}\nChoose a subject:`,
        Markup.inlineKeyboard(
          subjectNames.map((subjectName, subjectIndex) =>
            Markup.button.callback(subjectName, `subject:${subjectIndex}`),
          ),
        ),
      );
    } catch (error) {
      await ctx.reply(toErrorText(error));
    }
  });

  bot.action(/^subject:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const state = requireState(ctx.chat?.id, stateByChatId);
      if (state.step !== "choose-subject" || !state.selectedFaculty) {
        await ctx.reply("Restart flow with /practice.");
        return;
      }

      const index = Number(ctx.match[1]);
      const subjectNames = uniqueSorted(
        state.subjects
          .filter((subject) => subject.faculty === state.selectedFaculty)
          .map((subject) => subject.subject),
      );
      const subjectName = subjectNames[index];
      if (!subjectName) {
        await ctx.reply("Subject not found. Run /practice again.");
        return;
      }

      state.selectedSubject = subjectName;
      state.step = "choose-test-type";

      const testTypes = uniqueSorted(
        state.subjects
          .filter(
            (subject) =>
              subject.faculty === state.selectedFaculty && subject.subject === state.selectedSubject,
          )
          .map((subject) => subject.testType),
      );

      await ctx.reply(
        `Subject: ${subjectName}\nChoose test type:`,
        Markup.inlineKeyboard(
          testTypes.map((testType) => Markup.button.callback(testType, `test-type:${testType}`)),
        ),
      );
    } catch (error) {
      await ctx.reply(toErrorText(error));
    }
  });

  bot.action(/^test-type:(exam|credit)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const state = requireState(ctx.chat?.id, stateByChatId);
      if (state.step !== "choose-test-type") {
        await ctx.reply("Restart flow with /practice.");
        return;
      }

      state.selectedTestType = ctx.match[1] as TestType;
      state.step = "choose-mode";
      await ctx.reply(
        "Choose mode:",
        Markup.inlineKeyboard([
          [Markup.button.callback("Single", "mode:single")],
          [Markup.button.callback("Pack (10 questions)", "mode:pack")],
          [Markup.button.callback("Exam prep (30 + penalties)", "mode:exam-prep")],
        ]),
      );
    } catch (error) {
      await ctx.reply(toErrorText(error));
    }
  });

  bot.action(/^mode:(single|pack|exam-prep)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const state = requireState(ctx.chat?.id, stateByChatId);
      if (
        state.step !== "choose-mode" ||
        !state.selectedFaculty ||
        !state.selectedSubject ||
        !state.selectedTestType
      ) {
        await ctx.reply("Restart flow with /practice.");
        return;
      }

      const mode = ctx.match[1] as SessionMode;
      const selectedSubject = state.subjects.find(
        (subject) =>
          subject.faculty === state.selectedFaculty &&
          subject.subject === state.selectedSubject &&
          subject.testType === state.selectedTestType,
      );

      if (!selectedSubject) {
        await ctx.reply("Could not resolve selected subject. Run /practice again.");
        return;
      }

      const started = await api.startSession({
        userId: state.user.id,
        subjectId: selectedSubject.id,
        mode,
      });

      state.step = "in-session";
      state.activeSessionId = started.session.id;
      state.activeQuestionId = started.firstQuestion?.id;

      if (!started.firstQuestion) {
        await ctx.reply("Session started, but no questions were returned.");
        return;
      }

      await ctx.reply(`Session started in mode: ${mode}`);
      await sendQuestion(ctx, started.firstQuestion, started.session.progress);
    } catch (error) {
      await ctx.reply(toErrorText(error));
    }
  });

  bot.action(/^answer:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const state = requireState(ctx.chat?.id, stateByChatId);
      if (
        state.step !== "in-session" ||
        !state.activeSessionId ||
        typeof state.activeQuestionId !== "number"
      ) {
        await ctx.reply("No active session. Start with /practice.");
        return;
      }

      const selectedOptionId = Number(ctx.match[1]);
      const result = await api.submitAnswer({
        userId: state.user.id,
        sessionId: state.activeSessionId,
        questionId: state.activeQuestionId,
        selectedOptionId,
      });

      const answerText = result.isCorrect
        ? "Correct."
        : `Incorrect. Correct option id: ${result.correctOptionId}.`;
      await ctx.reply(answerText);

      if (result.nextQuestion) {
        state.activeQuestionId = result.nextQuestion.id;
        await sendQuestion(ctx, result.nextQuestion, result.session.progress, result.session.errors.length);
        return;
      }

      state.step = "idle";
      state.activeSessionId = undefined;
      state.activeQuestionId = undefined;
      await ctx.reply(
        [
          `Session finished with status: ${result.session.status}`,
          `Correct answers: ${result.session.progress.correctAnswers}/${result.session.progress.answeredQuestions}`,
          `Errors: ${result.session.errors.length}`,
        ].join("\n"),
        MENU_KEYBOARD,
      );
    } catch (error) {
      await ctx.reply(toErrorText(error));
    }
  });

  bot.action(/^plan:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const state = requireState(ctx.chat?.id, stateByChatId);
      const planCode = ctx.match[1];
      if (!planCode) {
        await ctx.reply("Plan code is missing.");
        return;
      }
      state.user = await api.changeMyPlan(state.user.id, planCode);
      await ctx.reply(`Plan updated successfully. Current plan: ${state.user.planCode}`, MENU_KEYBOARD);
    } catch (error) {
      await ctx.reply(toErrorText(error));
    }
  });

  return bot;
}

async function startPracticeFlow(
  chatId: number,
  stateByChatId: Map<number, ChatState>,
  api: BotApiClient,
  ctx: { reply: (...args: any[]) => Promise<unknown>; from?: { first_name?: string } },
): Promise<void> {
  try {
    const state = await upsertUserState(chatId, stateByChatId, api, ctx.from?.first_name);
    const subjects = await api.listSubjects();
    if (subjects.length === 0) {
      await ctx.reply("No subjects available.");
      return;
    }

    state.subjects = subjects;
    state.step = "choose-faculty";
    state.selectedFaculty = undefined;
    state.selectedSubject = undefined;
    state.selectedTestType = undefined;
    state.activeSessionId = undefined;
    state.activeQuestionId = undefined;

    const faculties = uniqueSorted(subjects.map((subject) => subject.faculty));
    await ctx.reply(
      "Choose your faculty:",
      Markup.inlineKeyboard(
        faculties.map((faculty, index) => [Markup.button.callback(faculty, `faculty:${index}`)]),
      ),
    );
  } catch (error) {
    await ctx.reply(toErrorText(error));
  }
}

async function showPlans(
  chatId: number,
  stateByChatId: Map<number, ChatState>,
  api: BotApiClient,
  ctx: { reply: (...args: any[]) => Promise<unknown>; from?: { first_name?: string } },
): Promise<void> {
  try {
    const state = await upsertUserState(chatId, stateByChatId, api, ctx.from?.first_name);
    const plans = (await api.listPlans()).filter((plan) => plan.isActive);
    if (plans.length === 0) {
      await ctx.reply("No active plans found.");
      return;
    }

    await ctx.reply(
      [
        `Current plan: ${state.user.planCode}`,
        "",
        ...plans.map(
          (plan) =>
            `${plan.name} (${plan.code}) - ${plan.priceCents / 100} ${plan.currency}\n${plan.description}`,
        ),
      ].join("\n"),
      Markup.inlineKeyboard(
        plans.map((plan) => [Markup.button.callback(`Select ${plan.name}`, `plan:${plan.code}`)]),
      ),
    );
  } catch (error) {
    await ctx.reply(toErrorText(error));
  }
}

async function upsertUserState(
  chatId: number,
  stateByChatId: Map<number, ChatState>,
  api: BotApiClient,
  firstName = "Student",
): Promise<ChatState> {
  const telegramId = String(chatId);
  const user = await api.login(telegramId, firstName);
  const existing = stateByChatId.get(chatId);
  if (existing) {
    existing.user = user;
    return existing;
  }

  const initial: ChatState = {
    user,
    step: "idle",
    subjects: [],
  };
  stateByChatId.set(chatId, initial);
  return initial;
}

async function sendQuestion(
  ctx: {
    reply: (...args: any[]) => Promise<unknown>;
  },
  question: Question,
  progress: { answeredQuestions: number; totalQuestions: number },
  errorsCount = 0,
): Promise<void> {
  const text = [
    `Question ${progress.answeredQuestions + 1}/${progress.totalQuestions}`,
    `Errors: ${errorsCount}`,
    "",
    question.title,
  ].join("\n");

  await ctx.reply(
    text,
    Markup.inlineKeyboard(
      question.options.map((option) => [
        Markup.button.callback(`${option.optionId}. ${option.text}`, `answer:${option.optionId}`),
      ]),
    ),
  );
}

function requireState(chatId: number | undefined, store: Map<number, ChatState>): ChatState {
  if (typeof chatId !== "number") {
    throw new Error("Chat is unavailable");
  }

  const state = store.get(chatId);
  if (!state) {
    throw new Error("Session state is missing. Use /start first.");
  }

  return state;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}
