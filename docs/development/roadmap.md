# Development roadmap and gates

> **Status: Provisional sequencing reconciled with the second-round proposed contracts.** This roadmap is a planning aid, not blanket authorization to begin every phase.

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

**Current state:** first- and second-round design drafts exist. No runtime benchmark or fault-injection experiment has been run.

**Exit:** owner-reviewed intelligent-execution design, explicit state/decision contracts, evidence map, trade-off report, failure model, and staged evaluation protocol. A measured baseline is not required at this design gate.

## Stage 2 — Reconcile and review Kernel architecture

- Integrate the intelligent-execution design with Kernel authority and Trusted ToolHost contracts.
- Clarify the distinction between PlanStep and runtime Step.
- Define which plan/evidence facts Kernel owns and which remain Orchestration/Context projections.
- Reconcile ModelStep purposes, budget reserve, context/checkpoint bindings, plan switching, and Completion Guard.
- Resolve contradictions and identify contracts that need revision.
- Mark every statement as approved, proposed, open, deferred, or unverified.

**Exit:** owner-reviewed architecture and explicit implementation scope. This is an architecture approval gate, not permission to implement.

## Stage 3 — Implementation planning (not implementation authorization)

- Translate the reviewed contracts into a proposed implementation plan.
- Evaluate runtime, persistence, provider strategy, and sandbox alternatives with evidence and trade-offs; do not silently select a stack.
- Define testable contracts, module responsibilities, ports, schemas, threat model, rollback strategy, and implementation verification gates.
- Define the benchmark task schema and scoring method; freeze the evaluation design before comparative runs.

**Exit:** owner-approved implementation plan and evaluation method. This gate does not authorize runtime code, production dependencies, or real-model execution.

## Stage 4 — Contract verification and benchmark task-set preparation

- If separately authorized, use controlled fake providers/hosts and deterministic traces to test critical state, budget, delivery, cancellation, recovery, plan revision, checkpoint, and completion contracts.
- Prepare the reproducible task set, difficulty strata, pinned repositories/commits, acceptance criteria, hidden tests/reviewer rubric, and scoring controls.
- Validate that task difficulty and acceptance criteria are not biased toward easy or overly familiar tasks.
- Report PASS / FAIL / NOT RUN / SKIP / PARTIAL / UNVERIFIED without overclaiming.

**Exit:** frozen task-set version, scoring rubric, environment controls, and contract-verification report. No comparative quality threshold is inferred yet.

## Stage 5 — Baseline measurement

- With separate explicit authorization, run a declared reference system or the first controlled real-model implementation against the frozen task set.
- Pin provider/model, disposable workspace, tools, network policy, environment, budgets, and stop conditions.
- Use the same task definitions, hidden tests, tool policy, and budget envelope for each compared system.
- Publish baseline distributions, failure taxonomy, confidence limits, and confounders.
- If no comparable reference system is available, label the first controlled implementation as the baseline rather than implying an external comparison.

A fixture-only provider does not count as a real-model Coding Agent baseline.

**Exit:** reproducible baseline report. The baseline is evidence, not a target threshold.

## Stage 6 — Target confirmation

- Use baseline distributions, task difficulty strata, confidence intervals, safety requirements, and intended deployment risk to propose quality thresholds.
- Set false-completion and unauthorized-execution safety gates separately from average task-success targets.
- Review threshold sensitivity and the effect of blocked/incomplete/unsafe runs.
- Obtain explicit owner approval of target thresholds before formal comparison claims.

**Exit:** approved target metrics and safety gates. Do not choose thresholds retroactively to make observed results look successful.

## Stage 7 — Formal evaluation and ablation

- Run repeated controlled comparisons against the approved baseline and thresholds.
- Perform one-capability-at-a-time ablations for GoalContract, reconnaissance, plan graph/revision, EvidenceGraph, debugging, independent verification, checkpoint/compaction, and effect-aware scheduling.
- Report distributions, all failure classes, safety violations, resource costs, and confidence limits.
- Preserve full traces and reproduce representative failures.

**Exit:** evidence-backed adoption/adaptation/rejection decisions. A benchmark result does not imply production readiness.

## Stage 8 — Strengthen long-task context and trusted execution

- Validate checkpoint integrity and recovery-time authorization revalidation.
- Test compaction and memory freshness.
- Fault-inject Host crashes, process-tree leaks, receipt delays, UNKNOWN outcomes, lease expiry, and workspace divergence.
- Verify plan-switch drain/cutover, process convergence, receipt authenticity, and Completion Guard under adversarial conditions.

**Exit:** bounded, environment-specific evidence for recovery and trusted execution claims.

## Stage 9 — Productization

Only after the core contracts and controlled execution are demonstrated, evaluate SDK/API/CLI/IDE/Desktop integration, remote workers, multi-user deployment, and extension lifecycle.

## Hard gates

- A phase does not automatically authorize the next phase.
- Architecture approval does not equal implementation authorization.
- Implementation planning does not authorize runtime code or production dependencies.
- Real-model baseline runs require separate explicit authorization.
- Passing a contract spike or baseline run does not equal production readiness.
- Target thresholds are set only after a frozen task set and measured baseline exist.
- D9 / Multi-Agent remains deferred until separately reopened and authorized.
- No legacy code migration without per-asset review and explicit approval.
