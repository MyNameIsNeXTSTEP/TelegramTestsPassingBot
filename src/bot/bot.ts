import { Markup, Telegraf } from "telegraf";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

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

type FlowIntent = "practice" | "change-selection";

interface ChatState {
  user: User;
  step: ChatStep;
  subjects: Subject[];
  flowIntent?: FlowIntent;
  selectedCourse?: number;
  selectedFaculty?: string;
  selectedSubject?: string;
  selectedTestType?: TestType;
  activeSessionId?: string;
  activeQuestionId?: number;
}

const MENU_KEYBOARD = Markup.keyboard([
  ["Практика", "Тарифы"],
  ["Сменить факультет/курс", "Статус"],
]).resize();
const PAID_PLAN_CODES = new Set(["basic", "pro"]);
const PAYMENT_PAYLOAD_PREFIX = "plan:";
const CURRENCY_EXPONENT_BY_CODE: Record<string, number> = {
  RUB: 2,
};
const SBP_STATUS_POLL_INTERVAL_MS = 5000;
const SBP_STATUS_POLL_ATTEMPTS = 120;
const BROADCAST_COMMAND_NAME = "broadcast";
const BROADCAST_CANCEL_COMMAND_NAME = "cancel_broadcast";

const mapCurrentPlanToEmoji = {
  "free": "Бесплатный 🤓",
  "basic": "Базовый 🧑‍🎓",
  "pro": "Pro 🏆",
};

const splitArrayIntoChunks = (arr: any[], size: number) => {
  return Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
    arr.slice(i * size, i * size + size)
  );
};

