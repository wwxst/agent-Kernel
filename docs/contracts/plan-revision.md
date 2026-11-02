# PlanRevision and PlanStep lifecycle contract

> **Status: PROPOSED second-round contract.** This document closes the design gaps identified in the first architecture review. It defines deterministic state and cutover rules; it does not approve a runtime implementation, storage schema, or technology choice.

## 1. Purpose and authority

A PlanRevision is an immutable, versioned outcome plan for one Task and one accepted GoalContract version. It is not a transcript of model calls. A PlanStep is an outcome-oriented unit within that revision.

- Orchestration owns semantic adequacy: whether the plan actually solves the user's problem, whether the repository model is sufficient, whether the technical approach is sound, and whether replanning is warranted.
- Kernel owns deterministic contract validation and authoritative commitment: identity, version, schema, graph structure, scope containment, required references, legal transition, budget constraints, admission freeze, and plan-version pointer.
- Kernel does **not** judge whether an architecture or implementation strategy is technically wise. It does not call a second Planner to approve a plan.
- A PlanCandidate is not executable authority. Only a PlanRevision in **Active** state, with a **Ready** PlanStep and current preconditions, can authorize new work proposals. Every side-effecting ToolInvocation still requires its own Kernel admission.

The plan contract is intentionally separate from runtime Step, ModelStep, ModelAttempt, and ToolInvocation.

## 2. GoalContract version prerequisite

The immutable source of intent is the original user request plus append-only user clarifications. A GoalContract is a structured interpretation, not a replacement for that source.

Proposed GoalContract lifecycle:

**Candidate → NeedsClarification | ReadyForAcceptance → Accepted → Superseded**

A candidate requiring clarification remains non-authoritative. A user clarification is appended to UserIntent and produces a new GoalContract candidate; it does not mutate the prior candidate. A rejected candidate is retained as **Rejected**; accepted versions are immutable and monotonically versioned.

Every version binds:

- Task ID and GoalContract version;
- original user-request reference and digest;
- all user clarification references and digests used to derive it;
- desired outcome, scope, exclusions, constraints, and acceptance criteria;
- assumptions, ambiguity, risk profile, and user-control policy;
- workspace/repository identity and base commit;
- a field-level change set from the preceding accepted version, if any;
- explicit user-confirmation references for protected changes.

The following changes require explicit user confirmation unless an immutable intake-time authorization record explicitly covers the exact change: changing desired behavior, expanding scope, changing exclusions, changing a required acceptance criterion, relaxing a constraint, changing a public/compatibility contract, increasing risk or blast radius, or introducing a new external/destructive side effect. Kernel checks that the required confirmation or intake authorization reference exists and is bound to the candidate; it does not infer the user's intent from model text or decide semantic fidelity.

Orchestration may propose low-risk operational assumptions without asking only when they are reversible, disclosed, remain within the accepted scope and constraints, do not change required acceptance criteria, and the task's user-control policy permits autonomous inference. An assumption is never silently promoted into user intent.

A new accepted GoalContract version does not rewrite the original request. If a protected field changes, the current plan must enter the plan-switch protocol. Existing work artifacts may be reused only under the explicit carry-forward rules below. A VerificationReport bound to the prior GoalContract version cannot complete the new version; its raw evidence may be reused only if its own scope and freshness remain valid.

## 3. PlanRevision record and lifecycle

A PlanRevision binds at minimum:

- Task ID, revision ID, monotonically increasing revision number, and parent revision ID;
- accepted GoalContract version and digest;
- source RepositoryModel/EvidenceGraph snapshot references and workspace generation;
- PlanStep definitions and dependency DAG;
- criterion-to-step mapping and any explicit human-review obligation;
- preconditions, expected artifacts, effect/risk classes, capability requirements, and approval boundaries;
- evidence obligations, verification strategy, recovery strategy, and resource estimate;
- verification/repair reserve and revision rationale;
- the exact Task aggregate version and current plan pointer against which it was proposed.

Proposed revision states:

