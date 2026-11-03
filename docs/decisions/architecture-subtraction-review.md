# Architecture subtraction and contract feasibility — convergence review (G0 proposal)

> **Status: PROPOSED / G0 NOT APPROVED / NO RUNTIME EXECUTED.** This is an architecture amendment to [Core protocol](../contracts/core-protocol.md) and the existing Domain contracts on Draft PR #1. It preserves the recorded owner approvals of ADP-01/02 and does not approve ADP-03–11. Its recommendations require owner/architect disposition before architecture freeze.

## 1. Non-negotiable product and safety boundaries

**One shared authoritative Kernel, two independent Domain Intelligence implementations (Coding and Video).** Coding must still autonomously understand a repository, plan, edit, debug, test, verify and iterate. Video must still take natural-language intent through source understanding, moment selection, NarrativePlan, TimelineRevision, render, independent output inspection and revisions; do not turn this into a metadata-only or manual editor. A single primary controller is enough for the baseline; multi-Agent is not a dependency.

Hard Kernel invariants remain: task identity and accepted intent; current authority/admission including Host revalidation; budget reservation and no unsafe unbounded hard charges; K-local durable Journal/Inbox/Outbox; trusted H-local nonce/LaunchAttempt and real execution facts; UNKNOWN reconciliation before conflicting action; correct final input/output/view evidence and Completion Guard. Neither L0 tactics nor context/model text can grant capabilities.

## 2. Minimal operational design — one main Agent Loop

One **Task Orchestrator** executes a single decision loop, choosing its cognitive mode **Strategic** (scope/plan), **Tactical** (next tool/repair), or **Assurance** (criterion evidence and completion). These are **purposes of a decision**, not three running agents, three independently scheduled loops, three mutable state machines or a ControlProposal arbitrator. The one controller follows the priority order: safety/cancel/fence → conflicting UNKNOWN/recovery → new user intent/approval → required evidence/repair → structural replanning → ordinary next operation → delivery.

A typical iteration is:

1. Read the latest accepted GoalContract/active PlanRevision and the **small relevant context**; recheck current bindings before authority-changing action.
2. Choose a purpose/mode based on the current blocker, evidence gap or ready PlanStep. A strategic decision is revisited at milestones or real invalidation, not after every minor command.
3. Run at most one selected ModelStep decision (with attempts/retries as needed). A complete selected response yields an immutable **decision/action-intent envelope** with bounded proposal items; it is **not** a second executable lifecycle.
4. For each effectful item, commit a ToolInvocation + admission/budget/durable intent in K; dispatch to H only via the trusted path. Read-only discovery still uses the bounded discovery authority; no silent bypass.
5. Collect authenticated facts; update the domain projection and criterion references; continue tactical repair or switch to assurance when evidence is sufficient. Completion Guard alone commits Completed.

No extra per-mode durable loop state is required. Tasks may wait on user approval/UNKNOWN and still resume with the same controller. Keep the richer domain strategies as **optional internal policies**, to be measured against a simpler loop under identical safety budgets.

## 3. State authority and reduced concurrency contention

| Canonical authority | Authoritative writes / identity | Do not duplicate as a separate machine |
| --- | --- | --- |
| **Kernel TaskControl** | Accepted GoalContract and active PlanRevision pointer, task cancellation, terminal completion, top-level plan switch barrier; `taskControlVersion` | UI labels Planning/Ready/Running/Verifying/Waiting are **derived phase views**, not independent locks/commit authorities |
| **Kernel ModelStep** | Attempt IDs, durable candidate ordering and one irreversible selection, delivery Outbox; `modelStepVersion` | No separate selection controller in Domain |
| **Kernel ToolInvocation** | proposal-item binding, per-invocation admission, budget hold, intent, logical execution/reconciliation projection; `invocationVersion` | No ActionProposal lifecycle with parallel Executing/Settled states |
| **Trusted Host** | nonce consumption, Host launch/fence, OS process identity, receipts, physical result and target facts; Host Ledger sequence | Kernel does **not** claim authority over physical Started/result without Host evidence |
| **Kernel Budget scope** | hard limits, reservations, provisional/final settlement, enforcement holds; `budgetScopeVersion` | No financial re-accounting through Task-control CAS |
| **Domain evidence/plan progress** | immutable evidence, artifact refs, PlanStep work/verification **projections** derived from trusted events and plan obligations | No second authoritative EvidenceGraph DB or verification lifecycle |
| **Kernel Completion** | Guard decision + TaskCompleted (once) against current input/plan/evidence fence | No model/verifier self-declared terminal state |

