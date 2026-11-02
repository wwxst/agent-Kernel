# Model execution and budget contract

> **Status: Approved principles re-authored as an initial contract and extended by a PROPOSED intelligent-execution model.** Provider-specific usage evidence and runtime implementation remain unverified.

## 1. Ownership

- Kernel owns ModelStep / Attempt lifecycle, request admission, hard budget reservation, and settlement state.
- Model Gateway owns provider protocol interaction, credentials boundary, streaming, complete-response normalization, usage evidence, and provider error normalization.
- Orchestration chooses the purpose and strategy of a model step, but submits it through Kernel.
- Context Engine provides a version-bound context projection; it does not authorize execution.

Planner, Explorer, Implementer, Debugger, Verifier, and summary model calls are all Kernel-managed ModelSteps. Orchestration must not bypass Kernel and call a Provider directly. A role or purpose label does not create a separate authority domain or agent identity.

## 2. ModelStep and Attempt

A ModelStep is one logical model decision point. A ModelAttempt is one actual provider request/attempt associated with a ModelStep. A retry is a new Attempt under the same or a new ModelStep according to the accepted retry contract; it must never be hidden as an untracked provider-side action.

A ModelStep purpose should identify the decision being made, such as reconnaissance, goal analysis, planning, implementation, debugging, verification, or summary. The purpose label supports policy, observability, and evaluation; it does not itself grant extra permissions.

### 2.1 Three independent dimensions (PROPOSED refinement)

Each Attempt has independent (a) provider execution outcome, (b) candidate eligibility/ModelStep selection, and (c) financial exposure/settlement. A provider execution success is not a billing settlement. A billing delay does not retroactively invalidate an otherwise valid response if **all possible charges were covered by a credible reservation bound at admission**.

A response is eligible to be recorded as a candidate only when:

- the provider response is complete, not truncated or interrupted;
- schema and structural validation pass, including complete unambiguous tool arguments;
- plan/workspace bindings remain current and the candidate was not completed after effective Cancel Intent;
- the owning Attempt was admitted under an enforceable hard-budget reservation or an explicitly accepted soft-budget mode.

A complete candidate is not itself permission to perform a tool side effect. A partial/truncated response never becomes executable.

## 3. Deterministic candidate and final selection

- Every eligible complete response is durably recorded with Attempt ID, response digest and Kernel Journal sequence. The earliest eligible journal-append sequence wins; provider timestamps and client receive times do not arbitrate.
- `candidateAttemptId` is provisional. `selectedAttemptId` is irreversible after the one Kernel transaction that commits final selection, ModelStep Completed and ResponseDeliveryOutbox.
- Once a valid response is selected, later candidates cannot replace it. Nonselected responses may be kept as historical evidence and **must not** produce ActionProposals or ToolInvocations.
- Losing or still-running Attempts receive Cancel Intent and remain accountable for their **entire outstanding maximum charge** until trustworthy settlement/convergence. Do not wait for their cancel acknowledgement, usage invoice or provider closure merely to commit and deliver the selected response.
- If the winner's response was journaled before a competing cancellation, selection remains eligible subject to the ordinary snapshot and admission checks. A response first completed/recorded after effective cancellation remains late evidence, not a selectable candidate.
- Invalid/stale response, missing credible charge bound under hard budget, or unrelated Task authority change can block selection. **Delayed final invoices alone cannot block selection when complete outstanding exposure remains reserved.**

## 4. Budget reservation, settlement and verification reserve

Kernel is the only hard-budget ledger authority. It records budget scope/limit, per-Attempt reservation identity and maximum amount, pinned pricing/request contract and charge authority, execution outcome, usage evidence, provisional/settled accounting, adjustment/reversal, overrun/debt and enforcement hold.

For every applicable hard-budget funding scope, admission maintains:

`confirmed_spend + maximum_unsettled_exposure + proposed_reservation <= hard_budget`

