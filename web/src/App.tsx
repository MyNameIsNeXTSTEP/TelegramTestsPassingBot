import { useEffect, useMemo, useState } from "react";
import { Menu, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

type TestType = "exam" | "credit";
type SessionMode = "single" | "pack" | "exam-prep";
type SessionStatus = "active" | "passed" | "failed" | "abandoned";
type SetupStep = "course" | "faculty" | "subject" | "ready";
type SettingPanel = "mode" | "course" | "faculty" | "subject" | "plan" | null;
type AccessState = "checking" | "granted" | "denied" | "error";

interface UserPreferences {
  mode?: SessionMode;
  course?: number;
  faculty?: string;
  subjectId?: string;
}

interface User {
  id: string;
  telegramId: string;
  name: string;
  planCode: string;
  preferences?: UserPreferences;
  dailyUsage: {
    sessionsStarted: number;
    questionsAnswered: number;
  };
}

interface Subject {
  id: string;
  course: number;
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
  name: string;
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

const MODE_ITEMS: Array<{ mode: SessionMode; label: string; subtitle: string }> = [
  { mode: "single", label: "Одиночный", subtitle: "1 вопрос" },
  { mode: "pack", label: "Практика", subtitle: "10 вопросов" },
  { mode: "exam-prep", label: "Экзамен", subtitle: "30 + штрафы" },
];

function resolveApiBaseUrl(): string {
  const rawValue = (import.meta.env.VITE_API_BASE_URL ?? "").trim();
  if (!rawValue) {
    return "/api";
  }

  try {
    const parsed = new URL(rawValue, window.location.origin);
    const isLocalHost = ["localhost", "127.0.0.1", "0.0.0.0"].includes(parsed.hostname);
    if (isLocalHost && window.location.hostname !== parsed.hostname) {
      return "/api";
    }
  } catch {
    // Keep raw value for relative paths.
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
      };
    };
  }
}

function getTelegramWebApp() {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.Telegram?.WebApp;
}

