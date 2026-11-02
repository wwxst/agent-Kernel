# Lifecycle and state model

> **Status: Initial contract reconciled with a PROPOSED intelligent-execution model.** Existing Task/Turn/Step/ToolInvocation authority principles remain the baseline. PlanRevision, PlanStep, and evidence bindings are proposed additions pending owner review. Storage schemas and runtime transitions remain unimplemented and unverified.

## 1. Core entities

- **Session** — durable conversation and execution history boundary. Concurrent writers require explicit coordination.
- **Task** — durable unit of user intent, GoalContract, accepted plan, budget, execution, verification, and completion.
- **GoalContract** — versioned description of desired outcome, scope, exclusions, constraints, acceptance criteria, assumptions, and workspace binding. Orchestration proposes it; Kernel records the accepted task contract/version.
- **Turn** — one interaction cycle within a task/session; terminal outcomes are immutable.
- **PlanRevision** — immutable accepted version of the dependency-aware outcome plan. A PlanCandidate is not authoritative until Kernel accepts it.
- **PlanStep** — goal-level unit of work in an accepted PlanRevision, with dependencies, preconditions, expected artifacts, risk, and verification obligations.
- **Step** — one runtime execution unit, such as reconnaissance, planning, model invocation, tool batch, verification, or checkpoint work. It may belong to a PlanStep.
- **ModelStep** — one logical model decision point, potentially containing one or more Attempts. Planner, Explorer, Implementer, Debugger, and Verifier calls are all Kernel-managed ModelSteps.
- **ModelAttempt** — one actual provider request/attempt associated with a ModelStep.
- **ToolInvocation** — one uniquely identified proposed and admitted side-effect operation.
- **EvidenceReference** — a provenance-bound reference to repository observations, model/provider evidence, Host receipts, command outputs, tests, diffs, or artifacts. The EvidenceGraph is a projection, not an authority source.
- **VerificationReport** — evidence bound to a PlanRevision, acceptance criteria, workspace, environment, and actual verification runs.
- **Receipt** — authenticated Host evidence for a specific execution or workspace operation.

## 2. Plan and step semantics

A PlanCandidate contains a proposed PlanRevision and PlanStep dependency graph. Kernel validates identity, Task version, budget, scope, legal transitions, and required preconditions before accepting it.

An accepted PlanRevision is immutable. A change to objectives, dependencies, scope, criterion coverage, or execution strategy that changes the accepted plan requires a new revision with explicit rationale. Superseded steps retain their history and evidence.

Proposed PlanStep lifecycle:

Proposed → Accepted → Ready → Running → EvidenceReady → Verified

Alternative transitions include:

- Ready / Running → Blocked with a structured reason.
- Running → FailedKnown when trusted evidence proves the step failed.
- Blocked → Ready when the dependency or approval condition is resolved.
- Any non-terminal step → Superseded only through an accepted PlanRevision transition.
- EvidenceReady → Running when required verification fails and repair is authorized.

A PlanStep being Verified does not complete the Task. Task completion remains governed by the GoalContract's full acceptance criteria and Completion Guard.

## 3. Task lifecycle

The initial Task state vocabulary remains:

Created, Admitted, Planning, Ready, Running, Waiting, Blocked, Verifying, Cancelling, Reconciling, CompletionHold, Completed, Failed, Cancelled.

Waiting and Blocked carry structured reasons rather than multiplying top-level states. Candidate reasons include approval pending/rejected/expired/revoked, budget exhausted or unbounded settlement, unknown outcome, dependency not ready, user input required, lease unavailable, workspace conflict, verification failure, evidence conflict, budget overrun, and external dependency unavailable.

Typical transitions:

- Created → Admitted after identity, idempotency, task-envelope, and initial budget validation.
- Admitted → Planning while GoalContract and bounded reconnaissance context are established.
- Planning → Ready only after a PlanRevision is accepted. Bounded read-only reconnaissance may run before plan acceptance under a discovery admission profile.
- Ready → Running when at least one accepted PlanStep is ready and its execution preconditions hold.
- Running → Waiting / Blocked when an external condition prevents safe progress.
- Running → Verifying when required PlanSteps and acceptance evidence are ready for assurance.
- Verifying → Completed only when Completion Guard succeeds.
- Verifying → Running for an authorized bounded repair; → Planning for a new PlanRevision.
- Running → Cancelling after a durable cancellation intent; new model steps and admissions are blocked.
- Cancelling → Cancelled only when every admitted operation is known to have converged and no UNKNOWN remains.
- Cancelling → Reconciling when a started operation has not converged.
- Reconciling → Blocked when the outcome remains unknown; otherwise the system acts on the evidence, not an assumption.

