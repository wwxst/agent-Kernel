# PlanRevision and PlanStep lifecycle contract

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03); implementation NOT started; runtime claims UNVERIFIED.** Scope: PlanRevision and PlanStep lifecycle, deterministic acceptance boundary, orthogonal work/verification state, carry-forward and cutover. Record shapes and enums are owned by the [Kernel data model](kernel-data-model.md), domain execution policy by [Execution Strategy](execution-strategy.md), and principal/approval semantics by [Permissions](../security/permissions.md). This document does not approve a runtime implementation, storage schema, or technology choice.

## 1. Purpose and authority

A PlanRevision is an immutable, versioned outcome plan for one Task, one accepted GoalContract version, and one immutable DomainBinding/Workflow Profile version. It is not a transcript of model calls. A PlanStep is an outcome-oriented unit within that revision and may carry a typed domain_step_payload.

- Orchestration/Domain Intelligence owns semantic adequacy: whether the plan actually solves the user's problem, whether the domain model is sufficient (RepositoryModel for Coding or MediaProjectModel for Video), whether the domain approach is sound, and whether replanning is warranted.
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
- DomainBinding ID/digest, Workflow Profile version, and domain goal-payload schema ID/version;
- original user-request reference and digest;
- all user clarification references and digests used to derive it;
- immutable intake-time authorization references with explicit scope/effect/target boundaries when the original request is relied upon instead of a new confirmation;
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
- DomainBinding ID/digest and Workflow Profile version;
- typed domain PlanStep payload schema/version references;
- source domain-model/EvidenceGraph snapshot references and workspace/project generation;
- PlanStep definitions and dependency DAG;
- criterion-to-step mapping and any explicit human-review obligation;
- preconditions, expected artifacts, effect/risk classes, capability requirements, and approval boundaries;
- evidence obligations, verification strategy, recovery strategy, and resource estimate;
- verification/repair reserve and revision rationale;
- the **taskControlVersion and active PlanRevision pointer** for *structural L2 activation*; ordinary L0/L1 actions instead bind current plan epoch plus only relevant workspace/authority/dependency versions.

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

1. Orchestration proposes a PlanCandidate bound to the accepted GoalContract, `taskControlVersion`, expected active-plan pointer, domain snapshot and relevant workspace generation.
2. Kernel performs the deterministic checks in section 4.
3. Kernel records AcceptedPendingCutover.
4. If the initial workspace and task bindings remain current and there are no prior operations to drain, Kernel atomically activates the revision and updates the Task's active-plan pointer.
5. The Task can move from Planning to Ready; execution begins only when a PlanStep becomes Ready.

### 3.1.1 Tactical/rework/structural classification and **per-invocation approval**

A structural PlanRevision switch is required only when the **accepted plan/GoalContract's protected authorization envelope** changes, not when an ordinary ToolInvocation receives a one-time approval. Domain Orchestration proposes a reasoned L0/L1/L2 class; Kernel checks exact protected-field diffs against the accepted plan rather than trusting the model classification.

| Class | Change type | Required protocol |
| --- | --- | --- |
| L0 TacticalAdjustment | Search/debug strategy, tool choice or **one-use InvocationApproval** inside accepted PlanStep's tool capability, effect class, scope, risk ceiling, verification obligations and budget | Keep PlanRevision Active. Obtain required approval through normal Invocation Approval/Admission; approval reference binds exact Invocation/tool/argument digest, authority epoch/version, expiry/nonce. Revalidate again at Host launch. |
| L1 PlanStepRework | Same engineering objective and **same plan-level authorization/acceptance envelope**; new attempt after failed implementation/test | Record PlanStepReworkStarted and stale affected evidence; per-tool one-use approvals remain separately enforced. |
| L2 StructuralReplan | Changed GoalContract/scope, PlanRevision capability/effect/risk **envelope**, approval **policy or required class of approver**, plan-wide resource permissions, dependency graph, protected criteria or material precondition | Full PlanSwitchRequested freeze/drain/reconcile/refresh/validate/cutover. |

A one-time InvocationApproval **does not** mutate immutable PlanRevision or allow elevation beyond existing capability/scope/risk. Approval denial also does not inherently require L2; the planner may ask, try another already admitted route, safely stop, or propose L2 only if the accepted plan itself must change.

**Permission revocation is immediate in Kernel Admission and ticket issuance, but not retroactive physical Host revocation.** Kernel records RevocationRequested and fences affected Host scope under [Trusted Host](../security/trusted-host.md); already-launched operations are reconciled. A revocation does not automatically replace a plan. Domain impact analysis determines whether an alternative operation remains within the current authorization envelope (L0/L1), whether the plan is blocked, or whether a true protected-field change requires L2. No planner classification can bypass Host fencing or replay a revoked approval.

L0/L1 cannot change authorized effects, lower required independent evidence, or bypass budget checks. Unprovable impact is held/escalated to L2 or clarification. First implementation does not introduce partial L2 hot-cutover. See [Core protocol](core-protocol.md).

### 3.2 Replanning and version switch

A replan is a coordinated cutover, not a pointer overwrite.

