import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard prototype persistence port.
 *
 * The kernel does not care where its objects live, but it must never be able to
 * pretend they survive when they do not. Every adapter therefore declares its
 * own durability, and the runtime refuses state-changing calls when the declared
 * durability is weaker than the deployment requires. That refusal is the point
 * of this file: an ephemeral store is legitimate for a local demo and is a
 * correctness bug in a multi-instance deployment, and only the adapter itself
 * can honestly say which one it is.
 *
 * The port is asynchronous because a store that is safe for concurrent writers
 * lives across a network, and a synchronous `Map`-shaped surface can never
 * reach one. That was not a style choice — the previous surface made a
 * multi-writer adapter unrepresentable, which is why a multi-instance
 * deployment had to refuse every state change outright.
 */
export type GuardStoreDurability =
  /** Per-process memory. Lost on cold start; never shared between instances. */
  | "EPHEMERAL_SINGLE_INSTANCE"
  /** Survives cold start on one writer. Not safe for concurrent instances. */
  | "DURABLE_SINGLE_WRITER"
  /** Survives cold start and concurrent writers. */
  | "DURABLE_MULTI_WRITER";

export const GUARD_COLLECTIONS = [
  "intents",
  "evaluations",
  "authorizations",
  "executions",
  "receipts",
  "idempotency",
  "transactionIndex",
] as const;

export type GuardCollectionName = (typeof GUARD_COLLECTIONS)[number];

/**
 * Deliberately the smallest surface the kernel actually uses.
 *
 * `insertIfAbsent` is the one operation that cannot be composed from the
 * others. Read-then-write is a race: two instances both see a free idempotency
 * key, a free intent id or an unrecorded transaction hash, and both write. On a
 * single writer that window does not exist, which is exactly why the shape has
 * to carry the guarantee rather than the caller — the caller cannot tell which
 * adapter it is talking to.
 */
export type GuardCollection<T> = {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  /**
   * Atomically claim a key. Resolves `true` when this caller stored the value
   * and `false` when the key already existed — never overwriting the winner.
   */
  insertIfAbsent(key: string, value: T): Promise<boolean>;
  /**
   * Remove a key. Used to release a claim whose operation failed — a burnt
   * idempotency key would make a corrected retry impossible forever.
   */
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  /**
   * Every stored value whose key starts with `keyPrefix`.
   *
   * Keys are `${tenantId}:${objectId}`, so the prefix is what keeps a tenant
   * scan from reading another tenant's rows — on a shared table that is a
   * tenancy boundary, not an optimization.
   */
  valuesWithPrefix(keyPrefix: string): Promise<readonly T[]>;
};

export type GuardStore = {
  readonly durability: GuardStoreDurability;
  /** Human-readable adapter identity for `/health`, status limitations and docs. */
  readonly description: string;
  collection<T>(name: GuardCollectionName): GuardCollection<T>;
  /** Release adapter resources. Adapters that hold none resolve immediately. */
  close?(): Promise<void>;
};

export function storeSurvivesColdStart(store: GuardStore): boolean {
  return store.durability !== "EPHEMERAL_SINGLE_INSTANCE";
}

export function storeSupportsConcurrentInstances(store: GuardStore): boolean {
  return store.durability === "DURABLE_MULTI_WRITER";
}

/** The exact limitation strings the API reports for a given adapter. */
export function guardStoreLimitations(store: GuardStore): readonly string[] {
  if (!storeSurvivesColdStart(store)) return ["EPHEMERAL_SINGLE_INSTANCE_STORE"];
  if (!storeSupportsConcurrentInstances(store)) return ["DURABLE_SINGLE_WRITER_STORE"];
  return ["DURABLE_MULTI_WRITER_STORE"];
}