| State | Meaning | Executable? |
| --- | --- | --- |
| Proposed | Orchestration candidate; not authoritative | No |
| AcceptedPendingCutover | Kernel contract checks passed; awaiting safe activation | No |
| Active | Sole current executable revision | Yes, subject to PlanStep readiness and per-invocation admission |
| Superseding | Former active revision frozen for new admissions and draining | No new work |
| Superseded | Historical immutable revision replaced by another active revision | No |
| Rejected | Candidate failed deterministic contract checks | No |

At most one revision may be Active for a Task. At most one revision switch may be in progress for a Task. A revision's definitions and rationale are immutable after acceptance; progress is represented by append-only state events and evidence references.

### 3.1 Initial activation

For the first plan:

1. Orchestration proposes a PlanCandidate bound to the accepted GoalContract, current Task aggregate version, repository snapshot, and workspace generation.
2. Kernel performs the deterministic checks in section 4.
3. Kernel records AcceptedPendingCutover.
4. If the initial workspace and task bindings remain current and there are no prior operations to drain, Kernel atomically activates the revision and updates the Task's active-plan pointer.
5. The Task can move from Planning to Ready; execution begins only when a PlanStep becomes Ready.

### 3.2 Replanning and version switch

A replan is a coordinated cutover, not a pointer overwrite.

1. **Trigger and freeze.** Orchestration submits a PlanSwitchRequested command with a reason and evidence references. Kernel compare-and-swaps the current Task version, transitions Running → Planning, marks the current revision Superseding, and installs a plan-switch barrier. No new ModelStep intended to advance the old plan and no new ToolInvocation admission may begin against it.
2. **Stop undispatched work.** Pending approvals and admissions tied to the old revision are invalidated. An invocation with durable intent but not dispatched is cancelled before start where the Host can prove it did not start.
3. **Converge started work.** Already-dispatched operations receive cancellation/drain requests where supported. They may finish and return receipts. Their results remain attributed to the old revision and original invocation IDs.
4. **Reconcile uncertainty.** Any unresolved OutcomeUnknown that may mutate the workspace or an external target blocks activation of a potentially conflicting new revision. The Task enters Reconciling; only bounded read-only reconciliation is allowed. The model cannot waive this barrier. A non-blocking exception is permitted only when Kernel policy and the trusted Host profile prove the operation was read-only, isolated, and unable to affect any new-plan precondition.
5. **Refresh the repository snapshot.** Once old writes are quiescent and receipts are reconciled, Context Engine refreshes workspace generation, repository facts, and affected evidence. A candidate based on an earlier generation must be revalidated or regenerated.
6. **Validate candidate.** Orchestration submits a complete PlanCandidate. Kernel validates it deterministically and records AcceptedPendingCutover; acceptance at this stage does not make it executable.
7. **Atomic activation.** When all old-revision operations are terminal or explicitly policy-classified non-blocking, no conflicting UNKNOWN remains, the workspace is quiescent, and all version bindings match, Kernel commits one transition that marks the old revision Superseded, marks the new revision Active, updates the active-plan pointer, records the cutover event, and moves the Task to Ready (or Blocked if a declared prerequisite is still unresolved).
8. **Resume.** Orchestration continues only against the new active revision and a freshly assembled Execution Context.

If candidate creation or validation is abandoned, the old revision may return from Superseding to Active only after the barrier is safely removed, all started operations are reconciled, and its workspace/preconditions are revalidated. Otherwise the Task remains in Planning or Blocked; the system must not silently resume stale work.

### 3.3 Task lifecycle relationship

The Task state describes the overall task-control phase; PlanRevision state describes which plan version may govern work.

Required transitions include:

