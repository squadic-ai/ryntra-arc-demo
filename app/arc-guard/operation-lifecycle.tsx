"use client";

import styles from "./operation-lifecycle.module.css";
import {
  LIFECYCLE_LABELS,
  LIFECYCLE_ORDER,
  lifecycleStateLabel,
  lifecycleStates,
  type LifecycleInput,
  type StageState,
} from "./operation-lifecycle-states.ts";

/**
 * Renders the six operation states. Every rule lives in
 * `operation-lifecycle-states.ts` and is tested there directly — this file only
 * decides how they look.
 */

export type { LifecycleInput, LifecycleStage } from "./operation-lifecycle-states.ts";

function stateClass(state: StageState): string {
  if (state === "DONE") return styles.done;
  if (state === "ACTIVE") return styles.active;
  if (state === "BLOCKED") return styles.blocked;
  if (state === "FAILED") return styles.failed;
  return styles.pending;
}

export function OperationLifecycle(input: LifecycleInput) {
  const states = lifecycleStates(input);

  return (
    <ol className={styles.lifecycle} aria-label="Operation states">
      {LIFECYCLE_ORDER.map((stage) => {
        const state = states[stage];
        return (
          <li key={stage} className={`${styles.stage} ${stateClass(state)}`}>
            <span className={styles.marker} aria-hidden="true" />
            <div className={styles.body}>
              <div className={styles.head}>
                <span className={styles.title}>{LIFECYCLE_LABELS[stage].title}</span>
                <span className={styles.state}>
                  {lifecycleStateLabel(stage, state, input)}
                </span>
              </div>
              <p className={styles.detail}>
                {state === "FAILED" && input.failure?.stage === stage
                  ? input.failure.message
                  : LIFECYCLE_LABELS[stage].detail}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