Completed, Failed, and Cancelled are immutable terminal states. A late conflict does not rewrite the original terminal fact.

## 4. Runtime Step and ModelStep

A PlanStep is an outcome-oriented work item. A runtime Step is an execution unit used to carry out or verify that work item. A runtime Step may contain:

- one or more ModelSteps;
- one or more ToolInvocations;
- a tool batch or bounded experiment;
- evidence collection and projection;
- a verification run;
- a checkpoint candidate or compaction operation.

A ModelStep is one logical model decision point. A ModelAttempt is one actual provider request. Every cognitive purpose—reconnaissance, planning, implementation, debugging, verification, or summary—must use the same Kernel-managed ModelStep lifecycle.

A model response is only an ActionProposal candidate. It cannot advance PlanStep or Task state without the corresponding Kernel command and required evidence.

## 5. ToolInvocation lifecycle

Execution state and Approval state are separate dimensions.

Initial execution states:

Proposed, Validating, AwaitingApproval, Admitted, IntentPersisted, Dispatching, Running, CancelRequested, Reconciling, Succeeded, FailedKnown, Denied, CancelledBeforeStart, OutcomeUnknown, ReconciledNotExecuted, ReconciledSucceeded, ReconciledFailed.

Approval states:

NotRequired, Pending, Approved, Rejected, Expired, Revoked.

Approval is bound to the exact principal, task, PlanRevision/PlanStep, invocation, tool/version, canonical argument hash, policy version, workspace, target, requested capabilities, approver, expiry, and revocation version. Changing a bound value invalidates the approval.

## 6. Admission and execution barriers

Before dispatch, the trusted path validates:

1. Task / Turn / Step / PlanRevision / PlanStep / Invocation identity and ownership.
2. Complete parameters and schema.
3. Frozen tool definition and implementation identity for the current Step.
4. Principal, capability, policy, and approval versions.
5. Workspace identity/generation and fencing epoch.
6. Budget reservation.
7. Required sandbox and Host profile.
8. Durable Intent and a short-lived AdmissionTicket bound to the exact invocation and payload digest.

The model-visible tool schema is not an authorization token. The Host validates the ticket and current fencing/authorization conditions again before side effects.

## 7. Cancellation and UNKNOWN

Cancellation is a convergence protocol:

- Persist Cancel Intent.
- Stop new ModelSteps and new Tool Admissions.
- Invalidate pending approvals and undispatched admissions.
- Send cancellation to already dispatched work.
- Wait for started executions to converge.
- Collect receipts or classify the result as UNKNOWN.
- Only mark Cancelled when all started work has a trusted terminal result and no unresolved side effect remains.

A process kill, timeout, disconnected socket, or AbortSignal is not proof that an external side effect was undone.

UNKNOWN is not a synonym for failure. It requires reconciliation against Host Ledger, receipts, target-system state, and idempotency evidence. Keep ownership and relevant budget reservations while unresolved. Never blindly replay a non-idempotent invocation. The model cannot decide that an UNKNOWN tool call must have failed and retry it.

## 8. Recovery and immutable facts

- Stable invocation IDs, Host request IDs, idempotency keys, and payload digests survive retries and restart.
- Same ID + same digest returns the original result; same ID + different digest is a conflict and must be quarantined.
- Host receipt facts and Kernel state facts remain separate and are reconciled.
- A receipt persisted by Host but not yet projected into Kernel may be imported idempotently; the side effect is not re-executed.
- If evidence cannot prove whether a side effect occurred, retain OutcomeUnknown and block unsafe progress.
- Accepted PlanRevision, PlanStep progress, and checkpoint pointers are reconstructed from Kernel Journal, not model summaries.
- Context and EvidenceGraph projections are rebuilt from authoritative state and provenance-bound source references after restart.

Runtime state transitions, transaction behavior, and crash-recovery correctness remain **UNVERIFIED** until implemented and fault-injection tested.
