# Minimal provable Kernel protocol — architecture convergence draft

> **Status: PROPOSED / NOT APPROVED / NOT IMPLEMENTED.** Architecture review amendment, not an ADP owner disposition or runtime authorization. This document narrows and links the cross-module protocol described in [Trusted ToolHost](../security/trusted-host.md), [Model and Budget](model-and-budget.md), [PlanRevision](plan-revision.md), [Completion](completion.md), and [Domain Workflow](domain-workflow.md). In case of disagreement, the corresponding authority-owning contract must be amended before any architecture freeze; this draft alone does not silently override approved decisions.

## 1. Objective and non-goals

The minimum authoritative Kernel protects identity, versioned Task/Plan state, admission, budget reservations, durable intent, idempotency, evidence bindings, and completion transitions. Domain Orchestration owns strategic/tactical/assurance decisions and domain semantics. A Trusted ToolHost owns its physical launch boundary and Host Ledger. Context Engine, evidence indexing, artifact storage, and Model Gateway are composed components, not necessarily distributed services.

This protocol describes **logical authorities** and requires no microservice split. It does not claim OS spawn is atomic with a database write, remote side effects are exactly once, a multi-Host global fence exists, or a model is capable of completing a real task.

## 2. Authority scope and event identity

A command that mutates a Kernel aggregate binds Task ID, expected Task version and a stable command/idempotency key. Admission also binds GoalContract, active PlanRevision, DomainBinding/profile, workspace/project generation, tool snapshot, authority epoch, and an already reserved budget identity. Committed events have durable identities and aggregate sequence numbers; a duplicate command with the same digest returns the previous disposition; the same key with a different digest is rejected.

A physical Host run binds ToolInvocation ID, LaunchAttempt ID, Host identity/incarnation, nonce, authority fence, target/workspace snapshot and immutable argument digest. Kernel Journal, dispatch Outbox, Host Ledger and result Inbox are distinct durability domains. A pending Outbox message may be delivered repeatedly but must never consume a new nonce for a prior Invocation without explicit reconciliation and re-admission. Inbox receipt deduplication is by trusted source identity, invocation, attempt and receipt digest; conflicting receipts are held for reconciliation, not overwritten.

## 3. Authoritative state projections

These tables define a **minimal projection** of the existing richer contracts; they do not rename or remove their additional states.

| Aggregate | Minimal states and allowed progress | Owner |
| --- | --- | --- |
| Task / Plan | Proposed → AcceptedPendingCutover → Active → Superseding → Superseded; at most one Active PlanRevision; task may enter Reconciling | Kernel |
| ModelStep selection | Open → CandidateRecorded → Selected/Completed; selection is irreversible; no candidate if response incomplete/stale | Kernel |
| ModelAttempt execution | Requested → InFlight → Complete/FailedKnown/Cancelled/OutcomeUnknown; charging is a separate dimension | Model Gateway facts, Kernel committed |
| Budget reservation | Reserved → ProvisionallyAccounted → Settled/Adjusted or HeldUnknown; no release on timeout | Kernel |
| ToolInvocation | Proposed → Admitted → DispatchPending → Started/Rejected/OutcomeUnknown → terminal trusted outcome (if knowable) | Kernel admission and Host receipts |
| Host LaunchAttempt | IntentDurable → GateRejected or LaunchBoundaryRecorded or OutcomeUnknown; nonce never re-usable | Trusted ToolHost |
| Verification / Completion | Bound evidence → criterion review → CompletionGuardAccepted/Blocked; Completed commits once | Kernel Guard |

No planner, verifier or model output is an authority to change these states directly. A non-terminal UNKNOWN can coexist with durable facts and must be handled with a typed reconciliation reason and conflict scope.

## 4. Required transitions and guards

| Event | Guard | Atomicity boundary | Forbidden result |
| --- | --- | --- | --- |
| AdmitModelAttempt | trustworthy cost upper bound reserved for hard-budget mode; correct authority and task version | Kernel budget + Attempt admission | unreserved charge-bearing request in hard-budget scope |
| RecordCandidate | complete, validated response; current snapshot; response arrived before effective cancellation | Kernel Journal append | partial tool arguments becoming executable |
| SelectCandidate | first eligible journal-ordered candidate; winning Attempt's cost exposure reserved; others remain fully reserved/held | Kernel transaction updates selection, ModelStep and delivery outbox | selection waits solely for other Attempts' invoices |
| AdmitToolInvocation | valid PlanStep, capability, approval, scope, authority, workspace and budget | Kernel admission + durable intent/outbox | Host launch from model proposal alone |
| EnterLaunchGate | nonce unique and durably consumed; current effective authority/version, workspace and reservation snapshot proved; Gate has live authority | one Host-local serialized decision boundary | cached ticket launched after fence |
| FenceHost | locally serialize epoch advancement against in-progress gates; close/deny old-epoch entry | same Host gate boundary | mark Revoked from Kernel request alone |
| ActivateNewPlan | old conflicting writes converged, UNKNOWN impact reconciled, fresh snapshot, structural plan validated | Kernel plan-switch CAS | overlapping conflicting old/new writes |
| CompleteTask | every required criterion has valid evidence; no relevant active/UNKNOWN write; correct immutable final snapshot | Kernel Completion Guard transaction | model assertion or stale report declaring Completed |