1. **Trigger and freeze.** Orchestration submits a PlanSwitchRequested command with a reason and evidence references. For a Task with a current active revision, Kernel compare-and-swaps **TaskControlVersion** and installs the structural plan-switch barrier, preserving the prior display phase as an event and marking the old revision Superseding. Planning/Ready/Running/Verifying/Waiting/Blocked labels are derived task views, not separately authoritative transitions. No new ModelStep intended to advance the old plan and no new ToolInvocation admission may begin against it. Planning/reconciliation ModelSteps may continue under the plan-switch phase; they cannot execute old-plan work.
2. **Stop undispatched work.** Pending approvals and admissions tied to the old revision are invalidated. An invocation with durable intent but not dispatched is cancelled before start where the Host can prove it did not start.
3. **Converge started work.** Already-dispatched operations receive cancellation/drain requests where supported. They may finish and return receipts. Their results remain attributed to the old revision and original invocation IDs.
4. **Reconcile uncertainty.** Any unresolved OutcomeUnknown that may mutate the workspace or an external target blocks activation of a potentially conflicting new revision. The Task enters Reconciling; only bounded read-only reconciliation is allowed. Kernel may admit such work through a separate PlanSwitchReadOnly profile, which cannot write the workspace or affect external targets. The model cannot waive this barrier. A non-blocking exception is permitted only when Kernel policy and the trusted Host profile prove the operation was read-only, isolated, and unable to affect any new-plan precondition.
5. **Refresh the repository snapshot.** Once old writes are quiescent and receipts are reconciled, Context Engine refreshes workspace generation, repository facts, and affected evidence. A candidate based on an earlier generation must be revalidated or regenerated.
6. **Validate candidate.** Orchestration submits a complete PlanCandidate. Kernel validates it deterministically and records AcceptedPendingCutover; acceptance at this stage does not make it executable.
7. **Atomic activation.** When all old-revision operations are terminal or explicitly policy-classified non-blocking, no conflicting UNKNOWN remains, the workspace is quiescent, and all version bindings match, Kernel commits one transition that marks the old revision Superseded, marks the new revision Active, updates the active-plan pointer, records the cutover event, and moves the Task to Ready (or Blocked if a declared prerequisite is still unresolved).
8. **Resume.** Orchestration continues only against the new active revision and a freshly assembled Execution Context.

If candidate creation or validation is abandoned, the old revision may return from Superseding to Active only after the barrier is safely removed, all started operations are reconciled, and its workspace/preconditions are revalidated. Otherwise the Task remains in Planning or Blocked; the system must not silently resume stale work.

### 3.3 Task lifecycle relationship

The Task's **presentation phase** is derived from the current TaskControl, PlanRevision and pending work/approval/evidence. PlanRevision's active pointer is the structural execution authority; the presentation phase never grants execution by itself.

Illustrative **derived phase transitions** (not independent state-commit obligations) include:

- A valid L2 plan-switch request uses **TaskControl CAS** to freeze new old-revision admissions, marking the active revision Superseding. The prior Task presentation phase is recorded for recovery but Planning/Waiting/Blocked labels are derived views, not a second commit gate.
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
- Task identity, **taskControlVersion (structural acceptance/cutover only)**, accepted GoalContract version, parent revision, monotonic revision number, and current active-plan pointer;
- unique PlanRevision and PlanStep IDs and valid lineage references;
- DAG acyclicity, valid dependency references, and no impossible self-dependencies;
- every required criterion ID exists and has at least one structured PlanStep mapping or an explicit human-review obligation;
- scope is contained within the accepted GoalContract and existing authorization envelope;
- requested capabilities, approvals, effect classes, and external targets are declared and policy-compatible;
- budget estimate and reservations fit the remaining hard budget while preserving required verification/repair reserve;
- workspace/project, domain-model, and evidence snapshot references are present and current for the candidate's declared base;
- the DomainBinding and Workflow Profile version are active and compatible with the Task and GoalContract;
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

### 4.1 Minimal plan and selective contention

An accepted PlanRevision is one immutable **structural outcome contract**, not a record of every tool decision. L0 tactics and L1 bounded rework do not generate new revisions. A PlanStep retains objective, dependencies, preconditions, authority/effect envelope, artifact obligation and criterion links. WorkStatus and VerificationStatus are **persisted, event-sourced PlanStep state** (section 5) with a per-step `plan_step_version`; they are not derived views, not independent approval authorities, and never advance `taskControlVersion`. A normal Host receipt does not stale an unrelated proposal simply by advancing a global Journal sequence. A structural PlanCandidate still requires TaskControlVersion/current-plan pointer equality; an Invocation validates only its relevant Plan/Authority/Workspace/Budget read-set.

## 5. PlanStep: orthogonal work and verification state

A PlanStep has two independent current-state dimensions, each **persisted** state changed only by a `PlanStepStatusChanged` event that CASes the step's `plan_step_version`, records a cause event and appends to the immutable history. Admission reads the step version and precondition digest as part of its read-set; a stale step version rejects admission with `StaleBinding`/`VersionConflict`. The append-only event/evidence history preserves every prior attempt and verdict.

