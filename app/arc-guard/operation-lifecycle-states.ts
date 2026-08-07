/**
 * The six states of one operation, and the rules that derive them.
 *
 * Pure and rendering-free on purpose. These rules decide whether a screen tells
 * an operator that money moved, so they are worth testing directly rather than
 * through a component — and a rule that can only be exercised by rendering
 * tends not to be exercised at all.
 *
 * The separation they exist to enforce: Ryntra recording that a human approved
 * an exact intent is an application event. A wallet signature is a
 * cryptographic act by the key holder, which Ryntra cannot perform, cannot
 * forge and does not witness. These used to render as one line —
 * `HUMAN AUTHORIZED · PARTNER_AUTHENTICATED` — which invites a reader to
 * believe the application authorized the money movement. It authorized nothing
 * but its own record of a decision.
 */

export type LifecycleStage =
  | "RYNTRA_AUTHORIZATION"
  | "WALLET_SIGNATURE"
  | "BROADCAST"
  | "ARC_CONFIRMATION"
  | "RECONCILIATION"
  | "RECEIPT";

export type StageState = "PENDING" | "ACTIVE" | "DONE" | "BLOCKED" | "FAILED";

export type LifecycleInput = {
  /** Ryntra recorded a human decision against an exact fingerprint. */
  authorized: boolean;
  /** A real transaction hash exists, which proves signature and broadcast. */
  transactionHash: string | null;
  /** Arc reported the transaction as included and successful. */
  confirmed: boolean;
  /** Result of comparing the authorized expectation against observed effect. */
  reconciliation: string | null;
  /** A finalized, hash-bound receipt exists. */
  finalized: boolean;
  /** Something failed and the operator has to act. */
  failure?: { stage: LifecycleStage; message: string } | null;
  /** A step is running right now. */
  busy?: LifecycleStage | null;
};

export const LIFECYCLE_ORDER: readonly LifecycleStage[] = [
  "RYNTRA_AUTHORIZATION",
  "WALLET_SIGNATURE",
  "BROADCAST",
  "ARC_CONFIRMATION",
  "RECONCILIATION",
  "RECEIPT",
];

export const LIFECYCLE_LABELS: Record<LifecycleStage, { title: string; detail: string }> = {
  RYNTRA_AUTHORIZATION: {
    title: "Ryntra authorization",
    detail:
      "A human approved this exact intent. Ryntra records the decision and binds it to the fingerprint — it does not move money.",
  },
  WALLET_SIGNATURE: {
    title: "Wallet signature",
    detail:
      "The key holder signs, in their own wallet. Ryntra never holds the key and cannot perform this step.",
  },
  BROADCAST: {
    title: "Broadcast",
    detail:
      "The signed transaction reaches the network. With eth_sendTransaction the wallet signs and broadcasts in one call, so this deployment observes both through the returned hash rather than separately.",
  },
  ARC_CONFIRMATION: {
    title: "Arc confirmation",
    detail:
      "Arc includes the transaction. Finality is deterministic: one confirmation is final, so there is no countdown.",
  },
  RECONCILIATION: {
    title: "Reconciliation",
    detail:
      "Actual effects, read from the chain, compared against what was authorized. A deviation is recorded, never hidden.",
  },
  RECEIPT: {
    title: "Receipt",
    detail:
      "Finalized and hash-bound. It cannot exist before settlement is confirmed and reconciled — that is the whole point of it.",
  },
};

export function lifecycleStates(input: LifecycleInput): Record<LifecycleStage, StageState> {
  /* A hash is the evidence that both the signature and the broadcast happened.
     eth_sendTransaction performs them in one call and returns it, so marking
     broadcast as pending while a hash exists would simply be false. */
  const signed = Boolean(input.transactionHash);
  const reconciled =
    Boolean(input.reconciliation) &&
    input.reconciliation !== "NOT_RECONCILED" &&
    input.reconciliation !== "RECONCILIATION_REQUIRED";

  const states: Record<LifecycleStage, StageState> = {
    RYNTRA_AUTHORIZATION: input.authorized ? "DONE" : "PENDING",
    WALLET_SIGNATURE: signed ? "DONE" : input.authorized ? "ACTIVE" : "PENDING",
    BROADCAST: signed ? "DONE" : "PENDING",
    ARC_CONFIRMATION: input.confirmed ? "DONE" : signed ? "ACTIVE" : "PENDING",
    /* RECONCILIATION_REQUIRED is its own outcome — not a failure and not a
       success. A real transaction exists and nobody has read what it did. It
       is the one state an operator must not walk away from, so it cannot
       render as quiet progress. */
    RECONCILIATION:
      input.reconciliation === "RECONCILIATION_REQUIRED"
        ? "BLOCKED"
        : reconciled
          ? "DONE"
          : input.confirmed
            ? "ACTIVE"
            : "PENDING",
    RECEIPT: input.finalized ? "DONE" : reconciled ? "ACTIVE" : "PENDING",
  };

  if (input.busy) states[input.busy] = "ACTIVE";
  /* A failure marks its own stage only. Everything before it stays DONE: if
     reconciliation fails the transaction is still on the chain, and a screen
     that reset the earlier states would tell an operator nothing happened
     while their money had already moved. */
  if (input.failure) states[input.failure.stage] = "FAILED";
  return states;
}

export function lifecycleStateLabel(
  stage: LifecycleStage,
  state: StageState,
  input: LifecycleInput,
): string {
  if (state === "FAILED") return "FAILED";
  if (stage === "RECONCILIATION" && state === "BLOCKED") return "REQUIRED";
  if (stage === "RECONCILIATION" && state === "DONE") return input.reconciliation ?? "DONE";
  if (state === "DONE") return "DONE";
  if (state === "ACTIVE") return "IN PROGRESS";
  return "PENDING";
}
