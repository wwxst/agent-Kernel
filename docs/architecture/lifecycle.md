# Lifecycle and state model

> **Status: Initial contract summary.** State semantics are adopted from the approved V2.1.2 baseline; storage schemas and runtime transitions remain unimplemented and unverified.

## 1. Core entities

- **Session** — durable conversation and execution history boundary. Concurrent writers require explicit coordination.
- **Task** — durable unit of user intent, plan, budget, execution, verification and completion.
- **Turn** — one interaction cycle within a task/session; terminal outcomes are immutable.
- **Step** — one logical unit such as planning, model invocation, tool batch, verification, or context/checkpoint work.
- **ModelStep** — one logical model decision point, potentially containing one or more Attempts.
- **ModelAttempt** — one actual provider request/attempt associated with a ModelStep.
- **ToolInvocation** — one uniquely identified proposed and admitted side-effect operation.
- **PlanRevision** — versioned accepted plan. Planner output is only a candidate until Kernel accepts it.
- **VerificationReport** — evidence bound to a plan revision, acceptance criteria, workspace and test environment.
- **Receipt** — authenticated Host evidence for a specific execution or workspace operation.

## 2. Task lifecycle

The initial Task state vocabulary is:

`Created`, `Admitted`, `Planning`, `Ready`, `Running`, `Waiting`, `Blocked`, `Verifying`, `Cancelling`, `Reconciling`, `CompletionHold`, `Completed`, `Failed`, `Cancelled`.

Waiting and Blocked carry structured reasons rather than multiplying top-level states. Candidate blocked reasons include approval pending/rejected/expired/revoked, budget exhausted or unbounded settlement, unknown outcome, dependency not ready, user input required, lease unavailable, workspace conflict, verification failure, evidence conflict, budget overrun, and external dependency unavailable.

Typical transitions:

- Created → Admitted after identity, idempotency and task-envelope validation.
- Admitted → Planning for tasks requiring a plan; otherwise → Ready.
- Planning → Ready only after a PlanRevision is accepted and validated.
- Running → Waiting / Blocked when an external condition prevents safe progress.
- Running → Verifying when acceptance evidence is ready to be checked.
- Verifying → Completed only when Completion Guard succeeds.
- Verifying → Running for an authorized, bounded repair; → Planning for a new plan revision.
- Running → Cancelling after a durable cancellation intent; new model steps and admissions are blocked.
- Cancelling → Cancelled only when every admitted operation is known to have converged and no UNKNOWN remains.
- Cancelling → Reconciling when a started operation has not converged.
- Reconciling → Blocked when the outcome remains unknown; otherwise the system acts on the evidence, not an assumption.

`Completed`, `Failed`, and `Cancelled` are immutable terminal states. A late conflict does not rewrite the original terminal fact.

## 3. ToolInvocation lifecycle

Execution state and Approval state are separate dimensions.

Initial execution states:

`Proposed`, `Validating`, `AwaitingApproval`, `Admitted`, `IntentPersisted`, `Dispatching`, `Running`, `CancelRequested`, `Reconciling`, `Succeeded`, `FailedKnown`, `Denied`, `CancelledBeforeStart`, `OutcomeUnknown`, `ReconciledNotExecuted`, `ReconciledSucceeded`, `ReconciledFailed`.

Approval states:

`NotRequired`, `Pending`, `Approved`, `Rejected`, `Expired`, `Revoked`.

Approval is bound to the exact principal, task, invocation, tool/version, canonical argument hash, policy version, workspace, target, requested capabilities, approver, expiry and revocation version. Changing a bound value invalidates the approval.

## 4. Admission and execution barriers

Before dispatch, the trusted path validates:

1. Task / Turn / Step / Invocation identity and ownership.
2. Complete parameters and schema.
3. Frozen tool definition and implementation identity.
4. Principal, capability, policy and approval versions.
5. Workspace and fencing epoch.
6. Budget reservation.
7. Required sandbox and host profile.
8. Durable Intent and a short-lived AdmissionTicket bound to the exact invocation and payload digest.

The model-visible tool schema is not an authorization token. The Host validates the ticket and current fencing/authorization conditions again before side effects.

## 5. Cancellation and UNKNOWN

Cancellation is a convergence protocol:

- Persist Cancel Intent.
- Stop new ModelSteps and new Tool Admissions.
- Invalidate pending approvals and undispatched admissions.
- Send cancellation to already dispatched work.
- Wait for started executions to converge.
- Collect receipts or classify the result as UNKNOWN.
- Only mark Cancelled when all started work has a trusted terminal result and no unresolved side effect remains.

A process kill, timeout, disconnected socket, or AbortSignal is not proof that an external side effect was undone.

UNKNOWN is not a synonym for failure. It requires reconciliation against Host Ledger, receipts, target-system state, and idempotency evidence. Keep ownership and relevant budget reservations while unresolved. Never blindly replay a non-idempotent invocation. The model cannot decide that an UNKNOWN tool call “must have failed” and retry it.

## 6. Recovery and immutable facts

- Stable invocation IDs, host request IDs, idempotency keys and payload digests survive retries and restart.
- Same ID + same digest returns the original result; same ID + different digest is a conflict and must be quarantined.
- Host receipt facts and Kernel state facts remain separate and are reconciled.
- A receipt persisted by Host but not yet projected into Kernel may be imported idempotently; the side effect is not re-executed.
- If evidence cannot prove whether a side effect occurred, retain OutcomeUnknown and block unsafe progress.

Runtime state transitions, transaction behavior, and crash-recovery correctness remain **UNVERIFIED** until implemented and fault-injection tested.
