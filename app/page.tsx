import type { Metadata } from "next";
import Link from "next/link";

import {
  ADDITIONAL_LIMITATIONS,
  ARC_PROJECT,
  INTEGRATION_SURFACE,
  LIFECYCLE,
  PROOF_ROWS,
  RECORDED_RUN,
  SCOPE_AND_LIMITATIONS,
  TWO_SURFACES,
} from "./arc/arc-project.ts";
import styles from "./page.module.css";

/**
 * The reviewer's first screen.
 *
 * Every fact on this page is read from `app/arc/arc-project.ts` — the same
 * module the API and the health route read. Nothing is retyped here, because a
 * retyped hash is how a page starts drifting from the run it claims to
 * describe. A proof row with a `null` value renders as a stated gap and never
 * as a button.
 */
export const metadata: Metadata = {
  title: "Ryntra Guard for Arc — Decision & Settlement Evidence",
  description:
    "Preflight programmable-money intents, preserve human authorization, reconcile Arc Testnet settlement and produce a structured Execution Receipt.",
};

export default function HomePage() {
  return (
    <main className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.rail}>
          {ARC_PROJECT.statusRail.map((item) => (
            <span key={item} className={styles.railItem}>
              {item}
            </span>
          ))}
        </p>

        <h1 className={styles.title}>{ARC_PROJECT.name}</h1>
        <p className={styles.descriptor}>{ARC_PROJECT.descriptor}</p>

        <p className={styles.lede}>
          Evidence before settlement. Proof after it. Ryntra Guard checks a supported
          programmable-money intent against available evidence and a declared policy before wallet
          authorization, tracks its {ARC_PROJECT.network} settlement, compares expected and actual
          effects, and produces a structured Execution Receipt.
        </p>

        <p className={styles.status}>{ARC_PROJECT.status}</p>

        <div className={styles.actions}>
          <Link className={styles.primary} href="/arc/demo">
            Open Testnet Demo
          </Link>
          <a
            className={styles.secondary}
            href={RECORDED_RUN.explorerUrl}
            rel="noreferrer noopener"
            target="_blank"
          >
            View Arc Explorer transaction
          </a>
          <Link className={styles.secondary} href="#proof">
            Read the recorded run
          </Link>
        </div>

        <p className={styles.rail}>
          {ARC_PROJECT.claimRail.map((item) => (
            <span key={item} className={styles.claim}>
              {item}
            </span>
          ))}
        </p>
      </header>

      <section className={styles.section}>
        <h2 className={styles.h2}>The problem</h2>
        <p className={styles.body}>
          A decision taken before signing does not prove what settled. Evidence can be stale,
          partial, unavailable or in conflict at the moment it matters, and the effects a user
          authorized can differ from the effects that landed on chain. Most systems record the
          signature and stop there — which leaves the two facts a reviewer, a treasury or an auditor
          actually needs, the basis of the decision and the reconciliation of its outcome, nowhere.
        </p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>One complete flow</h2>
        <ol className={styles.flow}>
          {LIFECYCLE.map((step, index) => (
            <li key={step.id} className={styles.step}>
              <span className={styles.stepIndex}>{String(index + 1).padStart(2, "0")}</span>
              <h3 className={styles.stepTitle}>{step.title}</h3>
              <p className={styles.stepBody}>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.section} id="proof">
        <h2 className={styles.h2}>The recorded run</h2>
        <p className={styles.body}>
          One real owner-authorized operation on {RECORDED_RUN.network}. Every value below was read
          back from the chain or from the finalized receipt; the receipt hash and its SHA-256
          integrity digest were recomputed independently of this application before publication.
        </p>

        <dl className={styles.proof}>
          {PROOF_ROWS.map((row) => (
            <div key={row.key} className={styles.proofRow}>
              <dt className={styles.proofKey}>{row.key}</dt>
              <dd className={row.value ? styles.proofValue : styles.proofPending}>
                {row.value ?? row.pending ?? "Not available."}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>Integration surface</h2>
        <p className={styles.body}>
          Only interfaces that run today. Nothing below is a planned endpoint.
        </p>
        <ul className={styles.cards}>
          {INTEGRATION_SURFACE.map((item) => (
            <li key={item.id} className={styles.card}>
              <h3 className={styles.cardTitle}>{item.title}</h3>
              <p className={styles.cardBody}>{item.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>{TWO_SURFACES.title}</h2>
        <p className={styles.body}>{TWO_SURFACES.workspace}</p>
        <p className={styles.body}>{TWO_SURFACES.guard}</p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>Scope and limitations</h2>
        <ul className={styles.limits}>
          {SCOPE_AND_LIMITATIONS.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <ul className={styles.limits}>
          {ADDITIONAL_LIMITATIONS.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>

      <footer className={styles.footer}>
        <p>
          {ARC_PROJECT.name} · {ARC_PROJECT.network} · chain {RECORDED_RUN.chainId}. Non-custodial:
          this project never receives a private key, seed phrase or withdrawal authority.
        </p>
      </footer>
    </main>
  );
}
