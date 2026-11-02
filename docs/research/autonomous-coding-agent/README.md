# Autonomous Coding Agent intelligence

> **Status: PROPOSED DESIGN DRAFT — OWNER REVIEW PENDING.** The first end-to-end intelligent execution architecture and supporting research documents have been drafted. They are not approved implementation contracts. No runtime code, dependency stack, or production capability is authorized by these documents.

## 1. Objective

Design an agent that can independently complete complex software-engineering tasks: understand the goal, inspect the repository, construct and revise a plan, make coherent changes, debug through evidence, verify acceptance criteria, and recover safely across long-running or interrupted work.

The central design question is not how many agents or tool calls are used. It is whether the system can reliably own a software outcome from request through verified completion.

## 2. Design documents

- [Intelligent execution architecture](design.md) — GoalContract, RepositoryModel, EvidenceGraph, PlanRevision/PlanStep, strategic/tactical/assurance loops, debugging, verification, continuity, human control, and Kernel boundaries.
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

The proposed design must be reconciled with the existing contracts before implementation planning. See [Architecture overview](../../architecture/overview.md).

## 6. Required next work

- Review and challenge the cognitive execution model.
- Validate the PlanRevision/PlanStep and EvidenceGraph contracts.
- Build the proposed benchmark task set and run a baseline after separate implementation authorization.
- Resolve the remaining questions in [Open decisions](../../decisions/open-decisions.md).
- Keep all runtime and technology choices open until evidence and trade-offs are reviewed.

## 7. Explicit exclusions

- No runtime implementation is authorized.
- No final language, runtime, provider, database, or sandbox is selected.
- No package or microservice topology is prescribed.
- No old/deleted repository source is assumed or imported.
- Multi-Agent / D9 remains deferred and unauthorized.