### WorkStatus

NotStarted, Ready, Running, Blocked, Completed, Superseded.

- NotStarted → Ready → Running → Completed is the normal path.
- Ready or Running → Blocked records a structured blocker; Blocked → Ready requires the blocker to be resolved and preconditions refreshed.
- Completed → Running is permitted only through an explicit, authorized PlanStepReworkStarted event. It starts a new work attempt; it does not erase the prior completed artifact set.
- Any non-superseded status may become Superseded only through an accepted plan cutover. Superseded steps are immutable history and cannot be reactivated in place.

Only these guards write WorkStatus. FailedKnown is not a PlanStep WorkStatus. It belongs to a ModelAttempt or ToolInvocation. A failed command does not prove the engineering outcome is impossible. Orchestration may diagnose, retry safely, rework, block, or replan.

### VerificationStatus

NotRequired, Pending, Running, Passed, Failed, Stale, Inconclusive.

- Verification status is driven by evidence and verification events, not by work progress.
- WorkStatus=Completed with VerificationStatus=Failed is valid: the work produced an artifact, but the evidence did not satisfy its verification obligation.
- A repair may set WorkStatus to Running while preserving the prior failed report in history and setting the current VerificationStatus to Stale.
- A previously Passed result becomes Stale when any bound artifact, workspace generation, environment, dependency, criterion, GoalContract, or evidence source is invalidated.
- Inconclusive is not a pass. It returns to Pending only after new evidence or a changed verification method is recorded.
- NotRequired must be justified by the accepted PlanRevision and cannot be used to omit a required Task-level acceptance criterion.

### 5.1 Invalidation rule (which change stales which state)

A `PlanStepStatusChanged(Stale)` is required for exactly the steps and criteria whose evidence or preconditions depend on the changed binding; the mapping is deterministic, recorded, and never broader than this table:

| Changed protected binding | Invalidated state |
| --- | --- |
| GoalContract version, or a criterion's version/meaning | Every step mapped to a changed criterion, and every criterion evidence binding for it |
| PlanRevision cutover (new revision Active) | All steps of the previous revision become `Superseded`; carried-forward work enters as new steps with explicit lineage |
| `workspace_generation`, source snapshot or `project_snapshot` | Every step whose artifact or evidence `freshness_basis` names the changed generation |
| Tool definition, environment, toolchain or dependency-lock digest | Every verification that declares the changed tool/environment/lock |
| Artifact digest change, replacement or removal | Every evidence binding that references that artifact |
| Authority/approval revocation with no digest change | No work/verification state changes; admissions and launch rights stop per Host fence and Permissions contract |

A binding change with no matching row does not stale anything. Staling is append-only: re-verification moves the step to `Pending` and requires fresh evidence, never a copied PASS.

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

Every ToolInvocation binds the exact Task, PlanRevision, PlanStep, the step's `plan_step_version` and precondition digest, ActionProposal item, tool definition/version, canonical argument digest, workspace generation, policy/approval evidence, budget reservation, and fencing epoch.

The L2 plan-switch barrier is linearized in Kernel TaskControl CAS and Journal; only L2 structural cutover, cancellation, changed intent and terminal Task control require this CAS. Routine Invocation/ModelStep/Host receipt/budget events use their own aggregate versions and selective snapshot/authority binding checks:

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
11. A tactical or in-step rework change that retains all protected fields does not require a full PlanRevision cutover, but every effectful operation remains individually admitted.
12. Structural changes cannot be disguised as tactical changes; classification uses authoritative protected-field diffs.

All runtime transition atomicity, concurrent admission behavior, and recovery properties remain UNVERIFIED until implemented and fault-injection tested.


## 9. Domain payload extension

The common PlanRevision lifecycle is reused by both domains; domain-specific semantics remain in typed payloads.

- The Task and PlanRevision bind one immutable DomainBinding and Workflow Profile version, including the `DomainBinding.strategy_ref` whose body is defined by the Execution Strategy contract.
- Each PlanStep may carry a domain_step_payload with schema ID/version, expected domain artifact kinds, and domain-specific evidence obligations.
- Coding payloads may describe repository inspection, implementation, test, migration, and compatibility work. The first Coding PlanStep kind enum is `coding.plan-step@0.1`: `Inspect | Implement | Test | Migrate | Compatibility | Diagnose`. Every kind declares required fields (target, expected artifact, evidence obligation, recovery disposition); the full per-kind field registry lives in the Coding Domain Intelligence design. Kernel validates the enum, required fields and payload digest; it does not interpret the kind.
- Video payloads may describe media probing, shot/audio analysis, source-range selection, TimelineRevision creation, rendering, and output inspection; its kinds are registered by the Video profile, not by Kernel.
- Kernel validates schema, identity, version, DAG, scope, capability/effect envelope, budget, and artifact references. It does not judge code quality, narrative coherence, shot selection, or edit pacing.
- A Workflow Profile cannot grant permission. Every invocation is still admitted under current Kernel policy, principal, approval, budget, Host, and fencing state.

See [Domain Workflow binding contract](domain-workflow.md).
