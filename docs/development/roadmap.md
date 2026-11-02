# Development roadmap and gates

> **Status: Provisional roadmap aligned to the APPROVED one-Kernel/two-domain product direction.** Coding and Video domain research proceed in parallel and integrate through one shared Kernel contract stream. Architecture details remain proposed. This roadmap does not authorize Runtime implementation or real-model/media execution.

## Stage 0 — Establish the new project baseline

- Maintain the clean, self-contained repository and decision discipline.
- Re-author the approved Kernel authority boundaries and contracts.
- Preserve provenance and explicit adoption exclusions.
- Keep Runtime and technology choices open.

**Current state:** documentation baseline established.

## Stage 1 — Parallel domain intelligence research

The Coding and Video design tracks proceed in parallel. Neither domain is required to finish before the other can be researched. A shared Kernel integration track reconciles common contracts continuously.

### Track A — Autonomous Coding

- Retain the first- and second-round Coding Domain Intelligence design.
- Keep RepositoryModel, coding workflow, debugging, and code verification semantics domain-specific.
- Reconcile Coding GoalContract/PlanRevision payloads with DomainBinding and Workflow Profile.
- Keep the coding task benchmark and quality thresholds separate from Video evaluation.

### Track B — Autonomous Video Editing

- Define first-phase scope as natural-language-driven automatic editing, not a full video editor.
- Define MediaProjectModel, media ingest/probe/analysis evidence, and source provenance.
- Define TimelineRevision as a persistent, non-destructive, versioned artifact.
- Define RenderPlan and long-running RenderJob over the shared ToolInvocation/Host/budget/cancel/recovery path.
- Define technical, temporal, content, perceptual, and human verification obligations.
- Define natural-language EditIntent and timeline revision behavior.
- Define video task families and the evaluation method.

**Exit:** two independently coherent domain proposals, each with its own model, workflow, artifacts, tools, acceptance criteria, and evaluation method.

## Stage 2 — Shared Kernel and reference review

- Define common DomainBinding and immutable Workflow Profile contracts.
- Reconcile shared GoalContract/PlanRevision envelopes with typed domain payloads.
- Add MediaProjectModel as a sibling Context Engine projection to RepositoryModel.
- Ensure both domains use the same Kernel admission, budgets, Journal, Host, receipts, cancellation, UNKNOWN, recovery, and Completion Guard contracts.
- Re-review Pi, Codex, DeepSeek Harness, and Claude Agent SDK for common execution-layer mechanisms and adoption limits.
- Resolve terminology and cross-document authority/scope contradictions.

**Exit:** coherent cross-domain architecture proposal and source-grounded shared execution-layer review.

## Stage 3 — Cross-domain consistency and owner review

- Review shared-versus-domain-specific responsibility boundaries.
- Review Task/Profile binding and profile migration rules.
- Review timeline persistence, rational time representation, render cancellation/recovery, and final video verification.
- Review separate Coding and Video evaluation protocols and shared Kernel safety metrics.
- Check every local link, status label, and implementation authorization boundary.

**Exit:** owner-approved cross-domain architecture and explicit implementation scope. This is not yet implementation authorization.

## Stage 4 — Implementation planning (not implementation authorization)

- Translate approved contracts into a proposed implementation plan.
- Evaluate runtime, persistence, provider strategy, media analysis, and sandbox alternatives with evidence and trade-offs.
- Define module responsibilities, ports, schemas, threat model, rollback strategy, and verification gates.
- Freeze separate Coding and Video benchmark task schemas and scoring methods.

**Exit:** owner-approved implementation plan and evaluation method. No runtime code or production dependency is authorized by this gate.

## Stage 5 — Contract verification and task-set preparation

- If separately authorized, use controlled fake providers/hosts/renderers and deterministic traces to test state, budgets, delivery, cancellation, recovery, plan revision, checkpoint, render lifecycle, and completion contracts.
- Prepare reproducible Coding repositories/tasks and Video source assets/tasks with pinned digests, acceptance criteria, hidden checks, and reviewer rubrics.
- Report PASS / FAIL / NOT RUN / SKIP / PARTIAL / UNVERIFIED without overclaiming.

**Exit:** frozen task-set versions, scoring rubrics, environment controls, and contract-verification report.

## Stage 6 — Separate domain baselines

- With separate explicit authorization, run a declared reference system or first controlled implementation on each frozen domain task set.
- Pin provider/model, tool snapshots, source assets/repositories, workspace isolation, network policy, environment, budgets, and stop conditions.
- Publish Coding and Video baseline distributions and failure taxonomies separately.
- Do not infer Video quality from Coding success or vice versa.

**Exit:** reproducible baseline reports for each domain. Baselines are evidence, not target thresholds.

## Stage 7 — Target confirmation and formal evaluation

- Set separate Coding and Video quality targets using measured baselines, task difficulty, confidence intervals, and risk.
- Set shared Kernel safety floors for unauthorized execution, false completion, UNKNOWN reconciliation, cancellation, and budget enforcement.
- Run repeated comparisons and one-capability-at-a-time ablations.
- Publish all outcomes, including failed, blocked, incomplete, unsafe, and unverified runs.

**Exit:** evidence-backed adoption/adaptation/rejection decisions. No benchmark result alone implies production readiness.

## Stage 8 — Trusted execution and productization

- Fault-inject Host crashes, process-tree leaks, receipt delays, UNKNOWN outcomes, lease expiry, workspace/project divergence, long render cancellation, and partial-output recovery.
- Verify process convergence, receipt authenticity, final artifact publication, and Completion Guard under adversarial conditions.
- Only after core contracts are demonstrated, evaluate SDK/API/CLI/IDE/Desktop integrations and any minimal user-facing preview/approval surface.

**Exit:** bounded, environment-specific evidence for recovery and trusted execution claims.

## Hard gates

- Product direction approval does not approve every detailed contract.
- Architecture approval does not equal implementation authorization.
- Implementation planning does not authorize runtime code or production dependencies.
- Real-model benchmark runs and external media processing require separate explicit authorization.
- Passing a contract spike or baseline run does not equal production readiness.
- Coding and Video quality thresholds are set only after their own frozen task sets and measured baselines exist.
- D9 / Multi-Agent remains deferred until separately reopened and authorized.
- A full visual Video Editor remains outside the first-phase scope.
- No legacy code migration without per-asset review and explicit approval.
