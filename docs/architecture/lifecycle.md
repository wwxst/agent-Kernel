# Lifecycle and state model

> **Status: PROPOSED cross-domain lifecycle contract.** This document aligns Task, DomainBinding, GoalContract, PlanRevision, PlanStep, runtime Step, ModelStep, Attempt, and ToolInvocation semantics for Coding and Video Editing. Runtime transitions, transaction behavior, and crash recovery remain unimplemented and unverified. See [PlanRevision and PlanStep lifecycle contract](../contracts/plan-revision.md) and [Domain Workflow contract](../contracts/domain-workflow.md).

## 1. Core entities

- **Session** — durable conversation and execution-history boundary.
- **UserIntent** — immutable original user request plus append-only clarification references. It is never replaced by a model-generated GoalContract.
- **Task** — durable unit of user intent, one active DomainBinding, accepted GoalContract, active plan, budget, execution, verification, and completion.
- **DomainBinding** — immutable domain ID and Workflow Profile/schema/policy version snapshot bound to a Task; it is not a permission grant.
- **Workflow Profile** — versioned composition of domain schemas, context projections, tool snapshots, resource limits, and verification obligations.
- **GoalContract** — immutable accepted version of desired outcome, scope, exclusions, constraints, acceptance criteria, assumptions, risk, DomainBinding, and typed domain payload. Orchestration proposes; Kernel records acceptance after deterministic checks and required confirmation evidence.
- **Turn** — one interaction cycle within a Task/Session.
- **PlanRevision** — immutable accepted version of the dependency-aware outcome plan. It moves through Proposed, AcceptedPendingCutover, Active, Superseding, Superseded, or Rejected.
- **PlanStep** — outcome-oriented work unit in one PlanRevision. WorkStatus and VerificationStatus are separate dimensions.
- **Step** — runtime execution unit such as reconnaissance, planning, model invocation, tool batch, verification, or checkpoint work.
- **ModelStep** — one logical model decision point, potentially containing one or more Attempts. Planner, Explorer, Implementer, Debugger, Verifier, and summary calls all use this lifecycle.
- **ModelAttempt** — one actual provider request associated with a ModelStep.
- **ActionProposal** — durable typed decision record from Orchestration; not an authorization or execution ticket.
- **ToolInvocation** — uniquely identified proposed/admitted side-effect operation, independently authorized and reconciled.
- **EvidenceReference** — provenance-bound reference to repository or media observations, provider evidence, Host receipts, command outputs, tests, diffs, timelines, renders, or artifacts.
- **EvidenceGraph** — Context/Orchestration projection over claims, evidence, and explicit relations; not an authority ledger.
- **DomainArtifact** — immutable, digest-bound artifact with domain schema, profile, provenance, and lineage; payload remains domain-specific.
- **MediaProject** — persistent Video-domain artifact container grouping source assets, analysis, timelines, renders, and reports; it is not Kernel execution authority.
- **TimelineRevision / RenderJob** — Video-domain artifact and long-running execution records governed by the shared artifact/ToolInvocation/Host contracts.
- **VerificationReport** — criterion-to-evidence report bound to GoalContract, PlanRevision, workspace, environment, and actual verification runs.
- **Receipt** — authenticated Host evidence for a specific execution or workspace operation.
- **Checkpoint** — immutable task-progress snapshot; readable as historical progress independently of whether the authorizations recorded at checkpoint time are still current.

## 2. GoalContract lifecycle

The original UserIntent and clarifications are immutable references. Orchestration proposes a GoalContract candidate; Kernel checks schema, provenance, version lineage, protected-field changes, and required user-confirmation references. Kernel does not decide semantic fidelity.

Proposed lifecycle:

Candidate → NeedsClarification | ReadyForAcceptance → Accepted → Superseded

Rejected candidates remain auditable as Rejected. Accepted versions are immutable. Material changes to desired behavior, scope, exclusions, required criteria, constraints, public compatibility, risk, or external/destructive effects require explicit user confirmation unless an immutable intake-time authorization record explicitly covers the exact change. Low-risk, reversible, disclosed assumptions may be accepted autonomously only when task policy permits and they do not expand scope or alter criteria.

An accepted GoalContract change that affects scope, criteria, or authority triggers the PlanRevision switch protocol. Old evidence remains historical; a VerificationReport bound to the old GoalContract cannot complete the new version.

## 3. PlanRevision and PlanStep

A PlanCandidate is semantically authored by Orchestration. Kernel validates it as a deterministic contract: schema, Task/GoalContract/version bindings, unique IDs, acyclic DAG, valid references, criterion-ID mapping, scope and capability envelope, budget/verification reserve, workspace snapshot, declared preconditions/effects/evidence, and legal transition. Kernel does not judge technical quality or semantic sufficiency.

PlanRevision states:

Proposed, AcceptedPendingCutover, Active, Superseding, Superseded, Rejected.

