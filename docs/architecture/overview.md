# Architecture overview

> **Status: Second-round reconciliation proposal.** The authority boundaries remain the adopted starting principles. The cognitive execution model and revised GoalContract/PlanRevision/PlanStep/ActionProposal/verification contracts remain proposals pending owner review. No runtime implementation or technology stack is approved.

## 1. Product objective

Build an autonomous Coding Agent system that can take a software-engineering goal, understand the repository and constraints, formulate and revise a plan, make controlled changes, diagnose failures, run meaningful verification, and recover safely across long tasks.

The system must combine:

- **Adaptive intelligence:** goal understanding, repository reconnaissance, planning, prioritization, implementation strategy, debugging, verification decisions, and adaptation.
- **Deterministic authority:** identity, authoritative state, accepted plan versions, hard budgets, permissions, durable intent, side-effect evidence, recovery, and completion gates.

The target is verified software-task completion, not merely a completed model turn or a successful tool-call loop.

The detailed cognitive design is [Autonomous Coding Agent — Intelligent Execution Architecture](../research/autonomous-coding-agent/design.md). Its current status is **PROPOSED**.

## 2. Architectural principles

1. **One primary task controller by default.** Orchestration owns the end-to-end goal and adaptive execution policy. Specialized reasoning modes are ModelStep purposes, not a requirement for multiple agents. Multi-Agent / D9 remains deferred.
2. **Orchestration proposes; Kernel commits.** Planning, diagnosis, and action selection are adaptive. Authoritative state, budget, permission, admission, and completion remain deterministic.
3. **The repository must be understood before it is changed.** RepositoryModel and EvidenceGraph projections make source facts, hypotheses, assumptions, unknowns, and freshness explicit.
4. **Plans are versioned outcome contracts.** PlanRevision/PlanStep define dependencies, expected artifacts, criterion coverage, risk, and verification. A PlanCandidate is not executable authority until Kernel validates and safely activates the revision; AcceptedPendingCutover is not executable.
5. **Actions are evidence-producing operations.** Every side effect is admitted and attributable to the accepted plan, workspace generation, tool snapshot, and authorization evidence.
6. **Debugging is hypothesis-driven.** Repeated attempts require new evidence or a documented retry condition.
7. **Completion is an evidence-gated state transition.** No model message, diff, or exit code alone can complete a Task.
8. **Context is a projection, not authority.** Context, plans, summaries, memory, and model output cannot rewrite execution facts.
9. **External side effects are not transactionally atomic with Kernel state.** Kernel Journal and Host Ledger remain separate fact boundaries.
10. **No implementation topology is implied.** Logical responsibilities may be separately testable modules without becoming microservices.

## 3. Logical responsibilities

These are responsibilities and authority boundaries, not a commitment to package names, separate processes, or a technology stack.

| Responsibility | Owns | Must not own |
| --- | --- | --- |
| Agent Application | CLI / SDK / API / IDE / Desktop entry points, user interaction, progress and approval UI | Authoritative task state or direct side-effect authority |
| Orchestration | GoalContract candidates, repository/problem modeling, EvidenceGraph projections, PlanCandidate, adaptive action selection, debugging hypotheses, verification decisions, and user escalation | Direct provider calls, direct tool execution, or authoritative state writes |
| Kernel | Task/Turn/Step state, accepted GoalContract and PlanRevision/PlanStep facts, deterministic contract validation, plan-switch barriers, ModelStep/Attempt and ToolInvocation state, hard budgets, legal transitions, admission, durable intent, and Completion Guard | Semantic goal interpretation, technical plan quality, business strategy, provider-specific protocol, physical OS side effects |
| Model Gateway | Provider credentials boundary, request/stream protocol, complete-response normalization, usage evidence, and provider errors | Task state, plan acceptance, budget authorization, tool admission, tool execution |
| Context Engine | RepositoryModel and EvidenceGraph projections, Planning/Execution Context, retrieval, checkpoint candidates, compaction, and memory projections | Authorization, state mutation, or rewriting execution facts |
| Tool Runtime | Immutable tool-definition snapshots, effect/conflict-aware scheduling, dispatch, Host client, and result projection | Permission grants or authoritative task-state changes |
| Policy & Security | Principal, capability, policy and approval evidence used by Kernel | Independent authority to dispatch side effects |
| Kernel Persistence | Journal, aggregates, accepted plan state, budget ledger, durable inbox/outbox, and transactional checkpoint records | Physical execution evidence |
| Trusted ToolHost | OS-level isolation, worker lifecycle, workspace controls, Host Ledger and receipts | Kernel task state or next-step reasoning |
| Extension Host | Scoped extension lifecycle and public APIs | Direct access to Kernel internals, persistence, or Trusted ToolHost |

