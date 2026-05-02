import { Markup, Telegraf } from "telegraf";

import type { BotConfig } from "./config.js";
import { BotApiClient } from "./apiClient.js";
import type { Question, SessionMode, Subject, TestType, User } from "../shared/index.js";

type ChatStep =
  | "idle"
  | "choose-course"
  | "choose-faculty"
  | "choose-subject"
  | "choose-test-type"
  | "choose-mode"
  | "in-session"
  | "single-finished";

interface ChatState {
  user: User;
  step: ChatStep;
  subjects: Subject[];
  selectedCourse?: number;
  selectedFaculty?: string;
  selectedSubject?: string;
  selectedTestType?: TestType;
  activeSessionId?: string;
  activeQuestionId?: number;
}

const MENU_KEYBOARD = Markup.keyboard([["Практика", "Тарифы"], ["Статус"]]).resize();

const mapCurrentPlanToEmoji = {
  "free": "Бесплатный 🤓",
  "basic": "Базовый 🧑‍🎓",
  "pro": "Pro 🏆",
};

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
          // @ts-ignore
          `Текущий тариф: ${mapCurrentPlanToEmoji[state.user.planCode]}`,
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
      if (!state.selectedCourse) {
        await ctx.reply("Сначала выберите курс. Запустите /practice снова.");
        return;
      }
      const faculties = uniqueSorted(
        state.subjects
          .filter((subject) => subject.course === state.selectedCourse)
          .map((subject) => subject.faculty),
      );
      const faculty = faculties[index];
      if (!faculty) {
        await ctx.reply("Факультет не найден. Запустите /practice снова.");
        return;
      }

      state.selectedFaculty = faculty;
      state.step = "choose-subject";
      state.selectedSubject = undefined;
      state.selectedTestType = undefined;
      state.user = await api.updatePreferences(state.user.id, { faculty });

      const subjectNames = uniqueSorted(
        state.subjects
          .filter((subject) => subject.course === state.selectedCourse && subject.faculty === faculty)
          .map((subject) => subject.subject),
      );
      if (subjectNames.length === 0) {
        await ctx.reply(`Для курса ${state.selectedCourse} и факультета ${faculty} на данный момент тестов нет.`);
        return;
      }
      await ctx.reply(
        `Курс: ${state.selectedCourse}\nФакультет: ${faculty}\nВыберите предмет:`,
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

  bot.action(/^course:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const state = requireState(ctx.chat?.id, stateByChatId);
      if (state.step !== "choose-course") {
        await ctx.reply("Перезапустите процесс командой /practice.");
        return;
      }

      const course = Number(ctx.match[1]);
      const availableCourses = uniqueSortedNumbers(state.subjects.map((subject) => subject.course));
      if (!availableCourses.includes(course)) {
        await ctx.reply("Курс не найден. Запустите /practice снова.");
        return;
      }
      state.selectedCourse = course;
      state.step = "choose-faculty";
      state.selectedFaculty = undefined;
      state.selectedSubject = undefined;
      state.selectedTestType = undefined;
      state.user = await api.updatePreferences(state.user.id, { course });

      const faculties = uniqueSorted(
        state.subjects.filter((subject) => subject.course === course).map((subject) => subject.faculty),
      );
      if (faculties.length === 0) {
        await ctx.reply(`Для курса ${course} на данный момент тестов нет.`);
        return;
      }
      await ctx.reply(
        `Курс: ${course}\nВыберите факультет:`,
        Markup.inlineKeyboard(
          faculties.map((faculty, facultyIndex) => [Markup.button.callback(faculty, `faculty:${facultyIndex}`)]),
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
      if (state.step !== "choose-subject" || !state.selectedFaculty || !state.selectedCourse) {
        await ctx.reply("Перезапустите процесс командой /practice.");
        return;
      }

      const index = Number(ctx.match[1]);
      const subjectNames = uniqueSorted(
        state.subjects
          .filter(
            (subject) =>
              subject.course === state.selectedCourse && subject.faculty === state.selectedFaculty,
          )
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
              subject.course === state.selectedCourse &&
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
          [Markup.button.callback("Один вопрос", "mode:single")],
          [Markup.button.callback("Практика 10 вопросов", "mode:pack")],
          [Markup.button.callback("Экзамен", "mode:exam-prep")],
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
        !state.selectedCourse ||
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
          subject.course === state.selectedCourse &&
          subject.faculty === state.selectedFaculty &&
          subject.subject === state.selectedSubject &&
          subject.testType === state.selectedTestType,
      );

      if (!selectedSubject) {
        await ctx.reply(
          formatNoTestsForSelectionError(
            state.selectedFaculty,
            state.selectedCourse,
            state.selectedSubject,
          ),
        );
        return;
      }

      state.user = await api.updatePreferences(state.user.id, {
        mode,
        ...(state.selectedCourse ? { course: state.selectedCourse } : {}),
        ...(state.selectedFaculty ? { faculty: state.selectedFaculty } : {}),
        subjectId: selectedSubject.id,
      });

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

      await ctx.reply(`Сессия начата в режиме: ${formatModeLabel(mode)}`);
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
        ? "Правильно 👏"
        : `К сожалению ответ неверный 🥲.\nПравильный(е) вариант(ы): ${correctOptionsText}.`;
      await ctx.reply(answerText);

      if (result.nextQuestion) {
        state.activeQuestionId = result.nextQuestion.id;
        await sendQuestion(ctx, result.nextQuestion, result.session.progress, result.session.errors.length);
        return;
      }

      if (result.session.mode === "single") {
        state.step = "single-finished";
        state.activeSessionId = undefined;
        state.activeQuestionId = undefined;
        await ctx.reply(
          "Выберите следующее действие:",
          Markup.inlineKeyboard([
            [Markup.button.callback("Еще вопрос", "single-next")],
            [Markup.button.callback("Сменить режим", "single-change-mode")],
            [Markup.button.callback("Сменить предмет", "single-change-subject")],
          ]),
        );
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

  bot.action("single-next", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const state = requireState(ctx.chat?.id, stateByChatId);
      if (state.step !== "single-finished") {
        await ctx.reply("Сначала завершите вопрос в режиме single.");
        return;
      }

      const selectedSubject = findSelectedSubject(state);
      if (!selectedSubject) {
        await ctx.reply("Не удалось определить предмет. Запустите /practice снова.");
        return;
      }

      const started = await api.startSession({
        userId: state.user.id,
        subjectId: selectedSubject.id,
        mode: "single",
      });

      if (!started.firstQuestion) {
        await ctx.reply("Сессия начата, но вопрос не был получен.");
        return;
      }

      state.step = "in-session";
      state.activeSessionId = started.session.id;
      state.activeQuestionId = started.firstQuestion.id;
      await sendQuestion(ctx, started.firstQuestion, started.session.progress);
    } catch (error) {
      await ctx.reply(toErrorText(error));
    }
  });

  bot.action("single-change-mode", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const state = requireState(ctx.chat?.id, stateByChatId);
      if (state.step !== "single-finished" || !state.selectedSubject || !state.selectedTestType) {
        await ctx.reply("Не удалось сменить режим. Запустите /practice снова.");
        return;
      }

      state.step = "choose-mode";
      state.activeSessionId = undefined;
      state.activeQuestionId = undefined;
      await sendModeSelection(ctx);
    } catch (error) {
      await ctx.reply(toErrorText(error));
    }
  });

  bot.action("single-change-subject", async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const state = requireState(ctx.chat?.id, stateByChatId);
      if (state.step !== "single-finished" || !state.selectedFaculty) {
        await ctx.reply("Не удалось сменить предмет. Запустите /practice снова.");
        return;
      }

      state.step = "choose-subject";
      state.selectedSubject = undefined;
      state.selectedTestType = undefined;
      state.activeSessionId = undefined;
      state.activeQuestionId = undefined;
      if (!state.selectedCourse) {
        await ctx.reply("Сначала выберите курс. Запустите /practice снова.");
        return;
      }
      await sendSubjectSelection(ctx, state.subjects, state.selectedFaculty, state.selectedCourse);
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
        await ctx.reply("Код тарифа отсутствует.");
        return;
      }
      state.user = await api.changeMyPlan(state.user.id, planCode);
      // @ts-ignore
      await ctx.reply(`Тариф успешно обновлен 🎉.\nТекущий тариф: ${mapCurrentPlanToEmoji[state.user.planCode]}`, MENU_KEYBOARD);
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
    state.step = "choose-course";
    const preferenceCourse = state.user.preferences?.course;
    const availableCourses = uniqueSortedNumbers(subjects.map((subject) => subject.course));
    if (availableCourses.length === 0) {
      await ctx.reply("Нет доступных курсов с тестами.");
      return;
    }
    state.selectedCourse =
      typeof preferenceCourse === "number" && Number.isInteger(preferenceCourse) && availableCourses.includes(preferenceCourse)
        ? preferenceCourse
        : undefined;
    state.selectedFaculty = undefined;
    state.selectedSubject = undefined;
    state.selectedTestType = undefined;
    state.activeSessionId = undefined;
    state.activeQuestionId = undefined;

    await ctx.reply(
      state.selectedCourse
        ? `Сохраненный курс: ${state.selectedCourse}\nВыберите курс (можно изменить):`
        : "Выберите курс:",
      Markup.inlineKeyboard(
        availableCourses.map((course) => [Markup.button.callback(String(course), `course:${course}`)]),
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
        // @ts-ignore
        `Текущий тариф: <b>${mapCurrentPlanToEmoji[state.user.planCode]}</b>`,
        "",
        ...plans.map((plan) => formatPlanQuote(plan)),
      ].join("\n"),
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard(
          plans.map((plan) => [Markup.button.callback(`Выбрать "${plan.name}"`, `plan:${plan.code}`)]),
        ).reply_markup,
      },
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

async function sendModeSelection(ctx: { reply: (...args: any[]) => Promise<unknown> }): Promise<void> {
  await ctx.reply(
    "Выберите режим:",
    Markup.inlineKeyboard([
      [Markup.button.callback("Один вопрос", "mode:single")],
      [Markup.button.callback("Практика 10 вопросов", "mode:pack")],
      [Markup.button.callback("Экзамен", "mode:exam-prep")],
    ]),
  );
}

async function sendSubjectSelection(
  ctx: { reply: (...args: any[]) => Promise<unknown> },
  subjects: Subject[],
  selectedFaculty: string,
  selectedCourse: number,
): Promise<void> {
  const subjectNames = uniqueSorted(
    subjects
      .filter((subject) => subject.course === selectedCourse && subject.faculty === selectedFaculty)
      .map((subject) => subject.subject),
  );
  await ctx.reply(
    `Курс: ${selectedCourse}\nФакультет: ${selectedFaculty}\nВыберите предмет:`,
    Markup.inlineKeyboard(
      subjectNames.map((subjectName, subjectIndex) =>
        Markup.button.callback(subjectName, `subject:${subjectIndex}`),
      ),
    ),
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
  const hasIncorrectSelection = question.options.some(
    (option) => selectedIds.has(option.optionId) && !option.isCorrect,
  );

  return Markup.inlineKeyboard(
    question.options.map((option) => {
      const isSelected = selectedIds.has(option.optionId);
      const shouldMarkAsCorrect = option.isCorrect && (isSelected || hasIncorrectSelection || isCompleted);
      const prefix = shouldMarkAsCorrect ? "✅" : isSelected ? "❌" : "";
      const callbackData = isCompleted || isSelected ? `done:${option.optionId}` : `answer:${option.optionId}`;
      return [
        Markup.button.callback(`${prefix} ${option.optionId}. ${option.text}`, callbackData)
      ];
    }),
  );
}

function findSelectedSubject(state: ChatState): Subject | undefined {
  if (!state.selectedCourse || !state.selectedFaculty || !state.selectedSubject || !state.selectedTestType) {
    return undefined;
  }

  return state.subjects.find(
    (subject) =>
      subject.course === state.selectedCourse &&
      subject.faculty === state.selectedFaculty &&
      subject.subject === state.selectedSubject &&
      subject.testType === state.selectedTestType,
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

function uniqueSortedNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function formatNoTestsForSelectionError(
  facultyName: string,
  courseNumber: number,
  subjectName: string,
): string {
  return `Для факультета ${facultyName} по курсу ${courseNumber} для предмета ${subjectName} на данный момент тестов нет.`;
}

function formatPlanQuote(plan: {
  name: string;
  code: string;
  price: number;
  currency: string;
  description: string;
}): string {
  console.log(plan.description);
  const planLines = [
    `<b>${escapeHtml(plan.name)} (${escapeHtml(plan.code)})</b>: ${plan.price} ${escapeHtml(plan.currency)}`,
    `<blockquote>${(plan.description)}</blockquote>\n`,
  ];
  return planLines.join("\n");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message : "Неожиданная ошибка";
}

function formatModeLabel(mode: SessionMode): string {
  if (mode === "single") {
    return "Один вопрос";
  }
  if (mode === "pack") {
    return "Практика 10 вопросов";
  }
  return "Экзамен";
}