The Host launch syscall and its ledger persistence are **not one atomic transaction**. The one-use durable intent precedes physical creation. A crash or ambiguous syscall/result window produces OutcomeUnknown unless non-execution is positively established. A recorded launch-boundary identity is trustworthy only for the exact Host process facts it authenticates, not for remote application success.

## 5. Single-Host launch and revocation ordering (initial scope)

The first implementation target is one eligible Host launch arbiter per invocation-authority scope; it may run many concurrent non-conflicting jobs. The authoritative Kernel records RevocationRequested, stops new relevant admission/ticket issuance and advances the desired epoch. The Host must serialize its **local fence installation** with its local launch gate; the Kernel must not label the revocation `Revoked` until all eligible gates have acknowledged that fence or are verifiably disabled.

A launch can win the Host-local order **before** fence installation and is then an in-flight old-epoch operation subject to drain/cancel policy. A fence installed first rejects old tickets. A request pending acknowledgement is `RevocationPending`; request acceptance alone is not proof that an already issued ticket could not cross a remote gate. Host reachability loss fails closed for *new* launches, and a Host whose disabling cannot be proved prevents a global Revoked claim. ProcessConverged is a separate assertion requiring process-tree/handle evidence. A deployment that cannot supply this live-authority and fencing guarantee is **not eligible** for effectful Host execution.

Multiple independent Hosts, Host failover and global linearizable launch/revocation remain an **unapproved extension** requiring independent protocol and fault-injection evidence. Any future design must specify host membership/fencing, lease expiry, duplicated-ticket handling and partition recovery; it must not inherit a single-Host guarantee by prose.

## 6. Model usage, budget and liveness

Execution, candidate selection and cost settlement are orthogonal. For hard-budget Provider requests, admission must establish a credible **per-request maximum charge** under a pinned pricing/request contract, including possible provider retries. Reserve against every concurrent Attempt before issuing it.

`confirmed_spend + outstanding_max_reservations + proposed_new_reservation <= hard_budget` is the admission invariant for each applicable funding scope. An eligible winning candidate can commit after durable response validation even when losing Attempts are still cancelling or awaiting invoices; those Attempts retain their entire reserved exposure. Late authoritative usage appends Settlement/Adjustment and, if above the contractually trusted bound, records enforcement hold and overrun without rewriting a previously terminal Task.

No credible upper bound: reject in hard-budget mode; opt-in soft-budget mode must disclose that enforcement is best effort and can exceed the target. Missing usage is never zero. A financial hold affects only funding scopes that actually cover the unsettled exposure, not unrelated tasks. Provider-side uncontrollable retries or hidden charges invalidate a claimed hard bound.

## 7. Plan-change fast path

- **L0 TacticalAdjustment:** search, diagnostic hypothesis, tool choice and local decision refinement within an unchanged PlanStep/GoalContract/permissions/dependencies. No PlanRevision cutover; each effectful invocation still passes admission.
- **L1 PlanStepRework:** explicit authorized rework of the same outcome and authority envelope. Retain current PlanRevision; new attempt, artifact lineage and stale verification are recorded. Rework never resurrects superseded steps or weakens acceptance criteria.
- **L2 StructuralReplan:** change to accepted goal/scope, approval/capability, dependency graph, material resource envelope, acceptance obligation or material plan preconditions. Requires existing full freeze → drain/reconcile → refresh → validate → atomic cutover. First iteration has no partial or hot cutover optimization.

A model cannot self-label a structural change L0/L1 to bypass approval or cutover. Orchestration proposes classification with change evidence; Kernel checks the deterministic protected-field diff and fails closed to L2 when classification is insufficient.

## 8. Evidence snapshot and completion

For Coding, define a versioned, trusted `ProtectedInputScope` frozen before verification. It includes source/configuration, dependency manifests and lockfiles, tests and verification scripts, relevant untracked inputs, and other files that could change the result. Exclusions require an approved profile before the run, may include verified tool-generated caches/output directories, and may not be expanded retroactively by the agent.