Orchestration may contain logical cognitive capabilities such as Explorer, Planner, Implementer, Debugger, and Verifier. They are not separate security principals or agents by default. Every model call is a Kernel-managed ModelStep.

## 4. Cognitive execution model

### 4.1 Goal and repository model

Orchestration proposes a versioned GoalContract from immutable UserIntent and append-only clarifications. Kernel checks structure, provenance, version lineage, protected-field changes, and required user-confirmation evidence; it does not decide semantic fidelity. The accepted contract contains desired outcome, scope, exclusions, constraints, acceptance criteria, assumptions, ambiguity, risk, and workspace binding.

It then builds a RepositoryModel from repository structure, manifests, source, symbols, dependency relationships, tests, project conventions, and environment evidence. Each claim retains provenance and freshness. Repository instructions are bounded project data; they cannot grant permissions or override higher-authority policy.

### 4.2 Evidence and plan

The EvidenceGraph separates FACT, HYPOTHESIS, ASSUMPTION, DECISION, UNKNOWN, and CONTRADICTION. It links claims to source references, repository observations, commands, test results, diffs, and Host evidence.

Orchestration proposes a dependency-aware PlanRevision made of outcome-oriented PlanSteps. Kernel performs deterministic contract validation (schema, identity/version, DAG, references, criterion-ID mapping, scope/capability/budget envelope, and legal transition), not technical or semantic plan review. A new revision is not executable until the plan-switch barrier has drained/reconciled old work and Kernel atomically activates it. PlanStep work and verification statuses are independent; the full contract is in [PlanRevision lifecycle](../contracts/plan-revision.md).

A PlanStep is a goal-level work item. A runtime Step is an execution unit such as planning, model invocation, tool batch, verification, or checkpoint work. ModelStep and ModelAttempt remain the model-specific lifecycle.

### 4.3 Adaptive control loops

The execution model has three cooperating logical loops:

- **Strategic loop:** maintain the goal model, identify missing facts, evaluate progress and dependencies, and decide continue / inspect / replan / ask / wait / verify / stop.
- **Tactical loop:** build a version-bound Execution Context, request a typed ActionProposal, obtain Kernel admission, dispatch through Tool Runtime and Trusted ToolHost, then update evidence.
- **Assurance loop:** map acceptance criteria to actual checks, diagnose verification failures, run an independent verifier pass, freeze the workspace, and submit evidence to Completion Guard.

The loops are responsibilities of Orchestration, not a fixed multi-agent topology. One task-level decision coordinator serializes their proposals by safety, reconciliation, user intent, approval, assurance, replan, normal execution, and delivery priority.

## 5. High-level execution path

1. Application submits a stable, idempotent task command.
2. Kernel validates identity, idempotency, task envelope, initial budget, and admission.
3. Orchestration creates a GoalContract candidate and identifies material ambiguity.
4. Kernel admits bounded reconnaissance; Context Engine builds the initial RepositoryModel and EvidenceGraph projections.
5. Orchestration submits a PlanCandidate. Kernel validates it deterministically; the first revision is activated only when its bindings are current. Revisions after the first use freeze → drain → reconcile → refresh → validate → atomic activate.
6. For each ready PlanStep, Context Engine builds an Execution Context bound to current task, plan, workspace, policy, budget, and tool snapshots.
7. Orchestration requests a ModelStep through Kernel and Model Gateway; the model proposes an action or bounded tool batch.
8. Kernel validates each invocation, policy, approval, capability, budget, workspace generation, tool version, and durable intent.
9. Tool Runtime dispatches only admitted requests to Trusted ToolHost.
10. Host records physical execution facts and returns an authenticated receipt or an explicitly unknown outcome.
11. Kernel reconciles evidence. Orchestration updates RepositoryModel/EvidenceGraph projections; the single-task decision coordinator decides continue, debug, replan, ask, wait, or verify. A replan freezes old-revision admissions and reconciles already-started work before cutover.
12. Verification runs against the accepted plan, criterion set, environment, and workspace generation.
13. Completion Guard validates current evidence and the frozen final snapshot before TaskCompleted.
14. Orchestration delivers a bounded user-facing summary only after durable completion/delivery rules permit it.