function App() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [accessState, setAccessState] = useState<AccessState>("checking");
  const [accessMessage, setAccessMessage] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingPanel, setSettingPanel] = useState<SettingPanel>(null);

  const [user, setUser] = useState<User | null>(null);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [selectedCourse, setSelectedCourse] = useState<number | null>(null);
  const [selectedFaculty, setSelectedFaculty] = useState<string | null>(null);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<SessionMode>("single");

  const [session, setSession] = useState<Session | null>(null);
  const [currentQuestion, setCurrentQuestion] = useState<Question | null>(null);
  const [selectedOptionIds, setSelectedOptionIds] = useState<number[]>([]);
  const [questionCompleted, setQuestionCompleted] = useState(false);
  const [resultText, setResultText] = useState<string | null>(null);
  const [singleFinished, setSingleFinished] = useState(false);

  const faculties = useMemo(
    () =>
      selectedCourse
        ? [...new Set(subjects.filter((subject) => subject.course === selectedCourse).map((subject) => subject.faculty))].sort((a, b) =>
            a.localeCompare(b),
          )
        : [],
    [selectedCourse, subjects],
  );

  const availableCourses = useMemo(
    () => [...new Set(subjects.map((subject) => subject.course))].sort((a, b) => a - b),
    [subjects],
  );

  const filteredSubjects = useMemo(() => {
    if (!selectedFaculty) {
      return [];
    }
    return subjects
      .filter((subject) => subject.course === selectedCourse && subject.faculty === selectedFaculty)
      .sort((left, right) => left.subject.localeCompare(right.subject));
  }, [selectedCourse, selectedFaculty, subjects]);

  const selectedSubject = useMemo(
    () => subjects.find((subject) => subject.id === selectedSubjectId) ?? null,
    [selectedSubjectId, subjects],
  );

  const setupStep: SetupStep = useMemo(() => {
    if (!selectedCourse) {
      return "course";
    }
    if (!selectedFaculty) {
      return "faculty";
    }
    if (!selectedSubjectId) {
      return "subject";
    }
    return "ready";
  }, [selectedCourse, selectedFaculty, selectedSubjectId]);

  const progressValue = useMemo(() => {
    if (!session || session.progress.totalQuestions === 0) {
      return 0;
    }
    return Math.round((session.progress.answeredQuestions / session.progress.totalQuestions) * 100);
  }, [session]);

  useEffect(() => {
    const tg = getTelegramWebApp();
    if (tg) {
      tg.expand();
      tg.ready();
      tg.enableClosingConfirmation();
    }
  }, []);

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
      throw new Error("Не удалось подключиться к API.");
    }

    const payload = (await response.json()) as ApiResponse<T>;
    if (!response.ok || !payload.ok || !payload.data) {
      throw new Error(payload.error?.message ?? "API request failed");
    }

    return payload.data;
  }

  function resetQuestionView(): void {
    setSession(null);
    setCurrentQuestion(null);
    setSelectedOptionIds([]);
    setQuestionCompleted(false);
    setSingleFinished(false);
    setResultText(null);
    setHint(null);
  }

  async function savePreferences(next: UserPreferences): Promise<void> {
    if (!user) {
      return;
    }

    try {
      const data = await request<{ user: User }>(
        "/auth/preferences",
        {
          method: "PATCH",
          body: JSON.stringify(next),
        },
        user.id,
      );
      setUser(data.user);
    } catch (preferencesError) {
      setError(preferencesError instanceof Error ? preferencesError.message : "Ошибка сохранения");
    }
  }

  async function applyCourse(course: number): Promise<void> {
    setSelectedCourse(course);
    setSelectedFaculty(null);
    setSelectedSubjectId(null);
    resetQuestionView();
    await savePreferences({ course });
  }

  async function applyFaculty(faculty: string): Promise<void> {
    setSelectedFaculty(faculty);
    setSelectedSubjectId(null);
    resetQuestionView();
    await savePreferences({ faculty });
  }

  async function applySubject(subjectId: string): Promise<void> {
    setSelectedSubjectId(subjectId);
    resetQuestionView();
    await savePreferences({ subjectId });
  }

  async function applyMode(mode: SessionMode): Promise<void> {
    setSelectedMode(mode);
    await savePreferences({ mode });
  }

  async function changePlan(planCode: string): Promise<void> {
    if (!user) {
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const data = await request<{ user: User }>(
        "/subscriptions/me/plan",
        {
          method: "PATCH",
          body: JSON.stringify({ planCode }),
        },
        user.id,
      );
      setUser(data.user);
    } catch (planError) {
      setError(planError instanceof Error ? planError.message : "Не удалось сменить тариф");
    } finally {
      setBusy(false);
    }
  }

  async function bootstrap(): Promise<void> {
    setBusy(true);
    setError(null);
    setAccessMessage("");

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
      const subjectsData = await request<{ subjects: Subject[] }>("/tests/subjects");

      const currentPlan = plansData.plans.find((plan) => plan.code === loginData.user.planCode);
      const hasActivePro = loginData.user.planCode !== "free" && Boolean(currentPlan?.isActive);
      if (!hasActivePro) {
        setAccessState("denied");
        setAccessMessage("Веб-приложение доступно только с активной PRO подпиской.");
        return;
      }

      setUser(loginData.user);
      setPlans(plansData.plans.filter((plan) => plan.isActive));
      setSubjects(subjectsData.subjects);
      const fetchedCourses = [...new Set(subjectsData.subjects.map((subject) => subject.course))].sort(
        (a, b) => a - b,
      );

      const preferenceCourse = loginData.user.preferences?.course;
      if (typeof preferenceCourse === "number" && fetchedCourses.includes(preferenceCourse)) {
        setSelectedCourse(preferenceCourse);
      }

      const preferenceFaculty = loginData.user.preferences?.faculty;
      if (
        typeof preferenceFaculty === "string" &&
        typeof preferenceCourse === "number" &&
        subjectsData.subjects.some(
          (subject) => subject.course === preferenceCourse && subject.faculty === preferenceFaculty,
        )
      ) {
        setSelectedFaculty(preferenceFaculty);
      }

      const preferenceSubjectId = loginData.user.preferences?.subjectId;
      if (
        typeof preferenceSubjectId === "string" &&
        typeof preferenceCourse === "number" &&
        typeof preferenceFaculty === "string" &&
        subjectsData.subjects.some(
          (subject) =>
            subject.id === preferenceSubjectId &&
            subject.course === preferenceCourse &&
            subject.faculty === preferenceFaculty,
        )
      ) {
        setSelectedSubjectId(preferenceSubjectId);
      } else if (
        typeof preferenceSubjectId === "string" &&
        typeof preferenceCourse === "number" &&
        typeof preferenceFaculty === "string"
      ) {
        const staleSubject = subjectsData.subjects.find((subject) => subject.id === preferenceSubjectId);
        if (staleSubject) {
          setError(
            formatNoTestsForSelectionError(
              preferenceFaculty,
              preferenceCourse,
              staleSubject.subject,
            ),
          );
        }
      }

      const preferenceMode = loginData.user.preferences?.mode;
      if (preferenceMode === "single" || preferenceMode === "pack" || preferenceMode === "exam-prep") {
        setSelectedMode(preferenceMode);
      }

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
        `${tgUser.first_name ?? ""} ${tgUser.last_name ?? ""}`.trim() || tgUser.username || "Student";
      return {
        telegramId: String(tgUser.id),
        name: fallbackName,
      };
    }

    return null;
  }

  async function startSession(): Promise<void> {
    if (!user) {
      return;
    }
    if (!selectedSubject) {
      if (selectedCourse && selectedFaculty && selectedSubjectId) {
        const staleSubject = subjects.find((subject) => subject.id === selectedSubjectId);
        if (staleSubject) {
          setError(
            formatNoTestsForSelectionError(selectedFaculty, selectedCourse, staleSubject.subject),
          );
        }
      }
      return;
    }

    setBusy(true);
    setError(null);
    setHint(null);
    setResultText(null);

    try {
      const data = await request<{ session: Session; firstQuestion: Question | null }>(
        "/tests/sessions/start",
        {
          method: "POST",
          body: JSON.stringify({
            subjectId: selectedSubject.id,
            mode: selectedMode,
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
      setError(sessionError instanceof Error ? sessionError.message : "Не удалось начать сессию");
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
        setHint(data.isCorrect ? "Верно, продолжайте." : "Неверно, попробуйте еще.");
        return;
      }

      setResultText(
        data.isCorrect ? "Правильно 👏" : `К сожалению ответ неверный 🥲\nВерный вариант: ${data.correctOptionIds.join(", ")}`,
      );

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
      setError(submitError instanceof Error ? submitError.message : "Ошибка отправки ответа");
    } finally {
      setBusy(false);
    }
  }

  async function continueSingleMode(): Promise<void> {
    if (selectedMode !== "single") {
      return;
    }
    await startSession();
  }

  useEffect(() => {
    void bootstrap();
  }, []);

  return (
    <main className="theme dark mx-auto min-h-screen w-full max-w-md bg-[#101827] px-4 pb-8 pt-5 text-slate-50">
      <Card className="relative overflow-visible border-[#30445f] bg-[#1a2739]">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-full bg-[#2a3b52] text-sm font-semibold">
                {user?.name.slice(0, 1).toUpperCase() || "A"}
              </div>
              <div>
                <p className="text-sm font-semibold">{user?.name || "Ampula"}</p>
              </div>
            </div>
            <div className="relative">
              <Button
                size="icon"
                variant="ghost"
                className="size-8 rounded-full text-slate-200 hover:bg-[#2a3c56]"
                onClick={() => setMenuOpen((value) => !value)}
              >
                {menuOpen ? <X size={16} /> : <Menu size={16} />}
              </Button>
              {menuOpen ? (
                <div className="absolute right-0 z-30 mt-2 w-44 rounded-xl border border-[#3a4f6b] bg-[#203148] p-1 shadow-xl">
                  {[
                    { key: "mode", label: "Режим" },
                    { key: "course", label: "Курс" },
                    { key: "faculty", label: "Факультет" },
                    { key: "subject", label: "Предмет" },
                    { key: "plan", label: "Тариф" },
                  ].map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      className="w-full rounded-lg px-3 py-2 text-left text-sm text-slate-100 hover:bg-[#2a3e59]"
                      onClick={() => {
                        setSettingPanel(item.key as SettingPanel);
                        setMenuOpen(false);
                      }}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2 h-8">
            <Badge variant="outline" className="border-sky-400/60 text-sky-200 h-8 w-16">
              {user?.planCode.toUpperCase() ?? "plan"}
            </Badge>
            {selectedCourse ? <Badge className="bg-[#314760] text-slate-100 h-8 w-16">Курс {selectedCourse}</Badge> : null}
          </div>
        </CardHeader>
        {error ? <CardContent className="pt-0 text-xs text-red-300">{error}</CardContent> : null}
      </Card>

      {accessState === "checking" ? (
        <Card className="mt-4 border-[#30445f] bg-[#1a2739]">
          <CardContent className="py-6 text-center text-sm text-slate-300">Проверяем доступ...</CardContent>
        </Card>
      ) : null}

      {accessState === "denied" || accessState === "error" ? (
        <Card className="mt-4 border-[#5d3740] bg-[#2a1f27]">
          <CardContent className="py-6 text-sm text-red-200">{accessMessage}</CardContent>
        </Card>
      ) : null}

      {accessState === "granted" && settingPanel ? (
        <Card className="mt-4 border-[#30445f] bg-[#1a2739]">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Настройки: {settingPanel}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {settingPanel === "mode"
              ? MODE_ITEMS.map((item) => (
                  <Button
                    key={item.mode}
                    variant={selectedMode === item.mode ? "default" : "outline"}
                    className={cn(
                      "w-full justify-between border-[#3a4f69] bg-[#22334a] text-slate-100 hover:bg-[#2b3f59]",
                      selectedMode === item.mode && "border-sky-400/70 bg-sky-400/20",
                    )}
                    onClick={() => void applyMode(item.mode)}
                  >
                    <span>{item.label}</span>
                    <span className="text-xs text-slate-400">{item.subtitle}</span>
                  </Button>
                ))
              : null}

            {settingPanel === "course" ? (
              <div className="grid grid-cols-5 gap-2">
                {availableCourses.map((course) => (
                  <Button
                    key={course}
                    variant={selectedCourse === course ? "default" : "outline"}
                    className={cn(selectedCourse === course && "border-sky-400/70 bg-sky-400/20")}
                    onClick={() => void applyCourse(course)}
                  >
                    {course}
                  </Button>
                ))}
              </div>
            ) : null}

            {settingPanel === "faculty"
              ? faculties.map((faculty) => (
                  <Button
                    key={faculty}
                    variant={selectedFaculty === faculty ? "default" : "outline"}
                    className={cn(
                      "w-full justify-start",
                      selectedFaculty === faculty && "border-sky-400/70 bg-sky-400/20",
                    )}
                    onClick={() => void applyFaculty(faculty)}
                  >
                    {faculty}
                  </Button>
                ))
              : null}

            {settingPanel === "subject"
              ? filteredSubjects.map((subject) => (
                  <Button
                    key={subject.id}
                    variant={selectedSubjectId === subject.id ? "default" : "outline"}
                    className={cn(
                      "h-auto w-full justify-between px-3 py-3",
                      selectedSubjectId === subject.id && "border-sky-400/70 bg-sky-400/20",
                    )}
                    onClick={() => void applySubject(subject.id)}
                  >
                    <span>{subject.subject}</span>
                    <span className="text-xs text-slate-400">{subject.testType === "exam" ? "exam" : "credit"}</span>
                  </Button>
                ))
              : null}

            {settingPanel === "plan"
              ? plans.map((plan) => (
                  <Button
                    key={plan.code}
                    variant={user?.planCode === plan.code ? "default" : "outline"}
                    className={cn(
                      "w-full justify-between",
                      user?.planCode === plan.code && "border-sky-400/70 bg-sky-400/20",
                    )}
                    disabled={busy}
                    onClick={() => void changePlan(plan.code)}
                  >
                    <span>{plan.name}</span>
                    <span className="text-xs text-slate-400">{plan.code}</span>
                  </Button>
                ))
              : null}

            <Button variant="outline" className="w-full" onClick={() => setSettingPanel(null)}>
              Закрыть
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {accessState === "granted" && setupStep !== "ready" ? (
        <Card className="mt-4 border-[#30445f] bg-[#1a2739]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {setupStep === "course"
                ? "Выберите курс"
                : setupStep === "faculty"
                  ? "Выберите факультет"
                  : "Выберите предмет"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {setupStep === "course" ? (
              <div className="grid grid-cols-5 gap-2">
                {availableCourses.map((course) => (
                  <Button
                    key={course}
                    variant={selectedCourse === course ? "default" : "outline"}
                    className={cn(selectedCourse === course && "border-sky-400/70 bg-sky-400/20")}
                    onClick={() => void applyCourse(course)}
                  >
                    {course}
                  </Button>
                ))}
              </div>
            ) : null}

            {setupStep === "faculty"
              ? faculties.map((faculty) => (
                  <Button
                    key={faculty}
                    variant={selectedFaculty === faculty ? "default" : "outline"}
                    className={cn(
                      "w-full justify-start",
                      selectedFaculty === faculty && "border-sky-400/70 bg-sky-400/20",
                    )}
                    onClick={() => void applyFaculty(faculty)}
                  >
                    {faculty}
                  </Button>
                ))
              : null}

            {setupStep === "subject"
              ? filteredSubjects.map((subject) => (
                  <Button
                    key={subject.id}
                    variant={selectedSubjectId === subject.id ? "default" : "outline"}
                    className={cn(
                      "h-auto w-full justify-between px-3 py-3",
                      selectedSubjectId === subject.id && "border-sky-400/70 bg-sky-400/20",
                    )}
                    onClick={() => void applySubject(subject.id)}
                  >
                    <span>{subject.subject}</span>
                    <span className="text-xs text-slate-400">{subject.testType === "exam" ? "exam" : "credit"}</span>
                  </Button>
                ))
              : null}
          </CardContent>
        </Card>
      ) : null}

      {accessState === "granted" && setupStep === "ready" && !session ? (
        <Card className="mt-4 border-[#30445f] bg-[#1a2739]">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{selectedSubject?.subject}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-slate-200">Выберите режим тренировки тестов</p>
            <div className="grid grid-cols-3 gap-2">
              {MODE_ITEMS.map((item) => (
                <Button
                  key={item.mode}
                  variant={selectedMode === item.mode ? "default" : "outline"}
                  className={cn(
                    "h-auto flex-col gap-1 px-2 py-3",
                    selectedMode === item.mode && "border-sky-400/70 bg-sky-400/20",
                  )}
                  onClick={() => void applyMode(item.mode)}
                >
                  <span>{item.label}</span>
                  <span className="text-[11px] text-slate-400">{item.subtitle}</span>
                </Button>
              ))}
            </div>

            <Button
              className="h-12 w-full bg-[#4f9fff] text-base text-white hover:bg-[#3f8feb]"
              onClick={() => void startSession()}
              disabled={busy}
            >
              Начать
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {session && currentQuestion ? (
        <Card className="mt-4 border-[#30445f] bg-[#1a2739]">
          <CardHeader className="space-y-2 pb-2">
            <CardTitle className="text-base">{selectedSubject?.subject}</CardTitle>
            <p className="text-xs text-slate-400">
              {session.progress.answeredQuestions + 1}/{session.progress.totalQuestions} · Ошибок {session.errors.length}
            </p>
            <Progress value={progressValue} className="h-2" />
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm leading-6">{currentQuestion.title}</p>
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
                      isCorrectMark && "border-emerald-300 bg-emerald-300/35 text-emerald-50",
                      isWrongMark && "border-rose-300 bg-rose-300/35 text-rose-50",
                    )}
                    onClick={() => void submitAnswer(option.optionId)}
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
                <Button variant="default" className="w-full h-10 bg-[#4f9fff] text-white hover:bg-[#3f8feb]" onClick={() => void continueSingleMode()} disabled={busy}>
                  Еще вопрос
                </Button>
                <Button
                  className="w-full h-10"
                  variant="outline"
                  onClick={() => {
                    resetQuestionView();
                    setSettingPanel(null);
                  }}
                >
                  Закрыть
                </Button>
              </div>
            ) : null}

            {!singleFinished && session.status !== "active" ? (
              <div className="space-y-2">
                <p className="text-sm text-slate-200">
                  Сессия завершена 🏁<br />
                  Правильных ответов: 🎯 {session.progress.correctAnswers}/
                  {session.progress.answeredQuestions}<br />
                  Ошибок: 🥲 {session.errors.length}
                </p>
                <Button variant="default" className="w-full h-10 bg-[#4f9fff] text-white hover:bg-[#3f8feb]" onClick={resetQuestionView}>
                  Закрыть результат
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

function formatNoTestsForSelectionError(
  facultyName: string,
  courseNumber: number,
  subjectName: string,
): string {
  return `Для факультета ${facultyName} по курсу ${courseNumber} для предмета ${subjectName} на данный момент тестов нет.`;
}
