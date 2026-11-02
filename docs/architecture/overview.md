# Architecture overview

> **Status: Initial working baseline.** The core authority boundaries below are adopted from the approved V2.1.2 principles. The autonomous Coding Agent execution model and implementation details remain open for iterative design.

## 1. Product objective

Build an autonomous Coding Agent system that can take a development goal, understand the repository and constraints, formulate and revise a plan, make controlled code changes, run meaningful verification, diagnose failures, and continue or recover safely across long tasks.

The system must combine two different strengths:

- **Adaptive intelligence:** understanding, planning, prioritization, exploration, debugging, and deciding what to do next.
- **Deterministic authority:** identity, state transitions, budgets, permissions, durable intent, side-effect evidence, recovery, and completion.

The Kernel must enforce the second without hard-coding all of the first. The boundary between these is a major open design topic; see [Autonomous Coding Agent intelligence research](../research/autonomous-coding-agent/README.md).

## 2. Logical components

These are logical responsibilities, not a commitment to separate microservices or processes.

| Component | Owns | Must not own |
| --- | --- | --- |
| Agent Application | CLI / SDK / API / IDE / Desktop entry points and user interaction | Authoritative task state or direct side-effect authority |
| Orchestration | Goal decomposition, PlanCandidate, PlanRevision proposals, strategy, coordination, verification and repair decisions | Direct provider calls, direct tool execution, or authoritative state writes |
| Kernel | Task/Turn/Step/ToolInvocation state, hard budget ledger, legal transitions, admission, durable intent, completion gate | Business strategy, provider-specific protocol, physical OS side effects |
| Model Gateway | Provider credentials boundary, request/stream protocol, complete-response normalization, usage and provider errors | Task state, budget authorization, tool admission, tool execution |
| Context Engine | Retrieval, provenance, Planning/Execution Context, checkpoint candidates, compaction and memory projections | Authorization, state mutation, or rewriting execution facts |
| Tool Runtime | Immutable tool-definition snapshots, scheduling, dispatch, host client, result projection | Permission grants or authoritative task-state changes |
| Policy & Security | Principal, capability, policy and approval evidence used by Kernel | Independent authority to dispatch side effects |
| Kernel Persistence | Journal, aggregates, budget ledger, durable inbox/outbox, and transactional checkpoint records | Physical execution evidence |
| Trusted ToolHost | OS-level isolation, worker lifecycle, workspace controls, Host Ledger and receipts | Kernel task state or next-step reasoning |
| Extension Host | Scoped extension lifecycle and public APIs | Direct access to Kernel internals, persistence, or Trusted ToolHost |

## 3. Authority and evidence boundaries

- Kernel Journal and reconstructable aggregates are authoritative for Task, Turn, Step, and ToolInvocation state.
- Kernel Budget Ledger is authoritative for reservations, consumption, settlement, adjustments, overrun, and enforcement holds.
- Policy and Approval systems provide evidence; Kernel makes the final admission decision.
- Provider responses and usage records are evidence supplied through Model Gateway; they do not directly mutate task state.
- Trusted ToolHost Host Ledger and authenticated receipts describe physical execution. Kernel stores references and reconciles them; it does not invent success.
- Workspace snapshots and hashes are authoritative only within their declared scope, version, and trusted host evidence.
- Context packs, plans, model output, summaries, and memory are projections or candidates, not execution facts.

No component may silently promote its local cache, model output, or external response into an authoritative fact.

## 4. High-level execution path

1. Application submits a stable, idempotent task command.
2. Kernel validates identity, command digest, task envelope, initial budget and admission.
3. Orchestration inspects the goal and project context, creates a PlanCandidate, and submits a proposed PlanRevision.
4. Kernel validates and versions the accepted plan.
5. Context Engine builds a version-bound Execution Context from the current authoritative snapshot.
6. Kernel creates a ModelStep and reserves budget; Model Gateway performs the provider request.
7. Kernel accepts only complete, schema-valid response candidates and selects a final response according to the journal ordering contract.
8. For tool calls, Kernel validates the immutable tool snapshot, parameters, policy, approvals, capability, budget, workspace and fencing; it persists intent before dispatch.
9. Tool Runtime sends an AdmissionTicket-bound request to Trusted ToolHost.
10. Host records physical execution facts and returns an authenticated receipt or an explicitly unknown outcome.
11. Kernel reconciles evidence, updates state, and Orchestration chooses the next step.
12. Verification runs against a specific plan, environment and workspace. Completion Guard verifies the evidence and a frozen final snapshot before TaskCompleted.

This flow is a logical description. The precise autonomous control loop, planning policy, repair loop, and stopping criteria remain under research.

## 5. Core invariants

1. Kernel is the sole authority for state, hard budgets, and Tool Admission.
2. A ToolCall is not executable until its complete response, parameters, tool version and request snapshot have passed validation.
3. Authorization is rechecked at the execution boundary; model text and retrieved content cannot grant permission.
4. Durable intent precedes a possible side effect.
5. Kernel Journal and Host Ledger remain separate fact domains.
6. Cancellation is a convergence protocol, not a UI flag or a claim that side effects were rolled back.
7. UNKNOWN is not FailedKnown and cannot trigger blind retry.
8. Parallel work may complete out of order; evidence is persisted when it becomes known, while the next model context uses deterministic association/order.
9. Response delivery is at-least-once with durable deduplication and idempotent command commits, not distributed exactly-once.
10. Budget settlement is append-only. Late overrun evidence cannot reopen a terminal Task.
11. Completion requires evidence bound to the accepted PlanRevision, workspace snapshot, environment and actual verification runs.
12. Extensions, tools, memory, context and sub-agents cannot bypass Kernel or Host security contracts.

## 6. Deployment principle

The initial design does not assume microservices. Application, Orchestration, Kernel, Gateway, Context Engine and Tool Runtime may begin as separately testable modules in one application process. Trusted ToolHost must retain a real process/OS trust boundary from untrusted tool code. Persistence is a durable authority boundary, not automatically a network service.

Concrete process topology, runtime, language, database and deployment model are **OPEN**.

## 7. Explicit non-goals for this baseline

- No old Kernel source is treated as the implementation foundation.
- No technology stack is selected by implication.
- No production readiness or security certification is claimed.
- Multi-Agent / D9 remains deferred and unauthorized.
- The architecture does not yet prescribe a complete autonomous coding policy or a fixed planner/verifier/repair topology.