- Running, Verifying, Ready, Waiting, or Blocked → Planning on a valid plan-switch request when an active revision exists. Kernel compare-and-swaps the current Task version, freezes new admissions against the old revision, and records the prior Task state for controlled recovery.
- Planning → Reconciling when a started old-revision operation has an unresolved outcome.
- Reconciling → Planning after the relevant outcomes are reconciled.
- Planning → Ready after a new revision is activated.
- Planning → Running only when a switch is explicitly aborted and the old revision is safely restored as Active.
- Verifying → Planning when criterion coverage or the current plan is inadequate.
- Verifying → Running for a bounded repair under the same active revision when the plan remains valid.
- Planning → Blocked when user input, approval, budget, or a non-reconcilable dependency is required.

Completed, Failed, and Cancelled remain immutable terminal Task states. Replanning never reopens a terminal Task. A post-terminal defect requires a separately authorized RemediationTask.

The Task may be Waiting, Blocked, or Verifying while one revision remains Active; no such state grants new side-effect authority by itself. Active is necessary but not sufficient for execution.

## 4. Kernel's deterministic acceptance boundary

Kernel validates the plan as a contract, not as a technical design review.

Deterministic checks include:

- schema version, required fields, size limits, and canonical serialization;
- Task identity, aggregate version, accepted GoalContract version, parent revision, monotonic revision number, and current active-plan pointer;
- unique PlanRevision and PlanStep IDs and valid lineage references;
- DAG acyclicity, valid dependency references, and no impossible self-dependencies;
- every required criterion ID exists and has at least one structured PlanStep mapping or an explicit human-review obligation;
- scope is contained within the accepted GoalContract and existing authorization envelope;
- requested capabilities, approvals, effect classes, and external targets are declared and policy-compatible;
- budget estimate and reservations fit the remaining hard budget while preserving required verification/repair reserve;
- workspace, RepositoryModel, and evidence snapshot references are present and current for the candidate's declared base;
- each step declares preconditions, expected artifacts, risk/effect, evidence obligations, and a recovery disposition;
- the command is legal for the current Task and revision-switch phase.

Kernel may validate that criterion IDs are mapped; it cannot decide that the mapping is semantically sufficient. It may validate that a repository snapshot reference is current; it cannot decide that the RepositoryModel is intellectually complete. It may validate that a dependency graph is acyclic; it cannot decide that the chosen technical sequence is wise.

Semantic responsibilities retained by Orchestration:

- whether the GoalContract faithfully captures the user's intent;
- whether the RepositoryModel contains enough relevant facts;
- whether the PlanStep decomposition is useful;
- whether the plan actually solves the requested problem;
- whether technical choices fit repository architecture and constraints;
- whether a plan should be revised and what evidence justifies it.

Kernel must not call a model, inspect source code to judge architecture quality, or become a second Planner as part of PlanRevision acceptance.

## 5. PlanStep: orthogonal work and verification state

A PlanStep has two independent current-state dimensions. The append-only event/evidence history preserves every prior attempt and verdict.

### WorkStatus

NotStarted, Ready, Running, Blocked, Completed, Superseded.

- NotStarted → Ready → Running → Completed is the normal path.
- Ready or Running → Blocked records a structured blocker; Blocked → Ready requires the blocker to be resolved and preconditions refreshed.
- Completed → Running is permitted only through an explicit, authorized PlanStepReworkStarted event. It starts a new work attempt; it does not erase the prior completed artifact set.
- Any non-superseded status may become Superseded only through an accepted plan cutover. Superseded steps are immutable history and cannot be reactivated in place.

FailedKnown is not a PlanStep WorkStatus. It belongs to a ModelAttempt or ToolInvocation. A failed command does not prove the engineering outcome is impossible. Orchestration may diagnose, retry safely, rework, block, or replan.

### VerificationStatus

NotRequired, Pending, Running, Passed, Failed, Stale, Inconclusive.

- Verification status is driven by evidence and verification events, not by work progress.
- WorkStatus=Completed with VerificationStatus=Failed is valid: the work produced an artifact, but the evidence did not satisfy its verification obligation.
- A repair may set WorkStatus to Running while preserving the prior failed report in history and setting the current VerificationStatus to Stale.
- A previously Passed result becomes Stale when any bound artifact, workspace generation, environment, dependency, criterion, GoalContract, or evidence source is invalidated.
- Inconclusive is not a pass. It returns to Pending only after new evidence or a changed verification method is recorded.
- NotRequired must be justified by the accepted PlanRevision and cannot be used to omit a required Task-level acceptance criterion.

