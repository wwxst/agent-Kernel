# Autonomous Coding Agent intelligence

> **Status: RESEARCH INDEX (informative).** The Coding construction specification is [design.md](design.md), with [failure-model.md](failure-model.md) and [evaluation.md](evaluation.md); those are listed as NORMATIVE (domain) in the [documentation map](../../README.md). This is not an implementation authorization; no runtime code, dependency stack or production capability is authorized.

## 1. Objective

Design the Coding Domain Intelligence that can independently complete complex software-engineering tasks: understand the goal, inspect the repository, construct and revise a plan, make coherent changes, debug through evidence, verify acceptance criteria, and recover safely across long-running or interrupted work. The shared Kernel and Video Editing domain are specified separately.

The central design question is not how many agents or tool calls are used. It is whether the system can reliably own a software outcome from request through verified completion.

## 2. Design documents

- [Unified domain architecture](../../architecture/domain-architecture.md) — shared Kernel and independent domain responsibilities.
- [Shared Kernel reference review](../shared-kernel/reference-review.md) — cross-domain execution-layer findings.
- [Shared Kernel evaluation](../shared-kernel/evaluation.md) — common safety and recovery metrics measured alongside, but separately from, Coding quality.
- [Intelligent execution architecture](design.md) — GoalContract versioning, RepositoryModel, EvidenceGraph, PlanRevision/PlanStep, ActionProposal, decision arbitration, verification independence, continuity, human control, and Kernel boundaries.
- [PlanRevision and PlanStep lifecycle](../../contracts/plan-revision.md) — plan-switch barrier, old-work convergence, carry-forward, orthogonal statuses, and Kernel's deterministic acceptance boundary.
- [Reference implementation review](reference-review.md) — source-grounded comparison of Pi, Codex, DeepSeek Harness, and Claude Agent SDK.
- [Failure model and recovery policy](failure-model.md) — failure taxonomy, hypothesis-driven debugging, no-progress control, and recovery matrix.
- [Evaluation and experiment protocol](evaluation.md) — real coding task benchmark, metrics, controls, ablations, and acceptance gates.

## 3. Core proposal

**PROPOSED:** one primary Orchestration controller owns the task-level reasoning process. Explorer, Planner, Implementer, Debugger, and Verifier are decision modes, not a requirement for multiple agent processes. Every model call remains a Kernel-managed ModelStep.

The execution architecture separates:

1. Goal and acceptance-criteria formation.
2. Repository reconnaissance and a versioned RepositoryModel.
3. A provenance-aware EvidenceGraph.
4. A dependency-aware, versioned PlanRevision and PlanStep graph.
5. An adaptive action/feedback loop.
6. Hypothesis-driven debugging and bounded repair.
7. Independent verification and Kernel-gated completion.
8. Long-task checkpoints, compaction, recovery, and project memory.

## 4. Research references

Pinned source snapshots and official documentation are recorded in [reference-review.md](reference-review.md). The current review is source/documentation analysis only; it does not claim runtime experiments or comparative benchmark results.

## 5. Boundary with Kernel

Orchestration owns reasoning and proposals. Kernel owns authoritative task and plan state, hard budgets, legal transitions, Tool Admission, approvals, durable intent, and Completion Guard. Trusted ToolHost owns physical execution evidence. Context Engine owns provenance-aware projections, not authority.

The second-round proposal is reconciled with the current Kernel documents but remains pending owner review. See [Architecture overview](../../architecture/overview.md) and [PlanRevision lifecycle](../../contracts/plan-revision.md).

## 6. Required next work

- Review and challenge the cognitive execution model.
- Review the PlanRevision/PlanStep, GoalContract, ActionProposal, EvidenceGraph, checkpoint, arbitration, and verification contracts.
- Prepare the benchmark task set; run a baseline only after separate explicit execution authorization.
- Resolve the remaining questions in [Open decisions](../../decisions/open-decisions.md).
- Keep all runtime and technology choices open until evidence and trade-offs are reviewed.

## 7. Explicit exclusions

- No runtime implementation is authorized.
- No final language, runtime, provider, database, or sandbox is selected.
- No package or microservice topology is prescribed.
- No old/deleted repository source is assumed or imported.
- Multi-Agent / D9 remains deferred and unauthorized.