The default integrity invariant is `sourceDigestBefore == sourceDigestAfter == sourceDigestAtGuard` for the **same immutable source-input snapshot** and approved scope. Tests run against that exact snapshot with isolated or declared output destinations. Test-output digests and provenance are separate evidence; they do not need to equal source digests. If a tool modified an in-scope input, affected tests/reports become Stale and must be rerun. If outputs cannot be isolated, verify the protected inputs after testing. Video continues using source/project/timeline/render/output digest lineage, not a substitute Git hash.

Completion Guard examines binding, freshness, independent evidence class and signed trusted facts; it does not infer Coding correctness, Video aesthetics, or a model-reported pass. Unresolved effectful UNKNOWN that could alter the accepted source/output blocks completion.

## 9. Safety invariants and illegal combinations

1. An incomplete or invalid model response has no executable tool proposal.
2. One ModelStep has no more than one irreversible selected Attempt; later candidates cannot replace it.
3. A ToolInvocation has no physical launch without exact current Host gate authority.
4. A consumed ticket nonce never becomes launchable after restart.
5. An installed Host fence rejects the older epoch; revocation completion requires all eligible gates accounted for.
6. OutcomeUnknown is not FailedKnown; no automatic effectful retry, cutover or publish through a conflicting UNKNOWN.
7. One Task cannot have two Active PlanRevisions; no old revision may newly admit work after its barrier.
8. The summed outstanding financial exposure in hard-budget scopes never exceeds the reserved ceiling at admission.
9. No TaskCompleted without current required criterion evidence, final snapshot and relevant process convergence.
10. Inbox/Outbox replay cannot create a second authoritative selection, plan activation, completion or consumed launch token.
11. Coding/Video semantic judgments stay outside Kernel; Domain does not grant physical execution authority.

Forbidden pairs include: `Revoked + unacknowledged eligible Host`, `Completed + unresolved conflicting effectful UNKNOWN`, `Superseded Plan + new admitted old-plan write`, `HardBudgetAttempt + unbounded charge`, `Selected + incomplete candidate`, and `HostStarted + no matching durable LaunchAttempt` (except that missing facts after a crash are explicitly represented as OutcomeUnknown, not silently fabricated).

## 10. Reproducible traces and architecture gates

Each fixture must state initial durable facts, concurrent event order, injected fault, expected event sequence, final state and whether work may continue. Required families:

| Fixture | Expected safety property |
| --- | --- |
| Valid candidate while another Attempt hangs or usage is late | winner commits if all charge exposure remains bounded; other reservation persists |
| Host gate launch versus fence installation in both orders | launch-wins is in-flight; fence-wins rejects old nonce |
| Crash before nonce durable; after nonce durable; during spawn; after spawn before receipt | no replay; UNKNOWN unless non-execution or execution is proved |
| Duplicate/out-of-order Outbox dispatch and Host receipts | one authoritative disposition; conflicting facts held |
| Old-plan effectful UNKNOWN during structural cutover | conflicting new plan blocked; unrelated safe work remains scoped |
| Test creates cache or coverage while protected source unchanged | no spurious Stale |
| Test mutates protected config or verification script | Stale; affected checks rerun |
| Late invoice exceeds contracted maximum | enforcement hold, append-only adjustment, terminal Task not rewritten |
| Cancel request while child processes/write handles remain | no false ProcessConverged or Completion |
| Coding and Video use the same identity/admission/receipt/Completion envelope | no domain-specific branch in Kernel authority logic |

**G0 — documentation gate:** scope, event identity, transition tables, blocked combinations, pending ADP decisions and fixtures reviewed; no runtime claim.

**G1 — protocol feasibility gate:** deterministic state-machine and Inbox/Outbox replay fixtures, selection/budget liveness, concurrency traces. Requires separate experiment authorization.

**G2 — Host gate:** isolated single-Host launch/revocation/spawn-crash and process-tree evidence. Requires separate execution authorization.

**G3/G4 — domain vertical slices:** Coding and Video separately demonstrate quality, latency, cost, incorrect-completion and recovery behavior.

**G5 — reuse gate:** both domains use common Kernel authority contracts without domain semantics leaking into them.

Metrics and performance thresholds are set before benchmarking using observed baselines; no PASS is inferred from writing this document.

## 11. Architecture-review checklist

- Are any two documents still assigning the same authoritative transition to different components?
- Is each 'atomic' claim scoped to one actually shared transactional or serialized boundary?
- Does an unresolved UNKNOWN block only operations that conflict with its potential effects?
- Can an otherwise valid selected response proceed without awaiting unrelated invoices?
- Are protected input scope and verification output lineage disjoint and frozen?
- Is the L0/L1/L2 classifier tied to protected-field comparisons rather than model preference?
- Have single-Host and multi-Host promises been kept separate?
- Are ADP-03 through ADP-11 explicitly still OPEN until owner decisions?