A PlanStep is not Task completion. Completion Guard evaluates the Task's complete acceptance-criteria contract and current evidence.

## 6. Carry-forward, lineage, and supersession

A new PlanRevision never mutates or reactivates an old PlanStep. It may define a new PlanStep with:

- a new PlanStep ID;
- a stable semantic lineage_key;
- an explicit carried_forward_from reference to the old PlanStep;
- a carry-forward rationale;
- exact artifact and evidence references proposed for reuse.

Kernel checks that the referenced old step exists, the evidence/artifact references are valid, and the transfer is legal. Orchestration is responsible for semantic equivalence and relevance; Kernel does not infer it.

Work may be carried forward as Completed only when the required artifacts still exist in the current workspace, their content digests match, the relevant preconditions remain true, and the new step's objective is materially equivalent. If these conditions are not established, the new step starts Ready or NotStarted.

Verification evidence is more restrictive. By default, a new PlanStep starts with VerificationStatus=Pending even when work artifacts are carried forward. A prior passing result may be reused only if its criterion, test definition, environment, dependency set, artifact hashes, and workspace scope remain unchanged and the evidence contract explicitly allows cross-revision reuse. The new Task-level VerificationReport must still bind the newly active PlanRevision.

Completed work that is no longer needed remains in the old revision's history and workspace; it is not silently deleted. The new plan simply does not carry it forward. If a new revision changes the goal or criterion, old evidence can remain historical but cannot satisfy the changed criterion without a new evidence mapping and verification.

## 7. Concurrency, invocation binding, and UNKNOWN

Every ToolInvocation binds the exact Task, PlanRevision, PlanStep, ActionProposal item, tool definition/version, canonical argument digest, workspace generation, policy/approval evidence, budget reservation, and fencing epoch.

The plan-switch barrier is linearized in the Kernel Journal / Task aggregate version:

- An admission committed before the barrier is an already-admitted operation and must be drained or reconciled.
- An admission attempted after the barrier is rejected as stale/superseding.
- No client timestamp or model statement can reorder the barrier.
- An invocation already dispatched may finish after the old revision enters Superseding; its receipt remains bound to the old revision.
- A late result cannot authorize new old-revision work or silently alter the new revision.

If an old invocation is UNKNOWN, the system does not assume it failed. Workspace-mutating or externally side-effecting UNKNOWN outcomes block a conflicting cutover and all unsafe retries. Reconcile through Host Ledger, receipts, target state, and idempotency evidence. Preserve the original invocation ID and reservation. Only trusted policy may classify a proven isolated read-only UNKNOWN as non-blocking.

After cutover, a late receipt for an old revision is appended as historical evidence. If it reveals a conflict with the active workspace or a completion claim, the system enters the applicable hold/reconciliation path; it does not rewrite the active plan or terminal Task.

## 8. Invariants and non-claims

1. At most one PlanRevision is Active per Task.
2. An AcceptedPendingCutover revision cannot authorize execution.
3. A Superseding revision accepts no new admissions.
4. A new revision becomes Active only after old work is quiescent or policy-proven non-blocking and the workspace binding is current.
5. No UNKNOWN side effect is treated as failure or blindly replayed.
6. PlanStep work and verification statuses are independent.
7. FailedKnown is an invocation/attempt outcome, not an engineering-goal verdict.
8. Old plan/step/evidence history is append-only and never rewritten by replan.
9. A new GoalContract version or PlanRevision invalidates any VerificationReport whose bindings no longer match.
10. Kernel validates structure and authority; Orchestration evaluates semantic adequacy.

All runtime transition atomicity, concurrent admission behavior, and recovery properties remain UNVERIFIED until implemented and fault-injection tested.
