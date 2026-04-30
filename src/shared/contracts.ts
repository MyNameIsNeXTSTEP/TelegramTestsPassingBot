export type UserRole = "student" | "admin";

export type PlanCode = "free" | "pro-student";

export type TestType = "exam" | "credit";

export type SessionMode = "single" | "pack" | "exam-prep";

export type SessionStatus = "active" | "passed" | "failed" | "abandoned";

export interface DailyUsage {
  dateIso: string;
  sessionsStarted: number;
  questionsAnswered: number;
}

export interface PlanLimits {
  dailySessionsLimit: number | null;
  maxErrorsInExamPrep: number;
  examPrepPenaltyQuestions: number;
}

export interface SubscriptionPlan {
  code: PlanCode | string;
  name: string;
  description: string;
  price: number;
  currency: string;
  isActive: boolean;
  limits: PlanLimits;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface User {
  id: string;
  telegramId: string;
  name: string;
  role: UserRole;
  planCode: PlanCode | string;
  dailyUsage: DailyUsage;
  createdAtIso: string;
  updatedAtIso: string;
}

export interface Subject {
  id: string;
  faculty: string;
  subject: string;
  testType: TestType;
  sourceFile: string;
}

export interface QuestionOption {
  optionId: number;
  text: string;
  isCorrect: boolean;
}

export interface Question {
  id: number;
  title: string;
  options: QuestionOption[];
}

export interface SessionProgress {
  totalQuestions: number;
  currentQuestionIndex: number;
  answeredQuestions: number;
  correctAnswers: number;
}

export interface SessionError {
  questionId: number;
  selectedOptionId: number;
  correctOptionId: number;
  createdAtIso: string;
}

export interface Session {
  id: string;
  userId: string;
  subjectId: string;
  mode: SessionMode;
  status: SessionStatus;
  questionIds: number[];
  progress: SessionProgress;
  errors: SessionError[];
  currentQuestionSelectedOptionIds?: number[];
  currentQuestionHadWrongAttempt?: boolean;
  maxAllowedErrors: number;
  startedAtIso: string;
  updatedAtIso: string;
  completedAtIso?: string;
}

export interface AnswerEvent {
  id: string;
  userId: string;
  sessionId: string;
  subjectId: string;
  questionId: number;
  selectedOptionId: number;
  isCorrect: boolean;
  answeredAtIso: string;
}

export interface UserDailyStatistics {
  userId: string;
  dateIso: string;
  attempts: number;
  answeredQuestions: number;
  correctAnswers: number;
  accuracyRate: number;
}

export interface SubjectWeakArea {
  subjectId: string;
  subjectName: string;
  answeredQuestions: number;
  incorrectAnswers: number;
  errorRate: number;
}

export interface ModeStatistics {
  mode: SessionMode;
  sessions: number;
  passed: number;
  failed: number;
  averageAccuracyRate: number;
}

export interface UserStatisticsSnapshot {
  userId: string;
  fromDateIso: string;
  toDateIso: string;
  daily: UserDailyStatistics[];
  weakAreas: SubjectWeakArea[];
  modes: ModeStatistics[];
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: ApiError;
}

export interface AuthLoginRequest {
  telegramId: string;
  name: string;
}

export interface AuthLoginResponse {
  user: User;
}

export interface ListSubjectsQuery {
  faculty?: string;
  testType?: TestType;
}

export interface ListSubjectsResponse {
  subjects: Subject[];
}

export interface ListQuestionsQuery {
  subjectId: string;
  limit?: number;
  offset?: number;
}

export interface ListQuestionsResponse {
  subjectId: string;
  total: number;
  questions: Question[];
}

export interface StartSessionRequest {
  subjectId: string;
  mode: SessionMode;
}

export interface StartSessionResponse {
  session: Session;
  firstQuestion: Question | null;
}

export interface SubmitAnswerRequest {
  sessionId: string;
  questionId: number;
  selectedOptionId: number;
}

export interface SubmitAnswerResponse {
  session: Session;
  question: Question;
  isCorrect: boolean;
  correctOptionIds: number[];
  selectedOptionIds: number[];
  questionCompleted: boolean;
  currentQuestion: Question | null;
  nextQuestion: Question | null;
}

export interface GetSessionResponse {
  session: Session;
  currentQuestion: Question | null;
}

export interface UpsertQuestionRequest {
  subjectId: string;
  question: Question;
}

export interface DeleteQuestionRequest {
  subjectId: string;
  questionId: number;
}

export interface GetDailyStatisticsQuery {
  userId: string;
  dateIso?: string;
}

export interface GetDailyStatisticsResponse {
  stats: UserDailyStatistics;
}

export interface GetWeakAreasQuery {
  userId: string;
  fromDateIso?: string;
  toDateIso?: string;
}

export interface GetWeakAreasResponse {
  weakAreas: SubjectWeakArea[];
}

export interface GetModeStatisticsQuery {
  userId: string;
  fromDateIso?: string;
  toDateIso?: string;
}

export interface GetModeStatisticsResponse {
  modes: ModeStatistics[];
}

export interface ListPlansResponse {
  plans: SubscriptionPlan[];
}

export interface UpsertPlanRequest {
  plan: SubscriptionPlan;
}

export interface ChangeUserPlanRequest {
  userId: string;
  planCode: string;
}

export const SESSION_RULES = {
  packQuestions: 10,
  examPrepQuestions: 30,
  examPrepMaxErrors: 3,
  examPrepPenaltyQuestions: 3,
} as const;
