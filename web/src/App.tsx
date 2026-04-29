import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type TestType = "exam" | "credit";
type SessionMode = "single" | "pack" | "exam-prep";
type SessionStatus = "active" | "passed" | "failed" | "abandoned";

interface User {
  id: string;
  telegramId: string;
  name: string;
  planCode: string;
  dailyUsage: {
    sessionsStarted: number;
    questionsAnswered: number;
  };
}

interface Subject {
  id: string;
  faculty: string;
  subject: string;
  testType: TestType;
}

interface QuestionOption {
  optionId: number;
  text: string;
  isCorrect: boolean;
}

interface Question {
  id: number;
  title: string;
  options: QuestionOption[];
}

interface Session {
  id: string;
  mode: SessionMode;
  status: SessionStatus;
  progress: {
    totalQuestions: number;
    answeredQuestions: number;
    correctAnswers: number;
  };
  errors: Array<{ questionId: number }>;
}

interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: {
    message: string;
  };
}

interface SubscriptionPlan {
  code: string;
  isActive: boolean;
}

interface SubmitAnswerResult {
  session: Session;
  question: Question;
  isCorrect: boolean;
  correctOptionIds: number[];
  selectedOptionIds: number[];
  questionCompleted: boolean;
  nextQuestion: Question | null;
}

type AccessState = "checking" | "granted" | "denied" | "error";