export function createMemoryGuardStore(): GuardStore {
  const maps = new Map<GuardCollectionName, Map<string, unknown>>();

  function mapFor(name: GuardCollectionName): Map<string, unknown> {
    let map = maps.get(name);
    if (!map) {
      map = new Map<string, unknown>();
      maps.set(name, map);
    }
    return map;
  }

  return {
    durability: "EPHEMERAL_SINGLE_INSTANCE",
    description: "in-process memory (demo only; lost on cold start)",
    collection<T>(name: GuardCollectionName): GuardCollection<T> {
      return {
        async get(key) {
          return mapFor(name).get(key) as T | undefined;
        },
        async set(key, value) {
          mapFor(name).set(key, value);
        },
        async insertIfAbsent(key, value) {
          /* A single JavaScript process runs this to completion with no await
             in between, so the check and the write cannot interleave. */
          const map = mapFor(name);
          if (map.has(key)) return false;
          map.set(key, value);
          return true;
        },
        async delete(key) {
          mapFor(name).delete(key);
        },
        async has(key) {
          return mapFor(name).has(key);
        },
        async valuesWithPrefix(keyPrefix) {
          const out: T[] = [];
          for (const [key, value] of mapFor(name)) {
            if (key.startsWith(keyPrefix)) out.push(value as T);
          }
          return out;
        },
      };
    },
  };
}

function readCollectionFile(file: string): Map<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed as Record<string, unknown>));
  } catch {
    // A missing file is the normal empty state. A corrupt file is treated the
    // same way on purpose: the kernel then reports the lifecycle as absent
    // rather than resuming from half-written objects it cannot verify.
    return new Map();
  }
}

function writeCollectionFile(directory: string, file: string, map: Map<string, unknown>): void {
  /* The directory is created at construction, but a long-lived process can
     outlive it: a cleanup, a container restart with an unmounted volume, or an
     operator clearing state by hand. Without this, every later write throws
     ENOENT and the lifecycle fails permanently behind a generic 503 with no
     hint of the cause. Re-asserting the directory is cheap and idempotent. */
  mkdirSync(directory, { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(Object.fromEntries(map), null, 0), "utf8");
  renameSync(temporary, file);
}

/**
 * JSON-file adapter for a local or single-writer deployment.
 *
 * Every write is a whole-collection atomic replace (temp file + rename), which
 * is correct at prototype volume and keeps a torn file from ever being read.
 * It is explicitly NOT multi-writer safe: two instances writing the same
 * directory would clobber each other, which is why it declares
 * `DURABLE_SINGLE_WRITER` and the runtime blocks it on multi-instance targets.
 */
export function createFileGuardStore(options: { directory: string }): GuardStore {
  mkdirSync(options.directory, { recursive: true });
  const loaded = new Map<GuardCollectionName, Map<string, unknown>>();

  function snapshot(name: GuardCollectionName): Map<string, unknown> {
    let map = loaded.get(name);
    if (!map) {
      map = readCollectionFile(join(options.directory, `${name}.json`));
      loaded.set(name, map);
    }
    return map;
  }

  return {
    durability: "DURABLE_SINGLE_WRITER",
    description: `JSON files under ${options.directory} (single writer)`,
    collection<T>(name: GuardCollectionName): GuardCollection<T> {
      const file = join(options.directory, `${name}.json`);
      return {
        async get(key) {
          return snapshot(name).get(key) as T | undefined;
        },
        async set(key, value) {
          const map = snapshot(name);
          map.set(key, value);
          writeCollectionFile(options.directory, file, map);
        },
        async insertIfAbsent(key, value) {
          /* Atomic against this process only, which is precisely what
             DURABLE_SINGLE_WRITER promises and no more. */
          const map = snapshot(name);
          if (map.has(key)) return false;
          map.set(key, value);
          writeCollectionFile(options.directory, file, map);
          return true;
        },
        async delete(key) {
          const map = snapshot(name);
          if (!map.delete(key)) return;
          writeCollectionFile(options.directory, file, map);
        },
        async has(key) {
          return snapshot(name).has(key);
        },
        async valuesWithPrefix(keyPrefix) {
          const out: T[] = [];
          for (const [entryKey, value] of snapshot(name)) {
            if (entryKey.startsWith(keyPrefix)) out.push(value as T);
          }
          return out;
        },
      };
    },
  };
}
