type Clock = () => number;

export type RateLimitDecision = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAfterSeconds: number;
  retryAfterSeconds: number;
};

type Bucket = {
  count: number;
  resetAt: number;
};

type LimiterOptions = {
  limit: number;
  windowMs: number;
  maxKeys: number;
  now?: Clock;
};

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

/**
 * Best-effort warm-instance limiter. It bounds memory and upstream amplification inside each
 * function instance; a platform firewall remains the right global layer when one is configured.
 */
export class FixedWindowLimiter {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxKeys: number;
  private readonly now: Clock;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: LimiterOptions) {
    this.limit = positiveInteger(options.limit, "limit");
    this.windowMs = positiveInteger(options.windowMs, "windowMs");
    this.maxKeys = positiveInteger(options.maxKeys, "maxKeys");
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.buckets.size;
  }

  consume(rawKey: string): RateLimitDecision {
    const now = this.now();
    this.sweepExpired(now);
    const key = rawKey.slice(0, 128) || "unknown";
    let bucket = this.buckets.get(key);

    if (!bucket) {
      this.makeRoom();
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    } else {
      this.buckets.delete(key);
      this.buckets.set(key, bucket);
    }

    const allowed = bucket.count < this.limit;
    if (allowed) bucket.count += 1;
    const resetAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000));
    return {
      allowed,
      limit: this.limit,
      remaining: Math.max(0, this.limit - bucket.count),
      resetAfterSeconds,
      retryAfterSeconds: resetAfterSeconds,
    };
  }

  private sweepExpired(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  private makeRoom(): void {
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value as string | undefined;
      if (oldest === undefined) return;
      this.buckets.delete(oldest);
    }
  }
}

export function clientIp(headers: Headers): string {
  const first = (headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  return first.length > 0 && first.length <= 64 && /^[0-9a-f:.]+$/i.test(first) ? first : "unknown";
}

export function rateLimitHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    "RateLimit-Limit": String(decision.limit),
    "RateLimit-Remaining": String(decision.remaining),
    "RateLimit-Reset": String(decision.resetAfterSeconds),
  };
  if (!decision.allowed) headers["Retry-After"] = String(decision.retryAfterSeconds);
  return headers;
}

export function privateNoStoreHeaders(): Record<string, string> {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    "CDN-Cache-Control": "no-store",
    "Vercel-CDN-Cache-Control": "no-store",
  };
}