At most one revision is Active per Task. A revision in AcceptedPendingCutover is not executable. Replanning uses a freeze → drain → reconcile → refresh → validate → atomic activate protocol. The old revision stops accepting new work when the switch barrier linearizes. Undispatched invocations are cancelled/revoked; dispatched invocations drain and return receipts. Conflicting UNKNOWN outcomes block activation. A candidate based on a stale workspace generation must be refreshed or regenerated. Full transition and concurrency semantics are in the linked PlanRevision contract.

### 3.1 PlanStep work state

NotStarted, Ready, Running, Blocked, Completed, Superseded.

### 3.2 PlanStep verification state

NotRequired, Pending, Running, Passed, Failed, Stale, Inconclusive.

The two dimensions are independent. WorkStatus=Completed and VerificationStatus=Failed is valid. ToolInvocation or ModelAttempt FailedKnown is not a PlanStep failure. Repair uses an explicit rework event and preserves prior artifacts/reports. Evidence invalidation moves a previously Passed verification to Stale. Superseded steps are immutable and cannot be reactivated in place; a new revision may create a new step with explicit lineage/carry-forward references.

A PlanStep being Completed or Passed does not complete the Task. Task completion is based on the full GoalContract and Completion Guard.

## 4. Task control and derived operating phases (architecture subtraction PROPOSED)

**TaskControl is the only Task-level transition authority.** K persists accepted intent/GoalContract, current active PlanRevision, structural switch barrier, cancellation intent and terminal completion under `taskControlVersion`. Task presentation labels (`Planning`, `Ready`, `Running`, `Verifying`, `Waiting`, `Blocked`, `Reconciling`, `CompletionHold`) are **derived from these facts, open approvals/UNKNOWN, plan/evidence conditions and active Invocations**; they are not independently CAS-locked state machines. Existing historical Task state labels remain readable as projections/events and are not retroactively rewritten.

Task creation/admission, accepted Goal/structural Plan cutover, cancellation and Completed/Failed/Cancelled terminal facts require TaskControl authorization/CAS. A plan switch fences new old-plan admissions, drains/reconciles conflicting work, then atomically changes the active Plan pointer. A recovery hold does not erase the last legal TaskControl state. Terminal states never reopen; late evidence creates a separate hold or remediation task.

**Minimal version scope:** `taskControlVersion` changes on structural goal/plan/cancel/terminal transitions only. A normal ModelAttempt result, ToolInvocation/Host Receipt, per-Invocation approval, budget adjustment, checkpoint or evidence update **must not** advance TaskControl solely because it occurred. Such operations use their own owning-aggregate version and relevant Goal/Plan/Authority/Workspace/Budget binding checks at admission. The Journal append sequence remains the global audit order, not a lock on all task progress.

## 5. Main loop, ModelStep and action intent

A single **primary Task Orchestrator** cycles through Strategic, Tactical or Assurance *decision purposes*. They are not parallel controllers with separate lifecycles. Each iteration selects relevant context, a bounded decision, ToolInvocations admitted one by one where required, ingests receipts, updates domain evidence and loops until an authorized completion, safe wait or escalation.

`ModelStep` is one logical provider decision and `ModelAttempt` is a concrete request. The Kernel owns winning response selection; the model output is **not** tool authority. `ActionProposal` is a **bounded immutable decision/action-intent envelope**, with selected ModelStep/Attempt ID, canonical item digests and only relevant Goal/Plan/Workspace/Authority/Tool bindings. It has **no authoritative Recorded→Selected→Executing→PartiallyExecuting→Settled lifecycle**. Historical proposal events remain auditable; live item progress derives from child ToolInvocation outcomes. An internal exploratory thought or user-facing explanation does not require a new ActionProposal object. Each persisted effectful child still has a durable identified proposal/decision origin and separate Admission.

## 6. ToolInvocation and single Host physical authority

A ToolInvocation has one **Kernel logical lifecycle**: proposed/awaiting required approval → admitted and durably intended → dispatch pending → running/known terminal or OutcomeUnknown → reconciled when evidence suffices. The richer legacy status labels are allowed as **projections** over stable state and events; do not introduce a second authoritative scheduler/ActionProposal/Host-run lifecycle for the same operation.

Approval is an independent *permission fact* (not an Invocation execution state) bound to exact principal, Invocation, selected tool/arguments, Plan, target scope and expiry. A single approval within current plan scope is not structural L2. Trusted ToolHost owns physical nonce, launch/fence, process/descendants/handles, Host Ledger and authenticated receipts. Kernel cannot declare Started or ReconciledSucceeded from model assertions or an absent Host receipt.

## 7. Admission, bounded scheduling, and execution barriers

**Default one-at-a-time execution.** Optional parallel read-only or demonstrably isolated/disjoint operations require a declared bounded conflict policy; overlapping writes, Git/package manager, broad builds, render publication and unknown effect scopes serialize. No global speculative task DAG scheduler is required for the first implementation. The plan's dependency DAG describes **engineering outcomes**, not automatically a scheduler for every command.

