import type {
  AbandonSessionResponse,
  ApiResponse,
  AuthLoginResponse,
  GetActiveSessionResponse,
  GetSessionResponse,
  IntervalPackSize,
  ListBroadcastTelegramIdsResponse,
  ListQuestionIdsResponse,
  ListPlansResponse,
  ListSubjectsResponse,
  SessionMode,
  StartSessionResponse,
  SubmitAnswerResponse,
  UpdatePreferencesResponse,
  User,
} from "../shared/index.js";

export class BotApiClient {
  public constructor(private readonly baseUrl: string) {}

  public async login(telegramId: string, name: string): Promise<User> {
    const data = await this.request<AuthLoginResponse>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ telegramId, name }),
    });

    return data.user;
  }

  public async listSubjects(): Promise<ListSubjectsResponse["subjects"]> {
    const data = await this.request<ListSubjectsResponse>("/tests/subjects");
    return data.subjects;
  }

  public async startSession(input: {
    userId: string;
    subjectId: string;
    mode: SessionMode;
    intervalConfig?: {
      packSize: IntervalPackSize;
      startQuestionId: number;
      endQuestionId: number;
    };
  }): Promise<StartSessionResponse> {
    return this.request<StartSessionResponse>("/tests/sessions/start", {
      method: "POST",
      headers: {
        "x-user-id": input.userId,
      },
      body: JSON.stringify({
        subjectId: input.subjectId,
        mode: input.mode,
        ...(input.intervalConfig ? { intervalConfig: input.intervalConfig } : {}),
      }),
    });
  }

  public async listQuestionIds(input: {
    subjectId: string;
  }): Promise<ListQuestionIdsResponse> {
    const search = new URLSearchParams({ subjectId: input.subjectId });
    return this.request<ListQuestionIdsResponse>(`/tests/questions/ids?${search.toString()}`);
  }

  public async getActiveSession(input: {
    userId: string;
    subjectId?: string;
    mode?: SessionMode;
  }): Promise<GetActiveSessionResponse> {
    const search = new URLSearchParams();
    if (input.subjectId) {
      search.set("subjectId", input.subjectId);
    }
    if (input.mode) {
      search.set("mode", input.mode);
    }
    return this.request<GetActiveSessionResponse>(`/tests/sessions/active?${search.toString()}`, {
      headers: {
        "x-user-id": input.userId,
      },
    });
  }

  public async getSessionState(input: {
    userId: string;
    sessionId: string;
  }): Promise<GetSessionResponse> {
    return this.request<GetSessionResponse>(`/tests/sessions/${encodeURIComponent(input.sessionId)}`, {
      headers: {
        "x-user-id": input.userId,
      },
    });
  }

  public async submitAnswer(input: {
    userId: string;
    sessionId: string;
    questionId: number;
    selectedOptionId: number;
  }): Promise<SubmitAnswerResponse> {
    return this.request<SubmitAnswerResponse>("/tests/sessions/answer", {
      method: "POST",
      headers: {
        "x-user-id": input.userId,
      },
      body: JSON.stringify({
        sessionId: input.sessionId,
        questionId: input.questionId,
        selectedOptionId: input.selectedOptionId,
      }),
    });
  }

  public async abandonSession(input: {
    userId: string;
    sessionId: string;
  }): Promise<AbandonSessionResponse> {
    return this.request<AbandonSessionResponse>("/tests/sessions/abandon", {
      method: "POST",
      headers: {
        "x-user-id": input.userId,
      },
      body: JSON.stringify({
        sessionId: input.sessionId,
      }),
    });
  }

  public async listPlans(): Promise<ListPlansResponse["plans"]> {
    const data = await this.request<ListPlansResponse>("/subscriptions/plans");
    return data.plans;
  }

  public async changeMyPlan(userId: string, planCode: string): Promise<User> {
    const data = await this.request<{ user: User }>("/subscriptions/me/plan", {
      method: "PATCH",
      headers: {
        "x-user-id": userId,
      },
      body: JSON.stringify({ planCode }),
    });

    return data.user;
  }

  public async updatePreferences(
    userId: string,
    preferences: { mode?: SessionMode; course?: number; faculty?: string; subjectId?: string },
  ): Promise<User> {
    const data = await this.request<UpdatePreferencesResponse>("/auth/preferences", {
      method: "PATCH",
      headers: {
        "x-user-id": userId,
      },
      body: JSON.stringify(preferences),
    });

    return data.user;
  }

  public async listBroadcastTelegramIds(adminTelegramId: string): Promise<string[]> {
    const data = await this.request<ListBroadcastTelegramIdsResponse>("/auth/admin/broadcast/telegram-ids", {
      headers: {
        "x-user-role": "admin",
        "x-admin-telegram-id": adminTelegramId,
      },
    });

    return data.telegramIds;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

    const payload = (await response.json()) as ApiResponse<T>;
    if (!response.ok || !payload.ok || !payload.data) {
      const message = payload.error?.message ?? "Ошибка API запроса";
      throw new Error(message);
    }

    return payload.data;
  }
}