The total exposure includes every concurrent Attempt (including losing, cancelled-but-unconfirmed and provider-side retry attempts) that may still be charged. A provider must support a **trusted finite per-request maximum** under the pinned request/pricing contract; explicit output limits alone are not a guaranteed currency bound if hidden charges or uncontrolled retries remain possible. A request without a credible maximum is **not eligible for hard-budget execution**. Missing usage is never assumed to be zero.

The system may offer a separately opted-in **soft-budget mode** with clear non-guarantee and best-effort controls. It must not call this a hard ceiling. A provider incapable of a charge bound either uses that explicitly authorized mode or is rejected.

### 4.1 ProviderAdapter maximum-charge certificate — hard-budget admission

A trustworthy **maximum charge** must be more than a price estimate. For every charge-bearing Attempt, a ProviderAdapter supplies a canonical, versioned, immutable `MaximumChargeCertificate` with an authenticated adapter identity and request binding, validated by Kernel **before** creating the hard-budget reservation and issuing the provider request.

Minimum certificate fields and required evidence:

| Field | Proof requirement |
| --- | --- |
| Provider / account / SKU / model / region, pricing version and validity interval | Authenticated price schedule or contractual rate ceiling, recorded currency and effective date/time; changes invalidate stale certificates |
| Canonical submitted request digest and maximum billable input | Include system/developer context, tool schema/definitions, retrieved/cached content, hidden/prompt transformations if charged, and enforceable size bounds |
| Maximum output, reasoning and additional billable tokens/units | A provider-enforced cap for **every** charged output dimension, including tool-side or internal steps if billable |
| Cache read, write, storage and discount behavior | Conservative worst-case charge assuming no unproven discount; exclude refunds/credits from the bound unless guaranteed |
| Fixed per-request fees and extra services | Include modality charges (image/audio/video), retrieval, hosted tools, batch/minimum charges, data transfer, storage and other provider-controlled fees |
| Retry, continuation, redirect, provider-side internal repetition | Enumerate every retryable charge with a **provider-enforced maximum count** and total envelope; uncontrolled hidden retries disqualify hard-budget mode |
| Rounding, taxes and currency conversion | Conservative rate/rounding policy and pinned exchange/tax bound when included in the Task's hard monetary ceiling |
| Maximum total amount and proof issuer | Deterministic conservative calculation, signed/attested adapter version and evidence references, expiration, enforceable request limits and verification status |

**Admission decision:** The adapter validates that its upper-bound claims are tied to the actual provider request, not just application hints. Kernel checks trusted issuer, schema, active pricing/version, proof coverage for all billable dimensions, request digest, bound expiration and no unsupported extras. Kernel then reserves the **full upper bound of every concurrent Attempt** in each relevant funding scope in a K-local transaction. An adapter's self-reported confidence, historical average price or estimated token count alone is not proof of a hard ceiling.

If any term is unbounded, hidden, mutable without a contractual cap or unenforceable by the provider, the certificate is invalid for Hard Budget. **Fail closed at admission** or require an explicitly authorized, separately labeled Soft Budget with an admitted cost risk; never silently downgrade hard to soft. An unexpected late charge above a valid certificate records a pricing/integrity violation, append-only debt and appropriate enforcement hold, without rewriting the previously selected model response or terminal Task.

The provider-specific certificate schema, trustworthy evidence and exact price-bound algorithms remain **PROPOSED / UNVERIFIED** until G1 adapter verification; this document defines admission obligations without asserting any current Provider qualifies.

The Model Gateway records complete results and provider usage evidence; the Kernel maintains append-only budget responsibility. Billing may settle after ModelStep selection, response delivery, or even Task termination. Adjustments cannot rewrite a previously committed selection or terminal Task. Losing Attempts' unused reservation is released **only** when a trusted terminal usage bound/result establishes safe releasability, never because a timeout or cancellation request occurred.

`BlockedUnbounded` is a recoverable hold for an attempted/legacy charge-bearing request whose exposure cannot be bounded; it applies to affected funding/admission scopes. It is not a provider execution result or an automatic global Task block. Reconcile usage or obtain an authorized budget action before unblocking unsafe funded work. Related Task completion rules still consider outstanding relevant execution risks independently of billing latency.

