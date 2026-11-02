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
- Define GoalContract versioning, RepositoryModel, minimum EvidenceGraph records, PlanRevision cutover, orthogonal PlanStep states, and ActionProposal contracts.
- Define strategic, tactical, debugging, assurance, arbitration, stopping, human-control, and recovery behavior.
- Define long-task checkpoint integrity separately from current authorization and resumability.
- Define evidence independence levels and Completion Guard obligations.
- Define evaluation metrics, task families, safety floors, and staged experimental method.

**Current state:** source-grounded design, reference review, failure model, and evaluation protocol drafted in autonomous-coding-agent. No runtime benchmark or fault-injection experiment has been run.

**Exit:** owner-reviewed intelligent-execution design, explicit state/decision contracts, evidence map, trade-off report, failure model, and staged evaluation protocol. A measured baseline is not required at this design gate.

## Stage 2 — Reconcile and review Kernel architecture

- Integrate the intelligent-execution design with Kernel authority and Trusted ToolHost contracts.
- Clarify the distinction between PlanStep and runtime Step.
- Define which plan/evidence facts Kernel owns and which remain Orchestration/Context projections.
- Reconcile ModelStep purposes, budget reserve, context/checkpoint bindings, and Completion Guard.
- Resolve contradictions and identify contracts that need revision.
- Mark every statement as approved, proposed, open, deferred, or unverified.

**Current state:** an architecture reconciliation draft is available on the design branch. Owner review remains pending.

**Exit:** owner-reviewed architecture and explicit implementation scope.

## Stage 3 — Implementation planning (not implementation authorization)

- After architecture review, translate the approved contracts into a proposed implementation plan.
- Evaluate runtime, persistence, provider strategy, and sandbox alternatives with evidence and trade-offs; do not silently select a stack.
- Define testable contracts, module responsibilities, ports, schemas, threat model, rollback strategy, and implementation verification gates.
- Build the benchmark task schema and scoring rubric in parallel; freeze the task set before comparative runs.

**Exit:** owner-approved implementation scope and evaluation method. This gate does not authorize runtime code, production dependencies, or real-model execution.

## Stage 4 — Contract verification and benchmark preparation

- If separately authorized, use controlled fake providers/hosts and deterministic traces to test critical state, budget, delivery, cancellation, recovery, plan revision, checkpoint, and completion contracts.
- Prepare the reproducible task set, difficulty strata, acceptance criteria, hidden tests/reviewer rubric, and scoring controls.
- Report PASS / FAIL / NOT RUN / SKIP / PARTIAL / UNVERIFIED without overclaiming.

## Stage 5 — Controlled baseline and target confirmation

- With separate explicit authorization, run a declared reference system or the first controlled real-model implementation against the frozen task set.
- Pin provider/model, disposable workspace, tools, network policy, environment, budgets, and stop conditions.
- Publish baseline distributions and failure taxonomy before proposing target thresholds.
- Set and approve target quality/safety thresholds from the measured baseline and task difficulty.

A fixture-only provider does not count as a real-model coding baseline.

## Stage 6 — Formal evaluation and ablation

If separately authorized, use controlled fake providers/hosts and deterministic traces to test critical state, budget, delivery, cancellation, recovery, plan revision, checkpoint, and completion contracts. Report PASS / FAIL / NOT RUN / SKIP / PARTIAL / UNVERIFIED without overclaiming.

## Stage 7 — Strengthen long-task context and trusted execution

Validate checkpoint/compaction, memory lifecycle, Host isolation, process convergence, receipt authenticity, UNKNOWN reconciliation, and Completion Guard through fault injection and adversarial tests.

## Stage 8 — Productization

Only after the core contracts and controlled execution are demonstrated, evaluate SDK/API/CLI/IDE/Desktop integration, remote workers, multi-user deployment, and extension lifecycle.

## Hard gates

- A phase does not automatically authorize the next phase.
- Architecture approval does not equal implementation authorization.
- Passing a contract spike or baseline run does not equal production readiness.
- Target thresholds are set only after a frozen task set and measured baseline exist.
- D9 / Multi-Agent remains deferred until separately reopened and authorized.
- No legacy code migration without per-asset review and explicit approval.