A simplified control flow:

    User Goal
      -> GoalContract
      -> Repository Reconnaissance
      -> RepositoryModel + EvidenceGraph
      -> PlanCandidate
      -> Kernel accepts PlanRevision
      -> [PlanStep execution loop]
           Execution Context
           -> ModelStep / ActionProposal
           -> Kernel admission
           -> Tool Runtime
           -> Trusted ToolHost
           -> Receipt + Evidence
           -> strategic/tactical reassessment
      -> Acceptance Verification
      -> Workspace Freeze
      -> Kernel Completion Guard
      -> TaskCompleted
      -> Delivery

Read-only reconnaissance may occur before plan acceptance only within an explicitly admitted discovery profile. Source modifications and other side effects require an accepted plan and normal Kernel admission.

## 6. Authority and evidence boundaries

- Kernel Journal and reconstructable aggregates are authoritative for Task, Turn, Step, accepted PlanRevision/PlanStep progress, ModelStep, ModelAttempt, and ToolInvocation state.
- Kernel Budget Ledger is authoritative for reservations, consumption, settlement, adjustments, overrun, and enforcement holds.
- Policy and Approval systems provide evidence; Kernel makes the final admission decision.
- Provider responses and usage records are evidence supplied through Model Gateway; they do not directly mutate task state.
- Trusted ToolHost Host Ledger and authenticated receipts describe physical execution. Kernel stores references and reconciles them; it does not invent success.
- Workspace snapshots and hashes are authoritative only within their declared scope, version, and trusted Host evidence.
- RepositoryModel, EvidenceGraph, context packs, plans before acceptance, model output, summaries, and memory are projections or candidates, not execution facts.
- A PlanRevision becomes authoritative only through deterministic Kernel contract validation and a safe activation transition. AcceptedPendingCutover is not executable. Orchestration cannot write accepted plan state directly. Kernel does not judge whether the technical route is good; that remains Orchestration's responsibility.

No component may silently promote its local cache, model output, or external response into an authoritative fact.

## 7. Core invariants

1. Kernel is the sole authority for state, hard budgets, accepted plan versions, and Tool Admission.
2. A PlanCandidate and an AcceptedPendingCutover revision are not executable authority; side effects require an Active PlanRevision and current PlanStep.
3. A ToolCall is not executable until its complete response, parameters, tool version, plan binding, and request snapshot have passed validation. Side effects require an Active PlanRevision; bounded read-only discovery before initial plan activation uses a separate admission profile.
4. Authorization is rechecked at the execution boundary; model text and retrieved content cannot grant permission.
5. Durable intent precedes a possible side effect.
6. Kernel Journal and Host Ledger remain separate fact domains.
7. Cancellation is a convergence protocol, not a UI flag or a claim that side effects were rolled back.
8. UNKNOWN is not FailedKnown and cannot trigger blind retry.
9. Parallel work may complete out of order; evidence is persisted when it becomes known, while model-visible projection is deterministic.
10. Response delivery is at-least-once with durable deduplication and idempotent command commits, not distributed exactly-once.
11. Budget settlement is append-only. Late overrun evidence cannot reopen a terminal Task.
12. Completion requires evidence bound to the accepted PlanRevision, acceptance criteria, workspace snapshot, environment, and actual verification runs.
13. Extensions, tools, memory, context, and future sub-agents cannot bypass Kernel or Host security contracts.

## 8. Deployment principle

The initial design does not assume microservices. Application, Orchestration, Kernel, Gateway, Context Engine, and Tool Runtime may begin as separately testable responsibilities in one application process. Trusted ToolHost must retain a real process/OS trust boundary from untrusted tool code. Persistence is a durable authority boundary, not automatically a network service.

Concrete process topology, runtime, language, database, sandbox product, and deployment model remain **OPEN**.

## 9. Explicit non-goals for this baseline

- No old Kernel source is treated as the implementation foundation.
- No technology stack is selected by implication.
- No production readiness or security certification is claimed.
- Multi-Agent / D9 remains deferred and unauthorized.
- No package list or microservice topology is mandated by the cognitive design.
- No runtime implementation, dependency addition, or legacy code migration is authorized by this architecture draft.
