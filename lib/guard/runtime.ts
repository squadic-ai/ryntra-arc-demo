import { randomUUID } from "node:crypto";

import { FixedWindowLimiter } from "../http-control.ts";
import { createGuardService } from "./service.ts";
import { createPostgresGuardStore } from "./store-postgres.ts";
import {
  createFileGuardStore,
  createMemoryGuardStore,
  storeSupportsConcurrentInstances,
  storeSurvivesColdStart,
  type GuardStore,
} from "./store.ts";

export type GuardDeploymentShape = "SINGLE_INSTANCE" | "MULTI_INSTANCE";

export type GuardWriteGate =
  | { allowed: true }
  | { allowed: false; reason: string; requiredAction: string };

type GuardRuntime = {
  service: ReturnType<typeof createGuardService>;
  limiter: FixedWindowLimiter;
  store: GuardStore;
  deployment: GuardDeploymentShape;
  writes: GuardWriteGate;
};

const globalRuntime = globalThis as typeof globalThis & {
  __ryntraGuardPrototypeRuntime?: GuardRuntime;
};

type GuardEnv = Record<string, string | undefined>;

/**
 * How many instances may serve this process's traffic.
 *
 * Defaults are chosen so the unsafe combination is never the silent one: a
 * managed serverless platform is assumed multi-instance unless the operator
 * says otherwise, and a local process is assumed single-instance.
 */
export function resolveGuardDeployment(env: GuardEnv): GuardDeploymentShape {
  const declared = env.RYNTRA_GUARD_DEPLOYMENT?.trim().toLowerCase();
  if (declared === "multi-instance") return "MULTI_INSTANCE";
  if (declared === "single-instance") return "SINGLE_INSTANCE";
  return env.VERCEL ? "MULTI_INSTANCE" : "SINGLE_INSTANCE";
}

export function resolveGuardStore(env: GuardEnv): GuardStore {
  const kind = env.RYNTRA_GUARD_STORE?.trim().toLowerCase();
  if (kind === "postgres") {
    const connectionString = env.DATABASE_URL?.trim() || env.POSTGRES_URL?.trim();
    if (!connectionString) {
      throw new Error(
        "RYNTRA_GUARD_STORE=postgres requires DATABASE_URL. Refusing to fall back to a weaker store.",
      );
    }
    return createPostgresGuardStore({ connectionString });
  }
  if (kind === "file") {
    const directory = env.RYNTRA_GUARD_STORE_DIR?.trim();
    if (!directory) {
      throw new Error(
        "RYNTRA_GUARD_STORE=file requires RYNTRA_GUARD_STORE_DIR. Refusing to fall back to memory.",
      );
    }
    return createFileGuardStore({ directory });
  }
  return createMemoryGuardStore();
}

/**
 * Fail-closed durability gate.
 *
 * A store that cannot outlive one instance is a legitimate local demo and a
 * correctness bug behind several instances: a caller would create an intent on
 * one instance and be told it never existed on the next. Rather than degrade
 * quietly, state-changing requests are refused with a structured error naming
 * the exact configuration that is missing.
 */
export function resolveGuardWriteGate(
  store: GuardStore,
  deployment: GuardDeploymentShape,
): GuardWriteGate {
  if (deployment === "SINGLE_INSTANCE") return { allowed: true };
  if (storeSupportsConcurrentInstances(store)) return { allowed: true };
  return {
    allowed: false,
    reason: storeSurvivesColdStart(store)
      ? "The configured Guard store is durable for a single writer only and cannot back a multi-instance deployment."
      : "The configured Guard store is per-process memory and cannot back a multi-instance deployment.",
    requiredAction: "CONFIGURE_DURABLE_MULTI_WRITER_GUARD_STORE",
  };
}

function createRuntime(env: GuardEnv): GuardRuntime {
  const store = resolveGuardStore(env);
  const deployment = resolveGuardDeployment(env);
  return {
    service: createGuardService({
      now: () => new Date().toISOString(),
      createId: (prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`,
      store,
    }),
    limiter: new FixedWindowLimiter({ limit: 120, windowMs: 60_000, maxKeys: 5_000 }),
    store,
    deployment,
    writes: resolveGuardWriteGate(store, deployment),
  };
}

/**
 * Process-wide Guard runtime. The state itself lives in the configured store,
 * not here; this cache only avoids rebuilding the adapter and rate limiter on
 * every request within one warm instance.
 */
export function getGuardRuntime(): GuardRuntime {
  globalRuntime.__ryntraGuardPrototypeRuntime ??= createRuntime(process.env);
  return globalRuntime.__ryntraGuardPrototypeRuntime;
}
