# Lifecycle and state model

> **Status: PROPOSED second-round lifecycle contract.** This document aligns Task, GoalContract, PlanRevision, PlanStep, runtime Step, ModelStep, Attempt, and ToolInvocation semantics. Runtime transitions, transaction behavior, and crash recovery remain unimplemented and unverified. See [PlanRevision and PlanStep lifecycle contract](../contracts/plan-revision.md) for the normative cutover protocol.

## 1. Core entities

- **Session** — durable conversation and execution-history boundary.
- **UserIntent** — immutable original user request plus append-only clarification references. It is never replaced by a model-generated GoalContract.
- **Task** — durable unit of user intent, accepted GoalContract, active plan, budget, execution, verification, and completion.
- **GoalContract** — immutable accepted version of desired outcome, scope, exclusions, constraints, acceptance criteria, assumptions, risk, and workspace binding. Orchestration proposes; Kernel records acceptance after deterministic checks and required confirmation evidence.
- **Turn** — one interaction cycle within a Task/Session.
- **PlanRevision** — immutable accepted version of the dependency-aware outcome plan. It moves through Proposed, AcceptedPendingCutover, Active, Superseding, Superseded, or Rejected.
- **PlanStep** — outcome-oriented work unit in one PlanRevision. WorkStatus and VerificationStatus are separate dimensions.
- **Step** — runtime execution unit such as reconnaissance, planning, model invocation, tool batch, verification, or checkpoint work.
- **ModelStep** — one logical model decision point, potentially containing one or more Attempts. Planner, Explorer, Implementer, Debugger, Verifier, and summary calls all use this lifecycle.
- **ModelAttempt** — one actual provider request associated with a ModelStep.
- **ActionProposal** — durable typed decision record from Orchestration; not an authorization or execution ticket.
- **ToolInvocation** — uniquely identified proposed/admitted side-effect operation, independently authorized and reconciled.
- **EvidenceReference** — provenance-bound reference to repository observations, provider evidence, Host receipts, command outputs, tests, diffs, or artifacts.
- **EvidenceGraph** — Context/Orchestration projection over claims, evidence, and explicit relations; not an authority ledger.
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

## 4. Task lifecycle

Task states:

Created, Admitted, Planning, Ready, Running, Waiting, Blocked, Verifying, Cancelling, Reconciling, CompletionHold, Completed, Failed, Cancelled.

Waiting and Blocked carry structured reasons. Typical transitions:

- Created → Admitted after identity, idempotency, task-envelope, and initial-budget validation.
- Admitted → Planning while GoalContract and bounded reconnaissance are established.
- Planning → Ready after the first PlanRevision becomes Active.
- Ready → Running when at least one accepted PlanStep is ready and its preconditions hold.
- Running / Verifying / Ready / Waiting / Blocked → Planning on a valid replan request; Kernel linearizes a plan-switch barrier and freezes new admissions against the old revision.
- Planning → Reconciling when a started old-revision invocation has an unresolved outcome that may conflict with cutover.
- Reconciling → Planning after the relevant outcome is reconciled.
- Planning → Ready after the new PlanRevision is atomically activated.
- Planning → Running only when a switch is explicitly aborted and the old revision is safely restored as Active.
- Running → Verifying when required work/evidence is ready for assurance.
- Verifying → Running for authorized bounded repair under the same valid plan.
- Verifying → Planning when the plan or criterion coverage must change.
- Running → Waiting / Blocked when an external condition prevents safe progress.
- Running → Cancelling after durable cancellation intent; new ModelSteps and admissions are blocked.
- Cancelling → Cancelled only when all admitted operations are known to have converged and no UNKNOWN remains.
- Cancelling → Reconciling when started work has not converged.
- Reconciling → Blocked when outcome remains unknown; otherwise resume only through a current legal transition.
- Non-terminal states may enter CompletionHold when conflicting evidence blocks safe completion.

Completed, Failed, and Cancelled are immutable terminal states. A late conflict does not rewrite a terminal fact; use a post-terminal evidence hold and separately authorized RemediationTask where required.

## 5. Runtime Step, ModelStep, and ActionProposal

A PlanStep is an outcome. A runtime Step is an execution unit used to carry out or verify it. A runtime Step may contain one or more ModelSteps, ToolInvocations, evidence collection, a verification run, or checkpoint work.

A ModelStep is one logical model decision point; ModelAttempt is one actual provider request. Every cognitive purpose uses the same Kernel-managed ModelStep lifecycle. A model response is only an ActionProposal candidate.

An ActionProposal binds Task aggregate version, UserIntent/GoalContract, active PlanRevision/PlanStep, workspace generation, tool snapshot, preconditions, bounded proposal items, effect/risk, dependencies, expected outputs, evidence obligations, and expiry. It is recorded before child invocation admission. It may be partially executed; it is never atomic. Every ToolInvocation has independent admission, approval, budget, durable intent, Host receipt, and outcome. A changed Task/plan/workspace/tool/policy binding expires or supersedes the proposal. Full semantics are in design.md and the plan/action contracts.

## 6. ToolInvocation lifecycle

Execution state and Approval state are separate dimensions.

Execution states:

Proposed, Validating, AwaitingApproval, Admitted, IntentPersisted, Dispatching, Running, CancelRequested, Reconciling, Succeeded, FailedKnown, Denied, CancelledBeforeStart, OutcomeUnknown, ReconciledNotExecuted, ReconciledSucceeded, ReconciledFailed.

Approval states:

NotRequired, Pending, Approved, Rejected, Expired, Revoked.

Approval is bound to exact principal, Task, PlanRevision/PlanStep, ActionProposal item, invocation, tool/version, canonical argument hash, policy version, workspace, target, requested capabilities, approver, expiry, and revocation version. Changing a bound value invalidates approval.

## 7. Admission and execution barriers

Before dispatch, the trusted path validates:

1. Task / Turn / Step / ModelStep / PlanRevision / PlanStep / ActionProposal / Invocation identity and ownership.
2. Complete parameters and schema.
3. Frozen tool definition and implementation identity.
4. Principal, capability, policy, and approval versions.
5. Workspace identity/generation and fencing epoch.
6. Budget reservation and verification reserve.
7. Required sandbox and Host profile.
8. Durable intent and a short-lived AdmissionTicket bound to exact invocation and payload digest.

The model-visible tool schema is not an authorization token. The Host validates the ticket and current fencing/authorization conditions again before side effects.

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
