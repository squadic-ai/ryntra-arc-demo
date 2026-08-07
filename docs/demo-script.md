# Three-minute demo package

> Record only after one real Arc Testnet transaction and reconciled receipt exist. Never splice a mock screen so it appears to be a live transaction. The source currently has no transaction hash.

## Recording branch

Use the EOA ERC-20 USDC treasury transfer narration below unless the existing App Kit USDC-to-EURC path independently completes end-to-end. Do not call a transfer a swap. If the swap later succeeds, change only the flow-specific sentences and insert its exact transaction evidence.

## English narration

### 00:00–00:20 — Problem

Programmable-money stacks already include wallets, transaction security, policy engines, compliance tools, orchestration, settlement, and public memos. But those systems answer different questions. An application still needs a truthful record linking one financial intent, the evidence available at decision time, the applicable policy, the user’s authorization, and the final onchain effect.

### 00:20–00:40 — Product

Ryntra Guard is a provider-neutral Decision and Settlement Evidence Layer. It normalizes the intent and attributed evidence, evaluates versioned financial policy deterministically, preserves the human-authorization boundary, binds the decision to an exact execution, and reconciles expected versus actual effects. The user wallet remains the signer.

### 00:40–01:40 — Live flow

This is a partner-style application on Arc Testnet. The App Kit swap path is preserved, but this recording uses the reliable fallback: a direct EOA ERC-20 USDC treasury transfer. I connect the wallet, confirm chain ID 5042002, enter the recipient and an exact decimal amount, and prepare preflight. Ryntra reads the ERC-20 USDC balance, native gas balance, contract interface, fee estimate, recipient, and route evidence with source, timestamp, validity, coverage, availability, and response digest. It keeps native USDC at eighteen decimals and ERC-20 USDC at six, with no JavaScript-number token math. The evidence status and policy decision are shown separately. I review the warnings and authorize the exact preflight hash. That authorization is not a wallet signature. The wallet then displays and signs the exact ERC-20 transaction.

### 01:40–02:15 — Transaction and receipt

Here is the real Arc Testnet transaction hash on Arcscan. Ryntra observes confirmation, verifies the contract target, calldata, value, sender, recipient, amount, and Transfer event, then compares expected and actual effects. Only after that reconciliation does it finalize the receipt with policy version and digest, preflight hash, execution status, reconciliation status, limitations, and receipt hash. An uncertain RPC response stays reconciliation-required; it is not called failed or confirmed.

### 02:15–02:40 — Partner integration

The UI is only a reference client. A partner server can create an intent, submit attributed evidence, inspect evidence completeness and policy decision independently, authorize the exact fingerprint, execute with its own wallet, record the transaction, and retrieve the receipt through the versioned API or small TypeScript client. No private key enters Ryntra.

### 02:40–03:00 — Production path

Ryntra does not replace Blockaid, Hypernative, wallets, compliance providers, Circle policies, or Arc memos. It can normalize their results when real integrations exist and preserve a provider-neutral decision-to-settlement record. After the prototype, the path is durable tenant isolation, signed webhooks, recovery tests, external integrations, and security review.

## English subtitles

Use the narration above as subtitle sentences. Keep each card to one or two sentences and no more than two lines. Show `INDEPENDENT PROJECT`, `ARC TESTNET`, `HACKATHON PROTOTYPE`, `NOT AUDITED`, and `NOT FINANCIAL ADVICE`. Show `HUMAN AUTHORIZED` only after the exact authorization record exists.

## Ukrainian founder explanation

У programmable-money стеку вже є wallets, transaction-security, policy та compliance системи, orchestration, settlement і Arc memos. Але вони відповідають на різні питання. Застосунку все одно потрібен правдивий зв’язок між конкретним intent, доказами на момент рішення, версією policy, дозволом людини та фактичним onchain результатом.

Ryntra Guard — це provider-neutral Decision & Settlement Evidence Layer. Він нормалізує intent і evidence з provenance та freshness, детерміновано перевіряє versioned financial policy, окремо зберігає human authorization, прив’язує його до exact execution fingerprint і порівнює expectedEffects з actualEffects. Wallet користувача залишається signer; Ryntra не отримує private key.

Поточний swap path через Circle App Kit збережений, але ще не підтверджений end-to-end. Тому надійний fallback для запису — direct EOA ERC-20 USDC treasury transfer на Arc Testnet. Native USDC для gas нормалізується як 18-decimal interface, ERC-20 USDC transfer — як 6-decimal interface. Після реального transaction hash Ryntra перевіряє onchain target, calldata, value, Transfer event та суму, виконує reconciliation і лише тоді фіналізує receipt. Без transaction hash ми не заявляємо live execution.

Це не перший firewall, не єдиний policy engine, не custody, не compliance verdict, не гарантія безпеки чи прибутку і не Arc/Circle partnership. Це independent, testnet-only, not-audited hackathon prototype.

## Screen-recording shot list

1. Title card: product name, provider-neutral one-liner, required prototype labels.
2. Reference client initial state: wallet disconnected; evidence, execution, and receipt unavailable.
3. Briefly show the preserved App Kit swap tab and its honest current state; do not imply execution.
4. Select `EOA USDC TREASURY TRANSFER`, connect the owner EOA, and show Arc Testnet chain ID 5042002.
5. Enter recipient and exact decimal amount; show ERC-20 USDC 6-decimal and native USDC 18-decimal distinction.
6. Run preflight and show provenance, freshness, coverage, availability, fee estimate, and exact fingerprint.
7. Pause on the independent evidence status and policy decision.
8. Show review/block/missing-evidence behavior using clearly labelled deterministic test scenarios.
9. Return to the live intent, press Authorize, and show the authorization method and preflight hash.
10. Show the owner wallet prompt with the exact target, recipient, and amount; sign only with founder approval.
11. Show the resulting real transaction hash and Arcscan confirmation.
12. Show actualEffects, reconciliationStatus, and exported receipt JSON with receiptHash.
13. Open the Developer tab and show the small TypeScript example.
14. Closing card: durable partner product path; no first/only/partner/production claim.

## Thirty-second founder/team video — Accelerator recommendation

“Hi, I’m Dmytro, founder of Ryntra. Programmable-money apps already use wallets, security, policy, compliance, and settlement providers, but decision and settlement evidence is still fragmented. Ryntra Guard is a provider-neutral layer that links one intent, attributed evidence, versioned policy, human authorization, and the final onchain effect. Our Arc Testnet prototype keeps the user wallet in control and produces an expected-versus-actual receipt. We are turning this into a practical integration product for payment, treasury, and tokenized-market applications.”