**Concurrency rule:** routine ModelStep, Attempt, ToolInvocation, Host receipt import, budget settlement and evidence append **must not require equality of a single global Task aggregate version**. Use a stable command/idempotency ID, owning aggregate version/CAS and a **selective binding vector** consisting of only relevant GoalContract/PlanRevision epoch, current authority/fence, workspace/project generation, tool digest, budget-reservation version and specific dependency/read-set versions. K admission reads/verifies the relevant version vector and commits the Invocation/Intent/Outbox/budget hold atomically **within K**. A non-conflicting receipt or accounting adjustment must not invalidate an unrelated model response or tool proposal just because the global Journal sequence advanced.

The Task control CAS **remains mandatory** for structural plan cutover, changed accepted intent, cancellation and terminal completion. Journal sequence is a durable total-order audit cursor, not an optimistic concurrency token required by every action. Workspace generation changes invalidate actions that really depend on that snapshot, not unrelated read-only work proven safe. Separate budget authority versions protect funding scopes; overlapping operations still use conflict fencing at Host.

## 4. Architecture subtraction decisions

| Mechanism | Disposition | Narrow binding / rationale |
| --- | --- | --- |
| Shared minimal Kernel + per-Invocation Admission | **MUST KEEP** | unique trusted authority for plan/permission/budget/terminal transitions |
| Trusted ToolHost, nonce, local fence ACK, Host Ledger, UNKNOWN | **MUST KEEP** | no external atomic-spawn fiction; no unsafe replay |
| Kernel Journal + Inbox/Outbox in K-local commits | **MUST KEEP** | replay and crash correctness; O and H remain separate durable owners |
| Completion Guard, immutable source **plus effective execution view** and video output evidence | **MUST KEEP** | no false completion from overlay shadowing or model self-report |
| Hard-budget MaximumChargeCertificate | **MUST KEEP** where hard mode is promised | otherwise explicit opt-in soft mode |
| One primary autonomous controller | **SIMPLIFY** | Strategic/Tactical/Assurance are decision modes; no ControlProposal state machine |
| PlanRevision | **SIMPLIFY** | only L2 structural plan changes create a new revision; L0 tactic and L1 rework preserve plan |
| PlanStep | **SIMPLIFY** | outcome/dependency/criterion binding and event-derived work/verdict views; do not mirror Task and Invocation statuses |
| ActionProposal | **SIMPLIFY** | bounded immutable selection/intent envelope; no Recorded→Executing→PartiallyExecuting→Settled authority machine; child invocations own their outcomes |
| EvidenceGraph | **SIMPLIFY** | optional index over immutable `EvidenceRef`, typed claim/criterion bindings and provenance/freshness. A graph database, mandatory edge catalog or independently mutable freshness ledger is not required |
| Context Engine | **SIMPLIFY** | one lazy context assembler with Planning/Execution/Verification **views**, no three running context services; checkpoint at meaningful milestone/size/recovery trigger |
| Tool scheduling | **SIMPLIFY** | sequential default; optional bounded parallel reads or enforceably disjoint operations; no global speculative DAG scheduler needed for baseline |
| Physical topology, global multi-Host linearization, autonomous loop benefit, provider/OS enforcement | **EXPERIMENT REQUIRED** | no "PASS" from documentation or reference-project analogy |

The **minimum evidence interface** is `EvidenceRef(id, sourceKind, immutableSourceRef, digest, scope, capture/version, trustClass)` plus `CriterionEvidenceBinding(criterionId, evidenceRefs, declaredRequiredClass, verdict, freshnessBasis)`. Domain claim annotations, hypotheses and supports/refutes indexes are optional projections, never replacements for raw Host receipts or domain verification and never another source of authority. No forced migration of existing historical records is implied.

**Action-intent minimum:** `decisionId`, selected ModelStep/Attempt and response digest, accepted Goal/Plan bindings (when needed), relevant snapshot/authority/read-set digests, bounded tool item IDs and canonical arguments. Recorded with/preceding child admission in K, or referenced to an already committed selected ModelStep. Item outcomes are **derived from ToolInvocation IDs**; one failed item does not create an ActionProposal-wide settlement transaction. Non-tool Ask/Wait/Stop are ordinary Orchestration/Kernel commands with durable IDs only when they change a persisted state or user-visible obligation.

