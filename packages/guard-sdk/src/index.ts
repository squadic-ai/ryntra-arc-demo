export type RyntraGuardRequestOptions = {
  idempotencyKey?: string;
  correlationId?: string;
  signal?: AbortSignal;
};

export type RyntraGuardClientOptions = {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  createCorrelationId?: () => string;
};

type GuardErrorBody = {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    requiredAction?: string | null;
    correlationId?: string;
  };
};

export class RyntraGuardApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly requiredAction: string | null;
  readonly correlationId: string | null;

  constructor(
    message: string,
    options: {
      code: string;
      status: number;
      retryable?: boolean;
      requiredAction?: string | null;
      correlationId?: string | null;
    },
  ) {
    super(message);
    this.name = "RyntraGuardApiError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable ?? false;
    this.requiredAction = options.requiredAction ?? null;
    this.correlationId = options.correlationId ?? null;
  }
}

function defaultCorrelationId(): string {
  return `corr_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
}

function identifier(value: string): string {
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(value)) throw new TypeError("Invalid Guard identifier.");
  return encodeURIComponent(value);
}

export class RyntraGuardClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly createCorrelationId: () => string;

  constructor(options: RyntraGuardClientOptions) {
    const parsed = new URL(options.baseUrl);
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new TypeError("Guard baseUrl must use HTTPS outside localhost.");
    }
    this.baseUrl = parsed.toString().replace(/\/$/, "");
    this.apiKey = options.apiKey;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.createCorrelationId = options.createCorrelationId ?? defaultCorrelationId;
  }

  private async request<T>(
    path: string,
    init: { method?: "GET" | "POST"; body?: unknown; options?: RyntraGuardRequestOptions } = {},
  ): Promise<T> {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-correlation-id": init.options?.correlationId ?? this.createCorrelationId(),
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (method === "POST") {
      headers["content-type"] = "application/json";
      if (!init.options?.idempotencyKey) {
        throw new TypeError("A state-changing Guard request requires idempotencyKey.");
      }
      headers["idempotency-key"] = init.options.idempotencyKey;
    }
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.options?.signal,
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const error = (payload ?? {}) as GuardErrorBody;
      throw new RyntraGuardApiError(
        error.error?.message ?? "Ryntra Guard request failed.",
        {
          code: error.error?.code ?? "UNKNOWN_API_ERROR",
          status: response.status,
          retryable: error.error?.retryable,
          requiredAction: error.error?.requiredAction,
          correlationId:
            error.error?.correlationId ?? response.headers.get("x-correlation-id"),
        },
      );
    }
    if (!payload || typeof payload !== "object" || !("data" in payload)) {
      throw new RyntraGuardApiError("Ryntra Guard returned an invalid response envelope.", {
        code: "INVALID_RESPONSE",
        status: response.status,
        correlationId: response.headers.get("x-correlation-id"),
      });
    }
    return (payload as { data: T }).data;
  }

  readonly intents = {
    create: <T = Record<string, unknown>>(
      input: unknown,
      options: RyntraGuardRequestOptions,
    ) => this.request<T>("/v1/intents", { method: "POST", body: input, options }),
    get: <T = Record<string, unknown>>(intentId: string, options?: RyntraGuardRequestOptions) =>
      this.request<T>(`/v1/intents/${identifier(intentId)}`, { options }),
  };

  readonly preflight = <T = Record<string, unknown>>(
    intentId: string,
    input: { evidence: unknown[] },
    options: RyntraGuardRequestOptions,
  ) =>
    this.request<T>(`/v1/intents/${identifier(intentId)}/preflight`, {
      method: "POST",
      body: input,
      options,
    });

  readonly evaluations = {
    get: <T = Record<string, unknown>>(
      evaluationId: string,
      options?: RyntraGuardRequestOptions,
    ) => this.request<T>(`/v1/evaluations/${identifier(evaluationId)}`, { options }),
  };

  readonly authorize = <T = Record<string, unknown>>(
    input: {
      intentId: string;
      evaluationId: string;
      fingerprint: unknown;
      subjectRef: string;
      method: "PARTNER_AUTHENTICATED" | "EIP712";
    },
    options: RyntraGuardRequestOptions,
  ) => {
    const { intentId, ...body } = input;
    return this.request<T>(`/v1/intents/${identifier(intentId)}/authorize`, {
      method: "POST",
      body,
      options,
    });
  };

  readonly executions = {
    record: <T = Record<string, unknown>>(
      input: {
        intentId: string;
        authorizationId: string;
        fingerprint: unknown;
        transactionHash: string;
      },
      options: RyntraGuardRequestOptions,
    ) => {
      const { intentId, ...record } = input;
      return this.request<T>(`/v1/intents/${identifier(intentId)}/executions`, {
        method: "POST",
        body: { operation: "RECORD", ...record },
        options,
      });
    },
    reconcile: <T = Record<string, unknown>>(
      input: {
        intentId: string;
        transactionHash: string;
        observedState: "RPC_UNCERTAIN_AFTER_BROADCAST" | "CONFIRMED";
        actualOutcome?: {
          amountIn: string;
          amountOut: string;
          feeAmount: string;
          explorerUrl: string;
        };
      },
      options: RyntraGuardRequestOptions,
    ) => {
      const { intentId, ...reconciliation } = input;
      return this.request<T>(`/v1/intents/${identifier(intentId)}/executions`, {
        method: "POST",
        body: { operation: "RECONCILE", ...reconciliation },
        options,
      });
    },
  };

  readonly status = {
    getByIntent: <T = Record<string, unknown>>(
      intentId: string,
      options?: RyntraGuardRequestOptions,
    ) => this.request<T>(`/v1/intents/${identifier(intentId)}/status`, { options }),
  };

  readonly receipts = {
    getByIntent: <T = Record<string, unknown>>(
      intentId: string,
      options?: RyntraGuardRequestOptions,
    ) => this.request<T>(`/v1/intents/${identifier(intentId)}/receipt`, { options }),
  };

  readonly capabilities = {
    list: <T = Record<string, unknown>>(options?: RyntraGuardRequestOptions) =>
      this.request<T>("/v1/capabilities", { options }),
  };
}
