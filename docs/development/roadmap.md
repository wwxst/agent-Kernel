# Development roadmap and gates

> **Status: Provisional sequencing reconciled with the proposed intelligent-execution design.** This roadmap is a planning aid, not blanket authorization to begin every phase.

## Stage 0 — Establish the new project baseline

- Create this repository with a clean Git history.
- Re-author the approved architecture principles and contracts.
- Record source provenance and explicit adoption exclusions.
- Establish research, decision, testing, and documentation conventions.

**Current state:** documentation baseline established. This does not mean the architecture is approved or complete.

## Stage 1 — Design autonomous Coding Agent intelligence

- Study source implementations and official documentation in Pi, Codex, DeepSeek Harness, and Claude Agent SDK.
- Model the end-to-end autonomous coding lifecycle, not only the low-level tool loop.
- Define GoalContract, RepositoryModel, EvidenceGraph, PlanRevision, and PlanStep semantics.
- Define strategic, tactical, debugging, assurance, stopping, human-control, and recovery behavior.
- Define long-task context, checkpoint, compaction, and project-memory requirements.
- Build a reproducible evaluation task set and compare alternatives.

**Current state:** source-grounded design, reference review, failure model, and evaluation protocol drafted in autonomous-coding-agent. No runtime benchmark or fault-injection experiment has been run.

**Exit:** owner-reviewed intelligent-execution design, evidence map, trade-off report, failure model, evaluation protocol, and proposed contracts.

## Stage 2 — Reconcile and review Kernel architecture

- Integrate the intelligent-execution design with Kernel authority and Trusted ToolHost contracts.
- Clarify the distinction between PlanStep and runtime Step.
- Define which plan/evidence facts Kernel owns and which remain Orchestration/Context projections.
- Reconcile ModelStep purposes, budget reserve, context/checkpoint bindings, and Completion Guard.
- Resolve contradictions and identify contracts that need revision.
- Mark every statement as approved, proposed, open, deferred, or unverified.

**Current state:** an architecture reconciliation draft is available on the design branch. Owner review remains pending.

**Exit:** owner-reviewed architecture and explicit implementation scope.

## Stage 3 — Implementation plan and authorization

- Select runtime, persistence, provider strategy, and sandbox approach only after evidence and trade-off review.
- Define module boundaries, ports, data schemas, test plan, and security threat model.
- Define implementation order, rollback strategy, and verification gates.

**Exit:** explicit owner approval for the implementation scope. No code implementation is implied before this gate.

## Stage 4 — Short-cycle contract verification

If separately authorized, use controlled fake providers/hosts and deterministic traces to test critical state, budget, delivery, cancellation, recovery, plan revision, checkpoint, and completion contracts. Report PASS / FAIL / NOT RUN / SKIP / PARTIAL / UNVERIFIED without overclaiming.

## Stage 5 — Controlled real-model Coding Agent vertical slice

Requires separate explicit approval of model/provider, task set, workspace isolation, budget, tools, network policy, and stop conditions. Use a disposable repository/workspace and no production credentials. A fixture-only provider does not count as a real-model coding result.

## Stage 6 — Strengthen long-task context and trusted execution

Validate checkpoint/compaction, memory lifecycle, Host isolation, process convergence, receipt authenticity, UNKNOWN reconciliation, and Completion Guard through fault injection and adversarial tests.

## Stage 7 — Productization

Only after the core contracts and controlled execution are demonstrated, evaluate SDK/API/CLI/IDE/Desktop integration, remote workers, multi-user deployment, and extension lifecycle.

## Hard gates

- A phase does not automatically authorize the next phase.
- Architecture approval does not equal implementation authorization.
- Passing a contract spike does not equal production readiness.
- D9 / Multi-Agent remains deferred until separately reopened and authorized.
- No legacy code migration without per-asset review and explicit approval.