**Context/checkpoints:** cached context may be dropped/reassembled from authoritative source references at any time. Store source IDs, provenance, freshness basis and required UNKNOWN/approval/budget holds. Summaries and memory are not approval evidence. Checkpoints are optional performance artifacts created on meaningful milestone/compaction/recovery threshold, never prerequisites to every step; K commits a checkpoint fact/journal cursor but ordinary admissions do not CAS against the checkpoint pointer.

## 5. P0 contract feasibility remains intact

- **Revocation:** `K.RevocationRequested` immediately stops new K admission/tickets; H may still launch a previously valid ticket before `H.HostFenceInstalled`. H locally serializes validation/nonce/spawn/fence. `K.Revoked` only after all eligible Host ACK/disablement. Missing live proof fails closed. Host unavailability cannot be inferred safe.
- **Transactions:** K Task/Invocation/Journal/Outbox/CommandInbox writes are K-local; O Inbox/CommandPlan is O-local; H nonce/LaunchAttempt/HostLedger is H-local; OS spawn is non-transactional. Intent committed before dispatch → replay original Outbox; H executed without K receipt → retransmit original H receipt or preserve UNKNOWN.
- **Coding verification:** SourceSnapshot digest plus Host-authenticated effective ExecutionViewManifest (mounts, overlays, symlinks, actual protected inputs and in-run enforcement); Completion blocks mismatches even if lower immutable snapshot hash remains unchanged.
- **Video verification:** complete independent output evidence and Timeline/RenderJob provenance remain required.

## 6. Explicit remaining feasibility risks

1. **Host grant liveness and check/spawn TOCTOU:** no OS-level proof yet that local gate and process creation are indivisible with respect to fence installation; H ledger/spawn crash windows remain UNKNOWN.
2. **Selective version read-set:** concrete K storage must demonstrate atomic validation of Plan/Authority/Workspace/Budget across independent aggregates without bypassing a revocation; use a narrower transaction or explicit fences, **not** an unproven distributed read.
3. **Read-only effective execution view:** first prove sealed readonly source and isolated writable output mounts on target OS and toolchains; reject overlay/symlink shadowing. Unavailable sandbox means Unverified; full per-file tracing remains optional experiment.
4. **Provider ambiguous submission + hard maximum:** HTTP ACK loss or Gateway crash may leave accepted/billable request UNKNOWN. Without qualified Provider execution-and-invoice idempotency, no resend; original budget held. Hidden fees/server retries/pricing may separately invalidate Hard Budget.
5. **PlanStep/ActionProposal migration:** past lifecycle records remain historical; conversion to projections must preserve auditability and avoid changing in-flight semantics.
6. **Parallel scheduling:** only enable after conflict and process-handle containment fixtures; no speculative parallel writes by default.
7. **Cognitive quality:** a simpler loop may be insufficient for coding/debugging or video narrative; preserve richer *Domain* methods and measure their incremental value rather than deleting capabilities.

### G0 refinement: Provider ambiguous send and minimal Host policy

**MUST KEEP:** K-local ModelAttempt admission + maximum reservation + Outbox; G durable `SendMayHaveOccurred` before any external request bytes; one immutable Attempt/request identity, truthful ProviderOutcomeUnknown, **no unqualified automatic resend** on ACK loss/timeout/crash, billing exposure held until trusted settlement. A separately submitted Provider execution always gets a new Attempt and independently reserved budget; qualifying an identical idempotent transport replay requires Provider **execution and charge** deduplication, not an SDK header.

**MUST KEEP:** Host local Fence ordering; distinct K RevocationRequested, H HostFenceInstalled and K Revoked; grant expiry enforced inside physical launch critical section. **SIMPLIFY:** R0 read-only / R1 reversible isolated / R2 destructive or externally irreversible risk policy; default-disable R2 until Owner chooses a proven acceptable race window or stronger verified protocol. Do not assert instant revoke from a signed TTL alone.

**SIMPLIFY:** Coding verification Host uses a **sealed read-only SourceSnapshot** as actual process input with disjoint writable build/test output mounts, restricted symlinks/remounts and authenticated execution view. **EXPERIMENT REQUIRED:** platform/OS proof for readonly enforcement and toolchain compatibility. A full file-open mutation tracer is a separately reviewed fallback, not mandatory baseline; an unsupported toolchain cannot fabricate Passed evidence.