Reserve sufficient budget for required verification and bounded repair based on task uncertainty rather than a fixed percentage. Orchestration may allocate adaptively but may not silently consume a protected verification reserve without authorized budget change. See [Core protocol](core-protocol.md).

## 5. Budget overrun and terminal-state protection

If an authoritative late bill exceeds its Reservation:

- For a non-terminal Task, atomically append the overrun/debt and enforcement hold to the **affected BudgetScope aggregate** using budgetScopeVersion CAS, stopping new funded admissions for that scope. The Task's Blocked display phase is **derived** from this funding hold; a financial adjustment does not increment global TaskControlVersion.
- For an already terminal Task, append PostTerminalBudgetOverrun and BudgetEnforcementHold; preserve the original Completed / Failed / Cancelled status and ModelStep completion.
- Freeze only the shared budget scopes that actually fund the affected reservation; do not freeze unrelated scopes.
- Keep in-flight UNKNOWN Attempts / Invocations tied to their original IDs and reservations. Do not release or replay them without reconciliation.
- Unfreeze only after an authorized BudgetTopUp / BudgetOverrunWaiver and required in-flight UNKNOWN reconciliation.

Task completion and a late budget overrun are ordered by **K-local serializable transactions**: Completion Guard atomically checks relevant BudgetScope enforcement-hold versions/read-set **together with** its TaskControl terminal CAS; a simultaneous BudgetScope overrun write conflicts or is ordered by that protected read-set. If hold commits first, completion is denied; if terminal completion commits first, late debt becomes a PostTerminalBudgetOverrun record. The overrun writer does not need to CAS the unrelated TaskControl aggregate. G1 must prove this interleaving and reject a storage implementation incapable of a coherent K-local read-set.



## 6. Domain and Host resource budget extension

This document defines ModelStep/Attempt usage accounting. It is not the complete resource vocabulary for the unified Kernel.

The shared Kernel budget authority must also support reservations and settlement for admitted Host operations. These are separate resource dimensions from provider token/cost usage and must not be inferred from model usage.

Candidate Host/domain dimensions include:

- wall-clock execution time and timeout;
- CPU time, thread/process count, and peak memory;
- GPU time/memory where available and enforceable;
- temporary and final disk usage;
- input media bytes, duration, resolution, and estimated decoded workload;
- output artifact size and duration;
- network transfer where explicitly permitted;
- verification and bounded-repair reserve.

Each reservation binds the Task, DomainBinding/Workflow Profile, ToolInvocation, Host run/job ID, resource policy version, and hard limits. Kernel performs admission and reservation; Host reports measured consumption and terminal process facts; Kernel settles usage and records overruns/unknown usage.

A long-running operation must not consume an unbounded resource merely because progress is still being reported. Progress telemetry is not a budget reservation or settlement record. If usage cannot be authoritatively bounded after a Host failure, preserve the reservation/UNKNOWN hold until reconciled.

For Video, the Workflow Profile and RenderJob define render-specific limits. See [RenderJob contract](render-job.md). For Coding, the profile defines command/build/test limits under the same Host budget authority.

The exact cross-platform enforcement mechanisms and accounting precision remain OPEN / UNVERIFIED. This extension does not select cgroups, a GPU scheduler, a storage system, or a process runtime.

## 7. Open implementation questions

The following are not decided by this contract:

- Provider-specific usage and invoice authority, precision, and delay.
- Whether provider-side retries can be observed and charged reliably.
- Pricing model/version capture and hidden fees.
- Exact reservation algorithm, concurrency accounting, and budget hierarchy.
- How verification reserve is estimated and adjusted for task uncertainty.
- Storage technology and transaction implementation.
- Provider protocol adapters and retry/backoff policy.

All of these remain **OPEN / UNVERIFIED** until evidence is gathered.