Kernel Admission checks complete tool arguments/schema, immutable tool snapshot, active Plan/Step and selective read-set, current authority/grants/approval, workspace generation, budget reservation, conflict policy and durable intent. In **one K-local transaction**, validate the relevant read-set and commit Invocation admission + budget hold + Journal + Dispatch Outbox. No unrelated TaskControl CAS. Host rechecks current *Host-installed* effective fence/authorization at physical spawn under a serialized gate. Tool schemas, Context and ActionProposal do not grant permission.

## 8. Cancellation, cutover, and UNKNOWN

Cancellation and plan switching are convergence protocols, not flags.

- Persist cancellation or PlanSwitch Intent in the Kernel Journal.
- Stop new ModelSteps/admissions for the affected task/revision.
- Invalidate pending approvals and undispatched admissions.
- Request cancellation/drain for already dispatched work.
- Collect authenticated receipts and wait for process/descendant convergence.
- Classify unresolved outcomes as UNKNOWN; do not assume failure.
- Reconcile UNKNOWN against Host Ledger, receipts, target state, and idempotency evidence.
- Do not activate a conflicting new plan or replay a non-idempotent invocation while a potentially conflicting UNKNOWN remains.

A timeout, process kill, disconnected socket, or AbortSignal does not prove rollback. The model cannot waive reconciliation.

## 9. Recovery and immutable facts

- Stable invocation IDs, Host request IDs, idempotency keys, and payload digests survive retry and restart.
- Same ID + same digest returns the original result; same ID + different digest is quarantined as a conflict.
- Host receipt facts and Kernel state facts remain separate and are reconciled.
- A Host-persisted receipt may be imported idempotently; the side effect is not re-executed.
- Accepted GoalContract/PlanRevision, PlanStep state, and checkpoint pointers are reconstructed from Kernel Journal, not model summaries.
- Checkpoint integrity and historical readability do not depend on old approvals or leases remaining valid.
- On recovery, current identity, policy, capabilities, approvals, budget, lease/fencing, tool snapshot, and workspace state are reloaded and checked before any new execution.
- Context and EvidenceGraph projections are rebuilt from authoritative state and provenance-bound sources.

Runtime state transitions, transaction atomicity, and crash-recovery correctness remain UNVERIFIED until implemented and fault-injection tested.


## 10. Domain binding and typed artifacts

The unified platform binds each Task to exactly one domain and one immutable Workflow Profile version at a time.

- Coding Tasks load RepositoryModel and Coding-specific GoalContract/PlanStep/evidence schemas.
- Video Editing Tasks load MediaProjectModel and Video-specific GoalContract/PlanStep/evidence schemas.
- GoalContract and PlanRevision retain common lifecycle, version, authority, and provenance envelopes. Their domain payloads are typed and versioned.
- Kernel validates schema/version bindings, graph structure, scope, capabilities, budgets, legal transitions, and artifact references. Domain Intelligence remains responsible for semantic adequacy.
- Domain tools use the same ToolInvocation, policy/approval, resource reservation, Host receipt, cancellation, UNKNOWN, and recovery path.
- Cross-domain artifacts may be linked by immutable references. A Task does not silently change domain, and the first platform scope does not include composite cross-domain autonomous workflows.

Video TimelineRevision and RenderJob contracts are specified in [Media Timeline](../contracts/media-timeline.md) and [RenderJob](../contracts/render-job.md). These are domain extensions over the common artifact and execution envelopes, not separate Kernel authorities.

## 11. Terminal correctness and bounded waiting — first-slice amendment (PROPOSED)

The existing Task terminal enum remains `Completed | Failed | Cancelled`; a time limit is recorded as `Failed(reason=DeadlineExceeded)`, not an extra Task authority state. `Waiting/Blocked/Reconciling` are **derived nonterminal views** with durable reason, owner, next wake-up, deadline and reconciliation reference. A Task may stop autonomous decisions while a Host/Provider incident stays unresolved; a terminal `Failed(reason=UnresolvedEffect)` must **not** assert physical failure or that all effects converged. Its unresolved-effect record keeps conflicting targets fenced and is reconciled separately; TaskControl is not reopened by late facts. For Completed, all required process/evidence convergence must still be proven.

Every user/cancel/timeout event is persisted once under TaskControl CAS. Cancel acceptance stops model/new admissions and initiates H fencing; a cancel request alone never commits physical convergence. Deadlines and progress budgets cannot create unlimited retries. Each parked state has an explicit wake source, owner and escalation/max-wait policy; a continuously rescheduled identical model response or repeated tool result is not progress. Implementation must test races among completed Guard, cancellation, deadline, Host receipt, and terminal CAS: exactly one terminal fact wins and other facts are preserved as late evidence. See [Core protocol §12](../contracts/core-protocol.md), [Domain Extension §4](../contracts/domain-extension.md).