**EXPERIMENT REQUIRED:** G1 K/G send-marker and acceptance/ACK/retry/cost cases M1–M6; G2 expiry/high-risk/fence and sealed-view cases R5–R7/S1–S3. All remain NOT RUN. Owner choices for grant lifetime/risk exceptions and Provider capabilities remain OPEN (see [Open decisions](open-decisions.md)); no design acceptance is implied.

## 7. G0–G5 gates and review status

| Gate | Deliverable / proof | Status |
| --- | --- | --- |
| **G0** | Resolve this proposal, minimized state authority, selective-version admission, Host fence/P0 view/transaction contracts, ADD/KEEP/EXPERIMENT dispositions and ADP dependencies | **OPEN / NOT APPROVED** |
| **G1** | Deterministic K/G Provider admission, durable send marker, ACK loss/crash/qualifying dedup or no-retry, new Attempt budget isolation and K/H transactional traces M1–M6 | **NOT RUN** |
| **G2** | Host local gate/fence/expiry and risk policy R5–R7, enforced sealed read-only verification sandbox / isolated outputs S1–S3, process/UNKNOWN reconciliation | **NOT RUN** |
| **G3** | Coding full autonomous repair/verify loop, simple vs richer policy quality/cost/latency under equal limits | **NOT RUN** |
| **G4** | Video full autonomous edit→render→inspect→revise loop, blind content review, latency/cost/recovery | **NOT RUN** |
| **G5** | Shared Kernel contract reuse for Coding and Video without cross-domain semantic authority | **NOT RUN** |

No thresholds or successful experiments are invented. ADP-03–11 remain OPEN; ADP-01/02 retain their recorded REVISED/APPROVED status. This document does not authorize Runtime work, merge or freeze.

## 8. Role-separated adversarial review and construction simulation — 2026-11-03

**Design passes:** Runtime, performance/Token, Coding, Video, domain extension and security/reliability concerns were assessed against the existing one-loop + K/G/H, immutable SourceSnapshot, Host fence and budget-certificate contracts. Recommend preserving these safety invariants while minimizing mandatory model stages, read-set contention, repeated context and fixed Verifier overhead; add [Extension v0.1](../contracts/domain-extension.md), bounded terminal protocol and [Stage 9](../development/roadmap.md). This is a role-separated analysis of the documentation, **not a claim that separate external reviewers or executable sub-agent workers signed off**.

**Counterexample-driven pass, distinct from design criteria:**

| Counterexample | Required guard; adversarial test |
| --- | --- |
| Agent-written test green; semantic bug remains | Independent criterion oracle or required fresh reviewer, never self-report as PASS; C-01/C-03 |
| Incremental context omitted modified test/config | Protected read-set plus actual sealed source execution view; C-05/C-06 |
| Bounded parallel reads have different source generation | Same immutable source version or reject/refetch; shared CAS and C-08 |
| Timeout during live render descendant writes | Separate H process/handle convergence vs Task failure + UNKNOWN hold; V-04 |
| Provider timeout after possible send | G-local SendMayHaveOccurred, cost hold and no blind retry; M1–M6 |
| Office provider edit ACK lost or OAuth permission revoked | Exact revision/status reconciliation and reauthorization, no Office-specific Kernel status; X1–X8 |
| Completing after TaskControl cancellation wins CAS | Guard rereads protected versions under K transaction and loses; terminal race fixture |

**Construction simulation (document-only):** K-00–K-06 have explicit required ports and event/transaction owners; Coding C-01/C-02 bind patch, SourceSnapshot and executed test evidence; Video V-01–V-03 bind exact source, timeline, render staging and inspected output; Office X-01 maps scoped external API edit/etag/UNKNOWN without changing Kernel Loop/TaskControl/Host. These are reviewable paper traces, not implemented unit tests or actual external verification. **B0–B6 remain blocker candidates and G0/G1–G5 status unchanged**.

**Iteration bound:** one focused design repair and one reverse-review/cross-document scan; unresolved owner choices are escalated instead of endlessly redesigning. Benchmark hypotheses remain unverified and no P0/P1 is marked resolved absent its specified proof.
