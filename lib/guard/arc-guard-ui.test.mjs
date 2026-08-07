// Run from repo root: node --test lib/guard/arc-guard-ui.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const CLIENT = new URL("../../app/arc-guard/arc-guard-demo.tsx", import.meta.url);
const CSS = new URL("../../app/arc-guard/arc-guard.module.css", import.meta.url);

test("demo client carries the required public prototype labels and truthful receipt state", async () => {
  const source = await readFile(CLIENT, "utf8");
  for (const label of [
    "INDEPENDENT PROJECT",
    "ARC TESTNET",
    "TESTNET ONLY",
    "NOT AUDITED",
    "NOT FINANCIAL ADVICE",
    "NOT VERIFIED",
    "Not finalized",
  ]) {
    assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  /* The capability card is read from ARC_PROJECT, not typed here. It carried
     `LIVE TX UNVERIFIED` after Gate B had already passed, so the demo
     contradicted the page that links to it. Asserting the absence of the stale
     string is what stops that regression coming back by hand; asserting the
     import is what keeps the two surfaces on one source. */
  assert.match(source, /import \{ ARC_PROJECT \} from "\.\.\/arc\/arc-project\.ts"/);
  assert.match(source, /<strong>\{ARC_PROJECT\.status\}<\/strong>/);
  assert.doesNotMatch(source, /LIVE TX UNVERIFIED|SOURCE IMPLEMENTED/);
  assert.match(source, /Wallet signature unavailable/);
  assert.match(source, /Secure App Kit external-signing handshake is not implemented/);
  assert.match(source, /EOA TRANSFER FALLBACK/);
  assert.match(source, /eth_sendTransaction/);
  assert.match(source, /RECONCILE_TRANSFER/);
  assert.match(source, /evidenceStatus/);
  assert.match(source, /policyDecision/);
  assert.match(source, /executionStatus/);
  assert.match(source, /memoSupported: false/);

  const executeStart = source.indexOf("async function executeTransfer");
  const executeEnd = source.indexOf("async function reconcileTransfer");
  assert.ok(executeStart >= 0 && executeEnd > executeStart);
  const executeSource = source.slice(executeStart, executeEnd);
  assert.match(executeSource, /eth_chainId/);
  assert.match(executeSource, /eth_accounts/);
  assert.match(executeSource, /flow\.fingerprint\.walletAddress/);
  const hashCapture = executeSource.indexOf("setTransactionHash(normalizedHash)");
  const recordCall = executeSource.indexOf('action: "RECORD_EXECUTION"');
  assert.ok(hashCapture >= 0 && recordCall > hashCapture, "hash must survive before record API");

  const reconcileStart = source.indexOf("async function reconcileTransfer");
  const reconcileEnd = source.indexOf("async function copyDeveloperExample");
  assert.ok(reconcileStart >= 0 && reconcileEnd > reconcileStart);
  const reconcileSource = source.slice(reconcileStart, reconcileEnd);
  assert.match(reconcileSource, /RECORD_EXECUTION/);
  assert.match(reconcileSource, /recordExecutionKey/);

  const routeSource = await readFile("app/api/arc-guard/route.ts", "utf8");
  assert.match(routeSource, /intent\.productionCalldataBound === true/);
});

test("browser bundle contains no Circle kit credential path", async () => {
  const source = await readFile(CLIENT, "utf8");
  assert.doesNotMatch(source, /CIRCLE_APP_KIT_KEY/);
  assert.doesNotMatch(source, /NEXT_PUBLIC_[A-Z0-9_]*KIT/);
  assert.doesNotMatch(source, /KIT_KEY:/);
});

test("the network is registry data, and the client renders it rather than owning it", async () => {
  const source = await readFile(CLIENT, "utf8");
  const {
    ARC_TESTNET_NETWORK,
    chainRefFor,
    hexChainIdFor,
    publishedRpcEndpoints,
  } = await import("../../lib/guard/networks.ts");

  /* One source for every chain identifier. The hex form and the CAIP references
     are derived from the decimal chain id, so the class of bug that shipped here
     — a hand-typed hex literal whose digits were transposed into a chain that
     does not exist — cannot recur. */
  assert.equal(ARC_TESTNET_NETWORK.chainId, 5_042_002);
  assert.equal(hexChainIdFor(ARC_TESTNET_NETWORK), "0x4CEF52");
  assert.equal(chainRefFor(ARC_TESTNET_NETWORK), "eip155:5042002");
  assert.equal(ARC_TESTNET_NETWORK.explorerBaseUrl, "https://testnet.arcscan.app");
  assert.equal(ARC_TESTNET_NETWORK.nativeCurrency.decimals, 18);
  assert.equal(ARC_TESTNET_NETWORK.tokens.usdc.decimals, 6);
  assert.equal(ARC_TESTNET_NETWORK.carriesRealValue, false);

  /* Every endpoint Arc publishes, primary first. The mirrors are load-bearing:
     the primary refuses whole countries at its WAF, so a build that knows only
     the primary is unusable from a blocked region. */
  assert.deepEqual(publishedRpcEndpoints(ARC_TESTNET_NETWORK), [
    "https://rpc.testnet.arc.io",
    "https://rpc.blockdaemon.testnet.arc.io",
    "https://rpc.drpc.testnet.arc.io",
    "https://rpc.quicknode.testnet.arc.io",
  ]);

  // The client holds none of it.
  assert.doesNotMatch(source, /0x4C[0-9A-Fa-f]{4}/);
  assert.doesNotMatch(source, /https:\/\/rpc\./);
  assert.doesNotMatch(source, /arcscan\.app/);
  assert.match(source, /nativeCurrency: network\.nativeCurrency/);
  assert.match(source, /chainName: network\.label/);
});

test("mainnet is modelled but cannot be selected without its gate", async () => {
  const { ARC_MAINNET_NETWORK, resolveArcNetwork } = await import("../../lib/guard/networks.ts");

  /* Adding a network must be a data change — that is the whole point of the
     registry. What must never be a data change is the permission to use one
     that carries real value. */
  assert.equal(ARC_MAINNET_NETWORK.status, "DESIGNED");
  assert.equal(ARC_MAINNET_NETWORK.carriesRealValue, true);
  assert.match(ARC_MAINNET_NETWORK.gate, /Gate D/);
  assert.match(ARC_MAINNET_NETWORK.gate, /kill switch/i);
  assert.match(ARC_MAINNET_NETWORK.gate, /canary/i);

  assert.equal(resolveArcNetwork({}).id, "arc-testnet");
  assert.equal(resolveArcNetwork({ ARC_NETWORK: "arc-testnet" }).id, "arc-testnet");

  /* Refusing loudly matters more than refusing. A silent fall back to testnet
     would leave an operator who believed they had switched to mainnet
     transacting on a network with no real value and never knowing. */
  assert.throws(() => resolveArcNetwork({ ARC_NETWORK: "arc-mainnet" }), /not selectable/);
  assert.throws(() => resolveArcNetwork({ ARC_NETWORK: "arc-mainnet" }), /Gate D/);
  assert.throws(() => resolveArcNetwork({ ARC_NETWORK: "nope" }), /not a known Arc network/);
});

test("desktop evidence layout has explicit tablet, mobile and reduced-motion adaptations", async () => {
  const css = await readFile(CSS, "utf8");
  assert.match(css, /@media \(max-width: 1100px\)/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /@media \(max-width: 430px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});