export function buildBot(config: BotConfig): Telegraf {
  const bot = new Telegraf(config.token);
  const api = new BotApiClient(config.apiBaseUrl);
  const stateByChatId = new Map<number, ChatState>();
  const pendingSbpPayments = new Map<string, { userId: string; planCode: string; chatId: number }>();
  const pendingBroadcastByChatId = new Set<number>();

  bot.start(async (ctx) => {
    try {
      const state = await upsertUserState(ctx.chat.id, stateByChatId, api, ctx.from?.first_name);
      await ctx.reply(
        [
          `Добро пожаловать, ${state.user.name}!\n`,
          // @ts-ignore
          `<b>Текущий тариф:</b> ${mapCurrentPlanToEmoji[state.user.planCode]}\n`,
          "Выберите действие из меню ниже.",
        ].join("\n"),
        {
          parse_mode: "HTML",
          reply_markup: MENU_KEYBOARD.reply_markup,
        },
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

  bot.command(BROADCAST_COMMAND_NAME, async (ctx) => {
    if (!isAdminChatId(ctx.chat.id, config.adminTelegramId)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }

    pendingBroadcastByChatId.add(ctx.chat.id);
    await ctx.reply(
      [
        "Режим рассылки включен.",
        "Отправьте следующим сообщением текст для рассылки всем пользователям.",
        `Для отмены используйте /${BROADCAST_CANCEL_COMMAND_NAME}.`,
      ].join("\n"),
    );
  });

  bot.command(BROADCAST_CANCEL_COMMAND_NAME, async (ctx) => {
    if (!isAdminChatId(ctx.chat.id, config.adminTelegramId)) {
      await ctx.reply("Команда доступна только администратору.");
      return;
    }

    if (!pendingBroadcastByChatId.has(ctx.chat.id)) {
      await ctx.reply("Активной рассылки нет.");
      return;
    }

    pendingBroadcastByChatId.delete(ctx.chat.id);
    await ctx.reply("Рассылка отменена.");
  });

  bot.on("text", async (ctx, next) => {
    if (!isAdminChatId(ctx.chat.id, config.adminTelegramId)) {
      await next();
      return;
    }
    if (!pendingBroadcastByChatId.has(ctx.chat.id)) {
      await next();
      return;
    }

    const commandName = getCommandName(ctx.message.text);
    if (commandName === BROADCAST_CANCEL_COMMAND_NAME) {
      pendingBroadcastByChatId.delete(ctx.chat.id);
      await ctx.reply("Рассылка отменена.");
      return;
    }
    if (commandName) {
      await ctx.reply(`Сейчас включен режим рассылки. Для отмены используйте /${BROADCAST_CANCEL_COMMAND_NAME}.`);
      return;
    }

    pendingBroadcastByChatId.delete(ctx.chat.id);
    try {
      const result = await sendBroadcastMessage(bot, ctx.message.text);
      await ctx.reply(
        [
          "Рассылка завершена.",
          `Всего пользователей: ${result.total}`,
          `Успешно отправлено: ${result.sent}`,
          `Не доставлено: ${result.failed}`,
        ].join("\n"),
      );
    } catch (error) {
      await ctx.reply(`Не удалось выполнить рассылку: ${toErrorText(error)}`);
    }
  });

  bot.hears("Практика", async (ctx) => {
    await startPracticeFlow(ctx.chat.id, stateByChatId, api, ctx);
  });

  bot.hears("Сменить факультет/курс", async (ctx) => {
    await startSelectionFlow(ctx.chat.id, stateByChatId, api, ctx);
  });

  bot.hears("Тарифы", async (ctx) => {
    await showPlans(ctx.chat.id, stateByChatId, api, ctx);
  });

  bot.hears("Статус", async (ctx) => {
    try {
      const state = await upsertUserState(ctx.chat.id, stateByChatId, api, ctx.from?.first_name);
      await ctx.reply(
        [
          `<b>Пользователь:</b> ${state.user.name}`,
          // @ts-ignore
          `<b>Тариф:</b> ${mapCurrentPlanToEmoji[state.user.planCode]} (${formatPlanEndDate(state.user.planEndAtIso)})\n`,
          `<b>Сессий за день:</b> ${state.user.dailyUsage.sessionsStarted}`,
          `<b>Ответов за день:</b> ${state.user.dailyUsage.questionsAnswered}`,
        ].join("\n"),
        {
          parse_mode: "HTML",
        },
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
        buildSubjectKeyboard(subjectNames),
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

      const testTypes = getOrderedTestTypes(
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
          testTypes.map((testType) =>
            Markup.button.callback(formatTestTypeLabel(testType), `test-type:${testType}`),
          ),
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

      if (state.flowIntent === "change-selection") {
        const selectedSubject = findSelectedSubject(state);
        if (!selectedSubject) {
          await ctx.reply("Не удалось определить предмет. Запустите изменение выбора снова.");
          return;
        }
        state.user = await api.updatePreferences(state.user.id, {
          ...(state.selectedCourse ? { course: state.selectedCourse } : {}),
          ...(state.selectedFaculty ? { faculty: state.selectedFaculty } : {}),
          subjectId: selectedSubject.id,
        });
        state.step = "idle";
        state.flowIntent = undefined;
        await ctx.reply(
          [
            "<b>Выбор сохранен</b> ✅\n",
            `<b>Курс:</b> ${selectedSubject.course}`,
            `<b>Факультет:</b> ${selectedSubject.faculty}`,
            `<b>Предмет:</b> ${selectedSubject.subject}`,
            `<b>Тип теста:</b> ${formatTestTypeLabel(selectedSubject.testType)}\n`,
            "Теперь вы можете выбрать действия для продолжения из меню ниже 👇",
          ].join("\n"),
          {
            parse_mode: "HTML",
            reply_markup: MENU_KEYBOARD.reply_markup,
          },
        );
        return;
      }

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

      await ctx.reply(`<i>*Сессия начата в режиме: ${formatModeLabel(mode)}</i>`, {
        parse_mode: "HTML",
      });
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
        : `К сожалению ответ неверный 🥲.\n\nПравильный ответ №${result.correctOptionIds[0]}:\n"<b>${
          result.question.options
            .filter(opt => result.correctOptionIds.includes(opt.optionId))
            .map(opt => opt.text)
            .join(", ")
        }</b>"`;

      await ctx.reply(answerText, {
        parse_mode: "HTML",
      });

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
      state.flowIntent = "practice";
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
      const availablePlans = await api.listPlans();
      const selectedPlan = availablePlans.find((plan) => plan.code === planCode && plan.isActive);
      if (!selectedPlan) {
        await ctx.reply("Тариф недоступен.");
        return;
      }

      if (selectedPlan.code === "free" && isPaidPlanCode(state.user.planCode)) {
        await ctx.reply(
          `Невозможно переключиться на тариф <b>"Бесплатный"</b>, имея активный тариф <b>"${formatPlanName(
            state.user.planCode,
          )}"</b>`,
          {
            parse_mode: "HTML",
          },
        );
        return;
      }

      if (isPaidPlanCode(selectedPlan.code)) {
        await ctx.reply(
          `Выберите способ оплаты для тарифа "${selectedPlan.name}":`,
          Markup.inlineKeyboard([
            [Markup.button.callback("Банковская карта / YooMoney", `plan-pay-card:${selectedPlan.code}`)],
            [Markup.button.callback("СБП", `plan-pay-sbp:${selectedPlan.code}`)],
          ]),
        );
        return;
      }

      state.user = await api.changeMyPlan(state.user.id, selectedPlan.code);
      // @ts-ignore
      await ctx.reply(`Тариф успешно обновлен 🎉.\nТекущий тариф: ${mapCurrentPlanToEmoji[state.user.planCode]}`, MENU_KEYBOARD);
    } catch (error) {
      await ctx.reply(toErrorText(error));
    }
  });

  bot.action(/^plan-pay-card:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const state = requireState(ctx.chat?.id, stateByChatId);
      const planCode = ctx.match[1];
      if (!planCode) {
        await ctx.reply("Код тарифа отсутствует.");
        return;
      }
      const selectedPlan = (await api.listPlans()).find((plan) => plan.code === planCode && plan.isActive);
      if (!selectedPlan || !isPaidPlanCode(selectedPlan.code)) {
        await ctx.reply("Тариф недоступен для оплаты.");
        return;
      }

      await ctx.replyWithInvoice(
        buildPlanInvoice(selectedPlan, state.user.id, config.testYooKassaToken),
      );
    } catch (error) {
      await ctx.reply(toErrorText(error));
    }
  });

  bot.action(/^plan-pay-sbp:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    try {
      const state = requireState(ctx.chat?.id, stateByChatId);
      const planCode = ctx.match[1];
      if (!planCode) {
        await ctx.reply("Код тарифа отсутствует.");
        return;
      }
      const selectedPlan = (await api.listPlans()).find((plan) => plan.code === planCode && plan.isActive);
      if (!selectedPlan || !isPaidPlanCode(selectedPlan.code)) {
        await ctx.reply("Тариф недоступен для оплаты.");
        return;
      }

      const payment = await createYooKassaSbpPayment(config, {
        userId: state.user.id,
        planCode: selectedPlan.code,
        planName: selectedPlan.name,
        price: selectedPlan.price,
        currency: selectedPlan.currency,
      });
      const chatId = ctx.chat?.id;
      if (typeof chatId !== "number") {
        await ctx.reply("Не удалось определить чат для СБП-платежа.");
        return;
      }
      pendingSbpPayments.set(payment.id, {
        userId: state.user.id,
        planCode: selectedPlan.code,
        chatId,
      });

      await ctx.reply(
        "Для оплаты через СБП нажмите кнопку ниже. После оплаты бот проверит статус автоматически и пришлет уведомление.",
        buildSbpPaymentKeyboard(payment.confirmationUrl),
      );
      void monitorSbpPayment({
        paymentId: payment.id,
        pendingSbpPayments,
        stateByChatId,
        api,
        bot,
        config,
      });
    } catch (error) {
      await ctx.reply(`Не удалось создать СБП-платеж: ${toErrorText(error)}`);
    }
  });

  bot.on("pre_checkout_query", async (ctx) => {
    try {
      const payload = parsePlanPaymentPayload(ctx.update.pre_checkout_query.invoice_payload);
      if (!payload || !isPaidPlanCode(payload.planCode)) {
        await ctx.answerPreCheckoutQuery(false, "Некорректные данные платежа.");
        return;
      }

      const chatId = ctx.from?.id;
      if (typeof chatId !== "number") {
        await ctx.answerPreCheckoutQuery(false, "Не удалось определить пользователя.");
        return;
      }
      const state = await upsertUserState(chatId, stateByChatId, api, ctx.from?.first_name);
      if (payload.userId !== state.user.id) {
        await ctx.answerPreCheckoutQuery(false, "Платеж привязан к другому пользователю.");
        return;
      }

      const plan = (await api.listPlans()).find(
        (item) => item.code === payload.planCode && item.isActive,
      );
      if (!plan) {
        await ctx.answerPreCheckoutQuery(false, "Тариф недоступен.");
        return;
      }

      await ctx.answerPreCheckoutQuery(true);
    } catch (_error) {
      await ctx.answerPreCheckoutQuery(false, "Не удалось обработать платеж.");
    }
  });

  bot.on("successful_payment", async (ctx) => {
    try {
      const payment = ctx.message.successful_payment;
      const payload = parsePlanPaymentPayload(payment.invoice_payload);
      if (!payload || !isPaidPlanCode(payload.planCode)) {
        await ctx.reply("Оплата получена, но тариф не удалось определить. Напишите в поддержку.");
        return;
      }

      const state = await upsertUserState(
        ctx.chat.id,
        stateByChatId,
        api,
        ctx.from?.first_name,
      );
      if (payload.userId !== state.user.id) {
        await ctx.reply("Оплата получена для другого пользователя. Напишите в поддержку.");
        return;
      }

      state.user = await api.changeMyPlan(state.user.id, payload.planCode);
      // @ts-ignore
      await ctx.reply(`Платеж прошел успешно ✅\nТариф активирован: ${mapCurrentPlanToEmoji[state.user.planCode]}`, MENU_KEYBOARD);
    } catch (error) {
      await ctx.reply(`Оплата прошла, но не удалось активировать тариф: ${toErrorText(error)}`);
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
    state.flowIntent = "practice";
    const preferredSubjectId = state.user.preferences?.subjectId;
    const preferredSubject = preferredSubjectId
      ? subjects.find((subject) => subject.id === preferredSubjectId)
      : undefined;
    if (preferredSubject) {
      applySelectedSubjectToState(state, preferredSubject);
      state.step = "choose-mode";
      await ctx.reply(
        [
          "Ваш текущий факультет/курс:\n",
          `<b>Курс:</b> ${preferredSubject.course}`,
          `<b>Факультет:</b> ${preferredSubject.faculty}`,
          `<b>Предмет:</b> ${preferredSubject.subject}`,
          `<b>Тип теста:</b> ${formatTestTypeLabel(preferredSubject.testType)}`,
        ].join("\n"),
        {
          parse_mode: "HTML",
        },
      );
      await sendModeSelection(ctx);
      return;
    }

    state.step = "choose-course";
    const preferenceCourse = state.user.preferences?.course;
    const preferenceFaculty = state.user.preferences?.faculty?.trim();
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

    if (state.selectedCourse && preferenceFaculty) {
      const availableFaculties = uniqueSorted(
        subjects
          .filter((subject) => subject.course === state.selectedCourse)
          .map((subject) => subject.faculty),
      );
      if (availableFaculties.includes(preferenceFaculty)) {
        state.selectedFaculty = preferenceFaculty;
        state.step = "choose-subject";
        await ctx.reply("Использую сохраненные курс и факультет. Выберите предмет:");
        await sendSubjectSelection(ctx, state.subjects, state.selectedFaculty, state.selectedCourse);
        return;
      }
    }

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

async function startSelectionFlow(
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
    state.flowIntent = "change-selection";
    state.step = "choose-course";
    const preferenceCourse = state.user.preferences?.course;
    const availableCourses = uniqueSortedNumbers(subjects.map((subject) => subject.course));
    if (availableCourses.length === 0) {
      await ctx.reply("Нет доступных курсов с тестами.");
      return;
    }
    state.selectedCourse =
      typeof preferenceCourse === "number" &&
      Number.isInteger(preferenceCourse) &&
      availableCourses.includes(preferenceCourse)
        ? preferenceCourse
        : undefined;
    state.selectedFaculty = undefined;
    state.selectedSubject = undefined;
    state.selectedTestType = undefined;
    state.activeSessionId = undefined;
    state.activeQuestionId = undefined;

    await ctx.reply(
      state.selectedCourse
        ? `<b>Текущий курс:</b> ${state.selectedCourse}\n\n<b>Выберите курс:</b>`
        : `<b>Выберите курс:</b>`,
      {
        parse_mode: "HTML",
        reply_markup: Markup.inlineKeyboard(
          availableCourses.map((course) => [Markup.button.callback(String(course), `course:${course}`)]),
        ).reply_markup,
      },
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
        `<b>Текущий тариф:</b> ${mapCurrentPlanToEmoji[state.user.planCode]}`,
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
  const optionsText = question.options
    .map((option) => `${option.optionId}. ${escapeHtml(option.text)}`)
    .join("\n");
  const text = [
    `Вопрос ${progress.answeredQuestions + 1}/${progress.totalQuestions}`,
    `Ошибок: ${errorsCount}`,
    "",
    `<b>Вопрос №${question.id}:</b>`,
    `<blockquote>${escapeHtml(question.title)}</blockquote>`,
    "",
    `<b>Варианты ответа:</b>`,
    `<blockquote>${optionsText}</blockquote>`,
  ].join("\n");

  await ctx.reply(text, {
    ...buildAnswerKeyboard(question),
    parse_mode: "HTML",
  });
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
    buildSubjectKeyboard(subjectNames),
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

  const chunks = splitArrayIntoChunks(question.options, 2);

  return Markup.inlineKeyboard(
    chunks.map((chunk) =>
      chunk.map((option) => {
        const isSelected = selectedIds.has(option.optionId);
        const shouldMarkAsCorrect = option.isCorrect && (isSelected || hasIncorrectSelection || isCompleted);
        const prefix = shouldMarkAsCorrect ? "✅" : isSelected ? "❌" : "";
        const callbackData = isCompleted || isSelected ? `done:${option.optionId}` : `answer:${option.optionId}`;
        const buttonLabel = prefix ? `${prefix} ${option.optionId}` : `${option.optionId}`;
        return Markup.button.callback(buttonLabel, callbackData);
      }),
    ),
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

function applySelectedSubjectToState(state: ChatState, subject: Subject): void {
  state.selectedCourse = subject.course;
  state.selectedFaculty = subject.faculty;
  state.selectedSubject = subject.subject;
  state.selectedTestType = subject.testType;
  state.activeSessionId = undefined;
  state.activeQuestionId = undefined;
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

function getOrderedTestTypes(values: TestType[]): TestType[] {
  const priority: Record<TestType, number> = {
    exam: 0,
    credit: 1,
  };
  return [...new Set(values)].sort((a, b) => priority[a] - priority[b]);
}

function buildSubjectKeyboard(subjectNames: string[]) {
  const buttonsPerRow = 1;
  const rows = Array.from(
    { length: Math.ceil(subjectNames.length / buttonsPerRow) },
    (_value, rowIndex) => {
      const start = rowIndex * buttonsPerRow;
      return subjectNames.slice(start, start + buttonsPerRow).map((subjectName, offset) =>
        Markup.button.callback(subjectName, `subject:${start + offset}`),
      );
    },
  );
  return Markup.inlineKeyboard(rows);
}

function formatNoTestsForSelectionError(
  facultyName: string,
  courseNumber: number,
  subjectName: string,
): string {
  return `Для факультета ${facultyName} по курсу ${courseNumber} для предмета ${subjectName} на данный момент тестов нет.`;
}

function formatTestTypeLabel(testType: TestType): string {
  if (testType === "exam") {
    return "Экзамен";
  }
  return "Зачет";
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

function buildPlanInvoice(
  plan: { code: string; name: string; description: string; price: number; currency: string },
  userId: string,
  providerToken: string,
): {
  title: string;
  description: string;
  payload: string;
  provider_token: string;
  currency: string;
  prices: Array<{ label: string; amount: number }>;
  start_parameter: string;
  provider_data: string;
} {
  const normalizedCurrency = plan.currency.toUpperCase();
  return {
    title: `Тариф ${plan.name}`,
    description: compactText(plan.description),
    payload: createPlanPaymentPayload(userId, plan.code),
    provider_token: providerToken,
    currency: normalizedCurrency,
    prices: [
      {
        label: `Оплата тарифа ${plan.name}`,
        amount: toMinorAmount(plan.price, normalizedCurrency),
      },
    ],
    start_parameter: `plan-${plan.code}`,
    provider_data: JSON.stringify({
      amount: {
        value: toMajorAmountString(plan.price, normalizedCurrency),
        currency: normalizedCurrency,
      },
      receipt: {
        customer: {
          email: "test@example.com",
        },
        items: [
          {
            description: `Подписка ${plan.name}`,
            quantity: "1",
            amount: {
              value: toMajorAmountString(plan.price, normalizedCurrency),
              currency: normalizedCurrency,
            },
            vat_code: 1,
            vatCode: 1,
            payment_mode: "full_payment",
            payment_subject: "service",
            paymentMode: "full_payment",
            paymentSubject: "service",
          },
        ],
      },
    }),
  };
}

function buildSbpPaymentKeyboard(confirmationUrl: string) {
  return Markup.inlineKeyboard([
    [Markup.button.url("Оплатить по СБП", confirmationUrl)],
  ]);
}

function isPaidPlanCode(planCode: string): boolean {
  return PAID_PLAN_CODES.has(planCode);
}

function createPlanPaymentPayload(userId: string, planCode: string): string {
  return `${PAYMENT_PAYLOAD_PREFIX}${userId}:${planCode}`;
}

function parsePlanPaymentPayload(payload: string): { userId: string; planCode: string } | null {
  if (!payload.startsWith(PAYMENT_PAYLOAD_PREFIX)) {
    return null;
  }

  const raw = payload.slice(PAYMENT_PAYLOAD_PREFIX.length);
  const separatorIndex = raw.lastIndexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }

  const userId = raw.slice(0, separatorIndex).trim();
  const planCode = raw.slice(separatorIndex + 1).trim();
  if (!userId || !planCode) {
    return null;
  }

  return { userId, planCode };
}

function compactText(value: string): string {
  return value
    .replaceAll("\n", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toMinorAmount(price: number, currency: string): number {
  const exponent = CURRENCY_EXPONENT_BY_CODE[currency.toUpperCase()] ?? 2;
  return Math.round(price * 10 ** exponent);
}

function toMajorAmountString(price: number, currency: string): string {
  const exponent = CURRENCY_EXPONENT_BY_CODE[currency.toUpperCase()] ?? 2;
  return price.toFixed(exponent);
}

async function createYooKassaSbpPayment(
  config: BotConfig,
  input: { userId: string; planCode: string; planName: string; price: number; currency: string },
): Promise<{ id: string; confirmationUrl: string }> {
  const currency = input.currency.toUpperCase();
  const response = await fetch("https://api.yookassa.ru/v3/payments", {
    method: "POST",
    headers: {
      Authorization: buildYooKassaAuthHeader(config),
      "Content-Type": "application/json",
      "Idempotence-Key": randomUUID(),
    },
    body: JSON.stringify({
      amount: {
        value: toMajorAmountString(input.price, currency),
        currency,
      },
      capture: true,
      description: `Оплата тарифа ${input.planName}`,
      payment_method_data: {
        type: "sbp",
      },
      confirmation: {
        type: "redirect",
        return_url: "https://t.me",
      },
      metadata: {
        userId: input.userId,
        planCode: input.planCode,
        source: "telegram-bot",
      },
      receipt: {
        customer: {
          email: "test@example.com",
        },
        items: [
          {
            description: `Подписка ${input.planName}`,
            quantity: "1",
            amount: {
              value: toMajorAmountString(input.price, currency),
              currency,
            },
            vat_code: 1,
            payment_mode: "full_payment",
            payment_subject: "service",
          },
        ],
      },
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`YooKassa error ${response.status}: ${raw}`);
  }
  const data = tryParseJson(raw);
  if (!isRecord(data)) {
    throw new Error("Некорректный ответ YooKassa");
  }
  const id = asNonEmptyString(data.id, "id");
  const confirmation = data.confirmation;
  if (!isRecord(confirmation)) {
    throw new Error("В ответе YooKassa отсутствует confirmation");
  }
  const confirmationUrl = asNonEmptyString(confirmation.confirmation_url, "confirmation_url");
  return { id, confirmationUrl };
}

async function getYooKassaPayment(
  config: BotConfig,
  paymentId: string,
): Promise<{ status: string }> {
  const response = await fetch(`https://api.yookassa.ru/v3/payments/${encodeURIComponent(paymentId)}`, {
    method: "GET",
    headers: {
      Authorization: buildYooKassaAuthHeader(config),
      "Content-Type": "application/json",
    },
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`YooKassa error ${response.status}: ${raw}`);
  }
  const data = tryParseJson(raw);
  if (!isRecord(data)) {
    throw new Error("Некорректный ответ YooKassa");
  }
  return {
    status: asNonEmptyString(data.status, "status"),
  };
}

async function monitorSbpPayment(params: {
  paymentId: string;
  pendingSbpPayments: Map<string, { userId: string; planCode: string; chatId: number }>;
  stateByChatId: Map<number, ChatState>;
  api: BotApiClient;
  bot: Telegraf;
  config: BotConfig;
}): Promise<void> {
  for (let attempt = 0; attempt < SBP_STATUS_POLL_ATTEMPTS; attempt += 1) {
    const pending = params.pendingSbpPayments.get(params.paymentId);
    if (!pending) {
      return;
    }

    try {
      const payment = await getYooKassaPayment(params.config, params.paymentId);
      if (payment.status === "succeeded") {
        const updatedUser = await params.api.changeMyPlan(pending.userId, pending.planCode);
        const chatState = params.stateByChatId.get(pending.chatId);
        if (chatState && chatState.user.id === pending.userId) {
          chatState.user = updatedUser;
        }

        params.pendingSbpPayments.delete(params.paymentId);
        // @ts-ignore
        await params.bot.telegram.sendMessage(
          pending.chatId,
          `Платеж через СБП прошел успешно ✅\nТариф активирован: ${formatPlanLabel(updatedUser.planCode)}`,
          MENU_KEYBOARD,
        );
        return;
      }

      if (payment.status === "canceled") {
        params.pendingSbpPayments.delete(params.paymentId);
        await params.bot.telegram.sendMessage(pending.chatId, "СБП-платеж отменен. Попробуйте снова.");
        return;
      }
    } catch (_error) {
      // Keep polling; transient network/provider errors are expected.
    }

    await sleep(SBP_STATUS_POLL_INTERVAL_MS);
  }

  const pending = params.pendingSbpPayments.get(params.paymentId);
  if (!pending) {
    return;
  }
  params.pendingSbpPayments.delete(params.paymentId);
  await params.bot.telegram.sendMessage(
    pending.chatId,
    "Не удалось автоматически подтвердить СБП-платеж за отведенное время. Если вы уже оплатили, напишите в поддержку.",
  );
}

function buildYooKassaAuthHeader(config: BotConfig): string {
  const creds = `${config.testYooKassaShopId}:${config.testYooKassaSecretKey}`;
  return `Basic ${Buffer.from(creds).toString("base64")}`;
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Expected ${field} to be a non-empty string`);
  }
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatPlanLabel(planCode: string): string {
  return mapCurrentPlanToEmoji[planCode as keyof typeof mapCurrentPlanToEmoji] ?? planCode;
}

function formatPlanName(planCode: string): string {
  if (planCode === "free") {
    return "Бесплатный";
  }
  if (planCode === "basic") {
    return "Базовый";
  }
  if (planCode === "pro") {
    return "Pro";
  }
  return planCode;
}

function formatPlanEndDate(planEndAtIso?: string | null): string {
  if (!planEndAtIso) {
    return "без срока";
  }

  const date = new Date(planEndAtIso);
  if (Number.isNaN(date.getTime())) {
    return "без срока";
  }

  const dateString = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
  return `до ${dateString}`;
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

function isAdminChatId(chatId: number, adminTelegramId: string): boolean {
  return String(chatId) === adminTelegramId;
}

function getCommandName(text: string): string | null {
  const firstToken = text.trim().split(/\s+/, 1)[0];
  if (typeof firstToken !== "string" || !firstToken.startsWith("/")) {
    return null;
  }

  const commandToken = firstToken.slice(1).split("@", 1)[0];
  if (typeof commandToken !== "string" || !commandToken) {
    return null;
  }
  return commandToken.toLowerCase();
}

async function sendBroadcastMessage(
  bot: Telegraf,
  messageText: string,
): Promise<{ total: number; sent: number; failed: number }> {
  const telegramChatIds = await loadRegisteredTelegramChatIds();
  let sent = 0;
  let failed = 0;

  for (const chatId of telegramChatIds) {
    try {
      await bot.telegram.sendMessage(chatId, messageText);
      sent += 1;
    } catch {
      failed += 1;
    }
  }

  return {
    total: telegramChatIds.length,
    sent,
    failed,
  };
}

async function loadRegisteredTelegramChatIds(): Promise<number[]> {
  const rawUsers = await readFile(new URL("../../data/users.json", import.meta.url), "utf8");
  const parsedUsers: unknown = JSON.parse(rawUsers);
  if (!Array.isArray(parsedUsers)) {
    throw new Error("Некорректный формат users.json");
  }

  const chatIds = new Set<number>();
  for (const user of parsedUsers) {
    const chatId = getUserTelegramChatId(user);
    if (typeof chatId === "number") {
      chatIds.add(chatId);
    }
  }

  return Array.from(chatIds);
}

function getUserTelegramChatId(value: unknown): number | null {
  if (!isRecord(value)) {
    return null;
  }

  const rawTelegramId = value.telegramId;
  if (typeof rawTelegramId === "number" && Number.isInteger(rawTelegramId) && rawTelegramId > 0) {
    return rawTelegramId;
  }
  if (typeof rawTelegramId !== "string") {
    return null;
  }

  const normalized = rawTelegramId.trim();
  if (!/^\d+$/.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}
