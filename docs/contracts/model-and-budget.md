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

A response is eligible to become a candidate only when:

- the provider response is complete, not truncated or interrupted;
- the response has passed the applicable schema and structural validation;
- tool-call identities and arguments are complete and unambiguous;
- plan/workspace bindings remain current;
- usage and budget settlement requirements permit the response to proceed.

Partial, truncated, cancelled-after-linearization, or settlement-blocked responses are not executable candidates.

## 3. Deterministic candidate and final selection

- Every complete response candidate is durably recorded in the Kernel Journal with its Attempt identity, digest, and sequence.
- For concurrent Attempts, the Kernel Journal durable append order is the deterministic ordering source. Client receive time, provider-reported completion time, and wall clock are not arbitration authorities.
- candidateAttemptId is a provisional pointer to the earliest valid candidate according to the journal ordering rule.
- selectedAttemptId is the final, irreversible choice.
- The final selection, ModelStep Completed transition, and ResponseDeliveryOutbox creation occur in one Kernel-local transaction.
- Once committed, the selected Attempt cannot be replaced by a late response.

A complete response that arrives after Cancel Intent has already linearized is retained as late evidence, not admitted as a candidate. If the candidate was durably recorded first, it retains eligibility subject to all remaining Attempts and budget settlement reaching a safe terminal condition.

## 4. Budget reservation and verification reserve

Kernel is the only hard-budget ledger authority. It records:

- budget scope and limits;
- reservation identity and amount;
- Attempt / provider request binding;
- usage evidence and its authority class;
- settlement status and adjustments;
- overrun / debt records;
- enforcement holds and authorized release/top-up.

Orchestration may propose an allocation across reconnaissance, planning, implementation, debugging, and verification. Kernel enforces the hard limit and reservations. The plan should reserve sufficient budget for required verification and bounded repair rather than allowing exploration or implementation to consume the entire budget.

Budget allocation is adaptive, not a fixed percentage selected by this contract. It should account for task class, uncertainty, remaining criteria, and observed failure cost. The verifier and final evidence collection must not be silently skipped merely because earlier phases consumed the available budget.

Usage evidence and execution outcome are separate dimensions. An Attempt may have completed its provider interaction while its billing settlement remains unresolved.

BlockedUnbounded is a recoverable blocking condition, not a terminal Attempt result. The system must not assume zero cost when authoritative usage is unavailable. It may resume only when usage, invoice evidence, or a trusted maximum bound tied to the original Attempt / Reservation is durably reconciled.

Settlement is append-only. Later authoritative corrections create Adjustment / Reversal records; they do not overwrite prior evidence.

## 5. Budget overrun and terminal-state protection

If an authoritative late bill exceeds its Reservation:

- For a non-terminal Task, atomically record the overrun/debt and enforcement hold, freeze the affected budget scope, and block new admissions through a Task-version compare-and-swap.
- For an already terminal Task, append PostTerminalBudgetOverrun and BudgetEnforcementHold; preserve the original Completed / Failed / Cancelled status and ModelStep completion.
- Freeze only the shared budget scopes that actually fund the affected reservation; do not freeze unrelated scopes.
- Keep in-flight UNKNOWN Attempts / Invocations tied to their original IDs and reservations. Do not release or replay them without reconciliation.
- Unfreeze only after an authorized BudgetTopUp / BudgetOverrunWaiver and required in-flight UNKNOWN reconciliation.

Task completion and a late budget overrun are linearized by Kernel Journal / Task-version CAS: whichever commits first determines whether the Task is blocked before completion or remains terminal with an independent post-terminal budget record.



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