function resolveApiBaseUrl(): string {
  const rawValue = (import.meta.env.VITE_API_BASE_URL ?? "").trim();
  if (!rawValue) {
    return "/api";
  }

  try {
    const parsed = new URL(rawValue, window.location.origin);
    const isLocalHost = ["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname);
    if (isLocalHost && window.location.hostname !== parsed.hostname) {
      // Telegram WebView runs on a remote device; localhost there is not your dev machine.
      return "/api";
    }
  } catch {
    // Keep the raw value if URL parsing fails (e.g. relative path).
  }

  return rawValue.replace(/\/+$/, "");
}

const API_BASE_URL = resolveApiBaseUrl();

declare global {
  interface Window {
    Telegram: {
      WebApp: {
        initDataUnsafe: {
          user: {
            id: number;
            language_code: string;
            first_name?: string;
            last_name?: string;
            username?: string;
          };
        };
        enableClosingConfirmation: () => void;
        expand: () => void;
        ready: () => void;
        sendData: (data: string) => void;
        initData: string;
        showPopup?: (
          params: {
            title?: string;
            message: string;
            buttons?: Array<{
              id?: string;
              type?: 'default' | 'ok' | 'close' | 'cancel' | 'destructive';
              text?: string;
            }>;
          },
          callback?: (buttonId: string) => void
        ) => void;
        MainButton?: {
          show: () => void;
          hide: () => void;
          disable: () => void;
          enable: () => void;
          setText: (text: string) => void;
          onClick: (cb: () => void) => void;
          offClick: (cb: () => void) => void;
          showProgress: (isLoading: boolean) => void;
          hideProgress: () => void;
          setParams: (params: {
            text: string;
            color: string;
            is_active: boolean;
            is_loading: boolean;
          }) => void;
        };
      };
    };
  }
}

export function getTelegramWebApp() {
  if (typeof window === 'undefined') return undefined;
  return window.Telegram?.WebApp;
};

/**
 * @typedef {Object} Vacancy
 * @property {string|number=} id
 * @property {string=} title
 * @property {string=} description
 * @property {string=} expected_experience
 * @property {string=} salary
 * @property {string=} link
 * @property {string=} category
 * @property {string=} location
 * @property {string=} country
 * @property {string=} city
 * @property {boolean=} remote
 */
/**
 * @typedef {Object} Company
 * @property {string|number=} id
 * @property {string=} name
 * @property {string=} description
 * @property {Vacancy[]=} vacancies
 */
function App() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [accessState, setAccessState] = useState<AccessState>("checking");
  const [accessMessage, setAccessMessage] = useState<string>("");

  const [user, setUser] = useState<User | null>(null);

  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selectedFaculty, setSelectedFaculty] = useState<string | null>(null);
  const [selectedSubjectName, setSelectedSubjectName] = useState<string | null>(null);
  const [selectedTestType, setSelectedTestType] = useState<TestType | null>(null);
  const [selectedMode, setSelectedMode] = useState<SessionMode | null>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [currentQuestion, setCurrentQuestion] = useState<Question | null>(null);
  const [selectedOptionIds, setSelectedOptionIds] = useState<number[]>([]);
  const [questionCompleted, setQuestionCompleted] = useState(false);
  const [resultText, setResultText] = useState<string | null>(null);
  const [singleFinished, setSingleFinished] = useState(false);

  // Telegram WebApp init
  useEffect(() => {
    const tg = getTelegramWebApp();
    if (tg) {
      tg.expand();
      tg.ready();
      tg.enableClosingConfirmation();
    }
  }, []);

  const faculties = useMemo(
    () => [...new Set(subjects.map((subject) => subject.faculty))].sort((a, b) => a.localeCompare(b)),
    [subjects],
  );

  const filteredSubjectNames = useMemo(() => {
    if (!selectedFaculty) {
      return [];
    }

    return [
      ...new Set(
        subjects
          .filter((subject) => subject.faculty === selectedFaculty)
          .map((subject) => subject.subject),
      ),
    ].sort((a, b) => a.localeCompare(b));
  }, [selectedFaculty, subjects]);

  const availableTestTypes = useMemo(() => {
    if (!selectedFaculty || !selectedSubjectName) {
      return [];
    }

    return [
      ...new Set(
        subjects
          .filter(
            (subject) =>
              subject.faculty === selectedFaculty && subject.subject === selectedSubjectName,
          )
          .map((subject) => subject.testType),
      ),
    ];
  }, [selectedFaculty, selectedSubjectName, subjects]);

  const selectedSubject = useMemo(() => {
    if (!selectedFaculty || !selectedSubjectName || !selectedTestType) {
      return null;
    }

    return (
      subjects.find(
        (subject) =>
          subject.faculty === selectedFaculty &&
          subject.subject === selectedSubjectName &&
          subject.testType === selectedTestType,
      ) ?? null
    );
  }, [selectedFaculty, selectedSubjectName, selectedTestType, subjects]);

  const progressValue = useMemo(() => {
    if (!session || session.progress.totalQuestions === 0) {
      return 0;
    }

    return Math.round((session.progress.answeredQuestions / session.progress.totalQuestions) * 100);
  }, [session]);

  async function request<T>(path: string, init?: RequestInit, userId?: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${API_BASE_URL}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(userId ? { "x-user-id": userId } : {}),
          ...(init?.headers ?? {}),
        },
      });
    } catch {
      throw new Error(
        "Не удалось подключиться к API. Укажите публичный HTTPS URL в VITE_API_BASE_URL или настройте /api proxy.",
      );
    }

    const payload = (await response.json()) as ApiResponse<T>;
    if (!response.ok || !payload.ok || !payload.data) {
      throw new Error(payload.error?.message ?? "API request failed");
    }

    return payload.data;
  }

  function resolveTelegramIdentity(): { telegramId: string; name: string } | null {
    const query = new URLSearchParams(window.location.search);
    const queryTelegramId = query.get("telegramId") ?? query.get("tg_id");
    const queryName = query.get("name");
    if (queryTelegramId) {
      return {
        telegramId: queryTelegramId,
        name: queryName?.trim() || "Student",
      };
    }

    const tgUser = getTelegramWebApp()?.initDataUnsafe?.user;
    if (tgUser?.id) {
      const fallbackName =
        `${tgUser.first_name ?? ""} ${tgUser.last_name ?? ""}`.trim() ||
        tgUser.username ||
        "Student";

      return {
        telegramId: String(tgUser.id),
        name: fallbackName,
      };
    }

    return null;
  }

  async function bootstrap(): Promise<void> {
    setBusy(true);
    setError(null);

    try {
      const identity = resolveTelegramIdentity();
      if (!identity) {
        setAccessState("denied");
        setAccessMessage("Не удалось определить Telegram пользователя.");
        return;
      }

      const loginData = await request<{ user: User }>("/auth/login", {
        method: "POST",
        body: JSON.stringify(identity),
      });

      const plansData = await request<{ plans: SubscriptionPlan[] }>("/subscriptions/plans");
      const currentPlan = plansData.plans.find((plan) => plan.code === loginData.user.planCode);
      const hasActivePro =
        loginData.user.planCode === "pro-student" && Boolean(currentPlan?.isActive);

      if (!hasActivePro) {
        setAccessState("denied");
        setAccessMessage("Веб-приложение доступно только с активной PRO подпиской.");
        return;
      }

      setUser(loginData.user);
      await loadSubjects();
      setAccessState("granted");
    } catch (bootstrapError) {
      setAccessState("error");
      setAccessMessage(
        bootstrapError instanceof Error ? bootstrapError.message : "Ошибка проверки доступа.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function loadSubjects(): Promise<void> {
    const data = await request<{ subjects: Subject[] }>("/tests/subjects");
    setSubjects(data.subjects);
    setSelectedFaculty(null);
    setSelectedSubjectName(null);
    setSelectedTestType(null);
    setSelectedMode(null);
    setSession(null);
    setCurrentQuestion(null);
    setSelectedOptionIds([]);
    setQuestionCompleted(false);
    setSingleFinished(false);
    setResultText(null);
    setHint(null);
  }

  async function startSession(mode: SessionMode): Promise<void> {
    if (!user || !selectedSubject) {
      return;
    }

    setBusy(true);
    setError(null);
    setHint(null);
    setResultText(null);
    setSelectedMode(mode);

    try {
      const data = await request<{ session: Session; firstQuestion: Question | null }>(
        "/tests/sessions/start",
        {
          method: "POST",
          body: JSON.stringify({
            subjectId: selectedSubject.id,
            mode,
          }),
        },
        user.id,
      );

      setSession(data.session);
      setCurrentQuestion(data.firstQuestion);
      setSelectedOptionIds([]);
      setQuestionCompleted(false);
      setSingleFinished(false);
    } catch (sessionError) {
      setError(sessionError instanceof Error ? sessionError.message : "Session start failed");
    } finally {
      setBusy(false);
    }
  }

  async function submitAnswer(optionId: number): Promise<void> {
    if (!user || !session || !currentQuestion || selectedOptionIds.includes(optionId)) {
      return;
    }

    setBusy(true);
    setError(null);
    setHint(null);

    try {
      const data = await request<SubmitAnswerResult>(
        "/tests/sessions/answer",
        {
          method: "POST",
          body: JSON.stringify({
            sessionId: session.id,
            questionId: currentQuestion.id,
            selectedOptionId: optionId,
          }),
        },
        user.id,
      );

      setSession(data.session);
      setCurrentQuestion(data.question);
      setSelectedOptionIds(data.selectedOptionIds);
      setQuestionCompleted(data.questionCompleted);

      if (!data.questionCompleted) {
        setHint(
          data.isCorrect
            ? "Верно. Выберите следующий вариант ответа."
            : "Этот вариант неверный. Продолжайте выбирать ответы.",
        );
        return;
      }

      const responseText = data.isCorrect
        ? "Правильно."
        : `Ответ неверный. Правильный(е) вариант(ы): ${data.correctOptionIds.join(", ")}`;
      setResultText(responseText);

      if (data.nextQuestion) {
        setCurrentQuestion(data.nextQuestion);
        setSelectedOptionIds([]);
        setQuestionCompleted(false);
        setHint(null);
        return;
      }

      if (data.session.mode === "single") {
        setSingleFinished(true);
      }
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Answer submit failed");
    } finally {
      setBusy(false);
    }
  }

  async function continueSingleMode(): Promise<void> {
    if (selectedMode !== "single") {
      return;
    }

    await startSession("single");
  }

  function switchModeSelection(): void {
    setSession(null);
    setCurrentQuestion(null);
    setSelectedOptionIds([]);
    setQuestionCompleted(false);
    setSingleFinished(false);
    setResultText(null);
  }

  function switchSubjectSelection(): void {
    switchModeSelection();
    setSelectedSubjectName(null);
    setSelectedTestType(null);
    setSelectedMode(null);
  }

  useEffect(() => {
    void bootstrap();
  }, []);

  return (
    <main className="theme dark mx-auto flex min-h-screen w-full max-w-md flex-col bg-slate-950 px-4 py-5 text-slate-100">
      <Card className="border-slate-800 bg-slate-900/80 backdrop-blur">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between text-base">
            <span>Ampula</span>
            <Badge variant="outline" className="border-cyan-500/40 text-cyan-300">
              Pro
            </Badge>
          </CardTitle>
          <CardDescription className="text-slate-400">
            Твой мобильный тренажер для подготовки к экзаменам.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {accessState === "checking" ? (
            <p className="text-sm text-slate-300">Проверяем доступ к mini app...</p>
          ) : null}

          {accessState === "denied" ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-red-300">
                Доступ ограничен.
              </p>
              <p className="text-sm text-slate-300">
                {accessMessage || "Веб-приложение доступно только по PRO подписке."}
              </p>
            </div>
          ) : null}

          {accessState === "error" ? (
            <div className="space-y-2">
              <p className="text-sm font-medium text-red-300">Ошибка авторизации.</p>
              <p className="text-sm text-slate-300">{accessMessage}</p>
            </div>
          ) : null}

          {accessState === "granted" && user ? (
            <div className="space-y-2 text-sm">
              <p className="font-medium text-slate-100">{user.name}</p>
              <p className="text-slate-400">Тариф: {user.planCode}</p>
              <p className="text-slate-400">
                Сегодня: {user.dailyUsage.sessionsStarted} сессий, {user.dailyUsage.questionsAnswered} ответов
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    void loadSubjects();
                  }}
                  disabled={busy}
                >
                  Обновить данные
                </Button>
              </div>
            </div>
          ) : null}
          {error ? <p className="text-sm text-red-300">{error}</p> : null}
        </CardContent>
      </Card>

      {accessState === "granted" && user && subjects.length > 0 && !session ? (
        <Card className="mt-4 border-slate-800 bg-slate-900/80">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Подготовка</CardTitle>
            <CardDescription className="text-slate-400">
              Шаги повторяют логику Telegram-бота.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <p className="text-sm text-slate-400">1. Факультет</p>
              <div className="flex flex-wrap gap-2">
                {faculties.map((faculty) => (
                  <Button
                    key={faculty}
                    size="sm"
                    variant={selectedFaculty === faculty ? "default" : "outline"}
                    onClick={() => {
                      setSelectedFaculty(faculty);
                      setSelectedSubjectName(null);
                      setSelectedTestType(null);
                      setSelectedMode(null);
                    }}
                  >
                    {faculty}
                  </Button>
                ))}
              </div>
            </div>

            {selectedFaculty ? (
              <div className="space-y-2">
                <p className="text-sm text-slate-400">2. Предмет</p>
                <div className="flex flex-wrap gap-2">
                  {filteredSubjectNames.map((subjectName) => (
                    <Button
                      key={subjectName}
                      size="sm"
                      variant={selectedSubjectName === subjectName ? "default" : "outline"}
                      onClick={() => {
                        setSelectedSubjectName(subjectName);
                        setSelectedTestType(null);
                        setSelectedMode(null);
                      }}
                    >
                      {subjectName}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            {selectedSubjectName ? (
              <div className="space-y-2">
                <p className="text-sm text-slate-400">3. Тип теста</p>
                <div className="flex gap-2">
                  {availableTestTypes.map((testType) => (
                    <Button
                      key={testType}
                      size="sm"
                      variant={selectedTestType === testType ? "default" : "outline"}
                      onClick={() => {
                        setSelectedTestType(testType);
                        setSelectedMode(null);
                      }}
                    >
                      {testType}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}

            {selectedTestType ? (
              <div className="space-y-2">
                <p className="text-sm text-slate-400">4. Режим</p>
                <div className="grid grid-cols-1 gap-2">
                  {[
                    {
                      mode: "single" as const,
                      title: "Одиночный вопрос",
                      subtitle: "Один вопрос за сессию",
                    },
                    {
                      mode: "pack" as const,
                      title: "Пакет (10 вопросов)",
                      subtitle: "Короткая серия для тренировки",
                    },
                    {
                      mode: "exam-prep" as const,
                      title: "Подготовка к экзамену",
                      subtitle: "30 вопросов + штрафные",
                    },
                  ].map((modeCard) => (
                    <Button
                      key={modeCard.mode}
                      variant={selectedMode === modeCard.mode ? "default" : "outline"}
                      className={cn(
                        "h-auto flex-col items-start px-3 py-3 text-left",
                        selectedMode === modeCard.mode && "border-cyan-500/40",
                      )}
                      onClick={() => {
                        void startSession(modeCard.mode);
                      }}
                      disabled={busy}
                    >
                      <span>{modeCard.title}</span>
                      <span className="text-xs text-slate-400">{modeCard.subtitle}</span>
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {session && currentQuestion ? (
        <Card className="mt-4 border-slate-800 bg-slate-900/80">
          <CardHeader className="space-y-2 pb-2">
            <CardTitle className="text-base">Сессия: {session.mode}</CardTitle>
            <CardDescription className="text-slate-400">
              Вопрос {session.progress.answeredQuestions + 1}/{session.progress.totalQuestions} · Ошибок:{" "}
              {session.errors.length}
            </CardDescription>
            <Progress value={progressValue} className="h-2" />
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm leading-6 text-slate-100">{currentQuestion.title}</p>
            <Separator className="bg-slate-800" />
            <div className="space-y-2">
              {currentQuestion.options.map((option) => {
                const selected = selectedOptionIds.includes(option.optionId);
                const isCorrectMark = option.isCorrect && (selected || questionCompleted);
                const isWrongMark = selected && !option.isCorrect;

                return (
                  <Button
                    key={option.optionId}
                    variant="outline"
                    className={cn(
                      "h-auto w-full justify-start px-3 py-3 text-left whitespace-normal",
                      isCorrectMark && "border-emerald-500/60 bg-emerald-500/15",
                      isWrongMark && "border-red-500/60 bg-red-500/15",
                    )}
                    onClick={() => {
                      void submitAnswer(option.optionId);
                    }}
                    disabled={busy || selected || (questionCompleted && !selected)}
                  >
                    <span className="mr-2 font-semibold">{option.optionId}.</span>
                    <span>{option.text}</span>
                  </Button>
                );
              })}
            </div>

            {hint ? <p className="text-xs text-cyan-300">{hint}</p> : null}
            {resultText ? <p className="text-xs text-slate-300">{resultText}</p> : null}

            {singleFinished ? (
              <div className="space-y-2">
                <p className="text-sm text-slate-300">Что делаем дальше ?</p>
                <Button onClick={() => void continueSingleMode()} disabled={busy} className="w-full">
                  Еще вопрос
                </Button>
                <Button onClick={switchModeSelection} variant="outline" className="w-full">
                  Сменить режим
                </Button>
                <Button onClick={switchSubjectSelection} variant="outline" className="w-full">
                  Сменить предмет
                </Button>
              </div>
            ) : null}

            {!singleFinished && session.status !== "active" ? (
              <div className="space-y-2">
                <p className="text-sm text-slate-200">
                  Сессия завершена: {session.status}. Правильных: {session.progress.correctAnswers}/
                  {session.progress.answeredQuestions}
                </p>
                <Button onClick={switchModeSelection} className="w-full">
                  К выбору режима
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </main>
  );
}

export default App;
