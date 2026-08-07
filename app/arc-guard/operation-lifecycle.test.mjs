// Run from repo root: node --test app/arc-guard/operation-lifecycle.test.mjs
import assert from "node:assert/strict";
import test from "node:test";

import { lifecycleStates } from "./operation-lifecycle-states.ts";

const EMPTY = {
  authorized: false,
  transactionHash: null,
  confirmed: false,
  reconciliation: null,
  finalized: false,
};

test("nothing is claimed before a human authorizes", () => {
  const states = lifecycleStates(EMPTY);
  assert.equal(states.RYNTRA_AUTHORIZATION, "PENDING");
  assert.equal(states.WALLET_SIGNATURE, "PENDING");
  assert.equal(states.BROADCAST, "PENDING");
  assert.equal(states.ARC_CONFIRMATION, "PENDING");
  assert.equal(states.RECEIPT, "PENDING");
});

test("Ryntra authorization never implies a wallet signature", () => {
  /* The whole reason these are separate. Ryntra recording a human decision is
     an application event; signing is a cryptographic act by the key holder that
     Ryntra cannot perform and does not witness. An authorized-but-unsigned
     operation must never read as though money moved. */
  const states = lifecycleStates({ ...EMPTY, authorized: true });
  assert.equal(states.RYNTRA_AUTHORIZATION, "DONE");
  assert.equal(states.WALLET_SIGNATURE, "ACTIVE");
  assert.equal(states.BROADCAST, "PENDING");
  assert.equal(states.ARC_CONFIRMATION, "PENDING");
});

test("a transaction hash proves both signature and broadcast", () => {
  /* eth_sendTransaction signs and broadcasts in one call and returns a hash.
     The hash is therefore evidence of both, and marking broadcast as pending
     while a hash exists would be false. */
  const states = lifecycleStates({
    ...EMPTY,
    authorized: true,
    transactionHash: "0xabc",
    reconciliation: "RECONCILIATION_REQUIRED",
  });
  assert.equal(states.WALLET_SIGNATURE, "DONE");
  assert.equal(states.BROADCAST, "DONE");
});

test("an unread result is BLOCKED — not pending, and certainly not done", () => {
  /* RECONCILIATION_REQUIRED means a real transaction exists and nobody has
     read what it did. It is the one state an operator must not walk away
     from, so it cannot render as quiet progress. */
  const states = lifecycleStates({
    ...EMPTY,
    authorized: true,
    transactionHash: "0xabc",
    reconciliation: "RECONCILIATION_REQUIRED",
  });
  assert.equal(states.RECONCILIATION, "BLOCKED");
  assert.equal(states.RECEIPT, "PENDING");
});

test("a receipt cannot be reached without reconciliation", () => {
  const confirmedButUnread = lifecycleStates({
    ...EMPTY,
    authorized: true,
    transactionHash: "0xabc",
    confirmed: true,
    reconciliation: "NOT_RECONCILED",
  });
  assert.equal(confirmedButUnread.ARC_CONFIRMATION, "DONE");
  assert.equal(confirmedButUnread.RECONCILIATION, "ACTIVE");
  assert.equal(confirmedButUnread.RECEIPT, "PENDING");
});

test("a recorded deviation still completes the lifecycle", () => {
  /* DEVIATION_RECORDED is a real, finished outcome: expected and actual were
     compared and they differed. Hiding it, or treating it as failure, would
     defeat the point of reconciling at all. */
  const states = lifecycleStates({
    authorized: true,
    transactionHash: "0xabc",
    confirmed: true,
    reconciliation: "DEVIATION_RECORDED",
    finalized: true,
  });
  assert.equal(states.RECONCILIATION, "DONE");
  assert.equal(states.RECEIPT, "DONE");
});

test("the full matched path ends with every state done", () => {
  const states = lifecycleStates({
    authorized: true,
    transactionHash: "0x6476dc81",
    confirmed: true,
    reconciliation: "MATCHED",
    finalized: true,
  });
  for (const stage of Object.keys(states)) {
    assert.equal(states[stage], "DONE", `${stage} should be DONE on the matched path`);
  }
});

test("a failure marks its own stage and no other", () => {
  const states = lifecycleStates({
    ...EMPTY,
    authorized: true,
    failure: { stage: "WALLET_SIGNATURE", message: "The wallet rejected the request." },
  });
  assert.equal(states.WALLET_SIGNATURE, "FAILED");
  assert.equal(states.RYNTRA_AUTHORIZATION, "DONE");
  assert.equal(states.BROADCAST, "PENDING");
});

test("a failure after broadcast cannot erase the transaction that exists", () => {
  /* If reconciliation fails, the transaction is still on the chain. The
     signature and broadcast states must stay DONE — a UI that reset them
     would tell an operator nothing happened while their money had moved. */
  const states = lifecycleStates({
    authorized: true,
    transactionHash: "0xabc",
    confirmed: false,
    reconciliation: "RECONCILIATION_REQUIRED",
    finalized: false,
    failure: { stage: "RECONCILIATION", message: "The Arc RPC endpoint could not be read." },
  });
  assert.equal(states.WALLET_SIGNATURE, "DONE");
  assert.equal(states.BROADCAST, "DONE");
  assert.equal(states.RECONCILIATION, "FAILED");
});
