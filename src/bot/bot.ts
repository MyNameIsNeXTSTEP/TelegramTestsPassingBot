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

const MENU_KEYBOARD = Markup.keyboard([["Практика", "Тарифы"], ["Статус"]]).resize();

export function buildBot(config: BotConfig): Telegraf {
  const bot = new Telegraf(config.token);
  const api = new BotApiClient(config.apiBaseUrl);
  const stateByChatId = new Map<number, ChatState>();

  bot.start(async (ctx) => {
    try {
      const state = await upsertUserState(ctx.chat.id, stateByChatId, api, ctx.from?.first_name);
      await ctx.reply(
        [
          `Добро пожаловать, ${state.user.name}!`,
          `Текущий тариф: ${state.user.planCode}`,
          "Выберите действие из меню ниже.",
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

  bot.hears("Практика", async (ctx) => {
    await startPracticeFlow(ctx.chat.id, stateByChatId, api, ctx);
  });

  bot.hears("Тарифы", async (ctx) => {
    await showPlans(ctx.chat.id, stateByChatId, api, ctx);
  });

  bot.hears("Статус", async (ctx) => {
    try {
      const state = await upsertUserState(ctx.chat.id, stateByChatId, api, ctx.from?.first_name);
      await ctx.reply(
        [
          `Пользователь: ${state.user.name}`,
          `Тариф: ${state.user.planCode}`,
          `Сессий за день: ${state.user.dailyUsage.sessionsStarted}`,
          `Ответов за день: ${state.user.dailyUsage.questionsAnswered}`,
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
        await ctx.reply("Перезапустите процесс командой /practice.");
        return;
      }

      const index = Number(ctx.match[1]);
      const faculties = uniqueSorted(state.subjects.map((subject) => subject.faculty));
      const faculty = faculties[index];
      if (!faculty) {
        await ctx.reply("Факультет не найден. Запустите /practice снова.");
        return;
      }

      state.selectedFaculty = faculty;
      state.step = "choose-subject";

      const subjectNames = uniqueSorted(
        state.subjects.filter((subject) => subject.faculty === faculty).map((subject) => subject.subject),
      );
      await ctx.reply(
        `Факультет: ${faculty}\nВыберите предмет:`,
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
        await ctx.reply("Перезапустите процесс командой /practice.");
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
        await ctx.reply("Предмет не найден. Запустите /practice снова.");
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
        `Предмет: ${subjectName}\nВыберите тип теста:`,
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
        await ctx.reply("Перезапустите процесс командой /practice.");
        return;
      }

      state.selectedTestType = ctx.match[1] as TestType;
      state.step = "choose-mode";
      await ctx.reply(
        "Выберите режим:",
        Markup.inlineKeyboard([
          [Markup.button.callback("Одиночный вопрос", "mode:single")],
          [Markup.button.callback("Пакет (10 вопросов)", "mode:pack")],
          [Markup.button.callback("Подготовка к экзамену (30 + штрафы)", "mode:exam-prep")],
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
        await ctx.reply("Перезапустите процесс командой /practice.");
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
        await ctx.reply("Не удалось определить выбранный предмет. Запустите /practice снова.");
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
        await ctx.reply("Сессия начата, но вопросы не были получены.");
        return;
      }

      await ctx.reply(`Сессия начата в режиме: ${mode}`);
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
        await ctx.reply("Нет активной сессии. Начните с /practice.");
        return;
      }

      const selectedOptionId = Number(ctx.match[1]);
      const result = await api.submitAnswer({
        userId: state.user.id,
        sessionId: state.activeSessionId,
        questionId: state.activeQuestionId,
        selectedOptionId,
      });

      await refreshCurrentQuestionKeyboard(ctx, result.question, {
        selectedOptionIds: result.selectedOptionIds,
        questionCompleted: result.questionCompleted,
      });

      if (!result.questionCompleted) {
        const hintText = result.isCorrect
          ? "Верно. Выберите следующий вариант ответа."
          : "Этот вариант неверный. Продолжайте выбирать ответы.";
        await ctx.reply(hintText);
        return;
      }

      const correctOptionsText = result.correctOptionIds.join(", ");
      const answerText = result.isCorrect
        ? "Правильно."
        : `Неправильно. Правильные варианты: ${correctOptionsText}.`;
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
          `Сессия завершена со статусом: ${result.session.status}`,
          `Правильных ответов: ${result.session.progress.correctAnswers}/${result.session.progress.answeredQuestions}`,
          `Ошибок: ${result.session.errors.length}`,
        ].join("\n"),
        MENU_KEYBOARD,
      );
    } catch (error) {
      await ctx.reply(toErrorText(error));
    }
  });

  bot.action(/^done:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("Этот вариант уже зафиксирован.");
  });

  bot.action(/^plan:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const state = requireState(ctx.chat?.id, stateByChatId);
      const planCode = ctx.match[1];
      if (!planCode) {
        await ctx.reply("Код тарифа отсутствует.");
        return;
      }
      state.user = await api.changeMyPlan(state.user.id, planCode);
      await ctx.reply(`Тариф успешно обновлен. Текущий тариф: ${state.user.planCode}`, MENU_KEYBOARD);
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
      await ctx.reply("Нет доступных предметов.");
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
      "Выберите ваш факультет:",
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
      await ctx.reply("Не найдено активных тарифов.");
      return;
    }

    await ctx.reply(
      [
        `Текущий тариф: ${state.user.planCode}`,
        "",
        ...plans.map(
          (plan) =>
            `${plan.name} (${plan.code}) - ${plan.priceCents / 100} ${plan.currency}\n${plan.description}`,
        ),
      ].join("\n"),
      Markup.inlineKeyboard(
        plans.map((plan) => [Markup.button.callback(`Выбрать ${plan.name}`, `plan:${plan.code}`)]),
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
    `Вопрос ${progress.answeredQuestions + 1}/${progress.totalQuestions}`,
    `Ошибок: ${errorsCount}`,
    "",
    question.title,
  ].join("\n");

  await ctx.reply(
    text,
    buildAnswerKeyboard(question),
  );
}

async function refreshCurrentQuestionKeyboard(
  ctx: {
    editMessageReplyMarkup: (...args: any[]) => Promise<unknown>;
  },
  question: Question,
  state: { selectedOptionIds: number[]; questionCompleted: boolean },
): Promise<void> {
  await ctx.editMessageReplyMarkup(
    buildAnswerKeyboard(question, {
      selectedOptionIds: state.selectedOptionIds,
      questionCompleted: state.questionCompleted,
    }).reply_markup,
  );
}

function buildAnswerKeyboard(
  question: Question,
  state?: { selectedOptionIds?: number[]; questionCompleted?: boolean },
) {
  const selectedIds = new Set(state?.selectedOptionIds ?? []);
  const isCompleted = state?.questionCompleted ?? false;

  return Markup.inlineKeyboard(
    question.options.map((option) => {
      const isSelected = selectedIds.has(option.optionId);
      const prefix = isSelected ? (option.isCorrect ? "✅" : "❌") : "";
      const callbackData = isCompleted || isSelected ? `done:${option.optionId}` : `answer:${option.optionId}`;
      return [
        Markup.button.callback(`${prefix} ${option.text}`, callbackData)
      ];
    }),
  );
}

function requireState(chatId: number | undefined, store: Map<number, ChatState>): ChatState {
  if (typeof chatId !== "number") {
    throw new Error("Чат недоступен");
  }

  const state = store.get(chatId);
  if (!state) {
    throw new Error("Состояние сессии отсутствует. Используйте /start.");
  }

  return state;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : "Неожиданная ошибка";
}
