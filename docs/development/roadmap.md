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

- Implement planning only after separate authorization; the product scope is already REVISED/APPROVED under ADP-01 as a complete natural-language autonomous-editing loop with bounded core operations.
- Deepen media-content understanding, message-conditioned moment/highlight selection, basic NarrativePlan, pacing, semantic/visual continuity, audiovisual coordination, and bounded iterative editing.
- Define MediaProject/ProjectSnapshot, MediaAnalysis, MediaProjectModel, and TimelineRevision version/lineage/evidence-inheritance contracts.
- Separate core automatic-editing operations, enhanced editorial capabilities, and post-production/platform adaptation.
- Define a security-bounded FFmpeg RenderPlan: input protocols/formats, filesystem, filtergraph, network, process isolation, and enforceable resources.
- Define RenderJob/ToolInvocation/Host Ledger state authority, cancellation, UNKNOWN reconciliation, crash recovery, staging, and publication.
- Define technical, content, source-to-output provenance, independent, and human acceptance obligations.
- Expand Video task families and evaluation metrics without selecting a provider or running experiments.

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
- Review second-round Video intelligence, MediaProject/MediaAnalysis lineage, FFmpeg RenderPlan security, RenderJob state authority, source provenance, and independent acceptance in [Second-round architecture revision](../decisions/second-round-architecture-revision.md).
- Review separate Coding and Video evaluation protocols and shared Kernel safety metrics.
- Continue disposition of ADP-03 through ADP-11 in [Architecture Decision Proposals](../decisions/architecture-decision-proposals.md) and the second-round revision decisions, recording accepted, rejected, deferred, or revised clauses in the [Decision Log](../decisions/decision-log.md). ADP-01 and ADP-02 are already REVISED/APPROVED.
- Check every local link, status label, and implementation authorization boundary.

**Exit:** owner-approved cross-domain architecture and explicit implementation scope. This is not yet implementation authorization.

### Draft PR #1 G0 architecture subtraction prerequisite (OPEN)

Before any implementation planning, review [Architecture subtraction and contract feasibility](../decisions/architecture-subtraction-review.md) with [Core protocol](../contracts/core-protocol.md): one main loop with Strategic/Tactical/Assurance purposes; unique TaskControl/ModelStep/Invocation/Budget/Host authorities; selective protected read-set admission; L2 structural-only plan changes; bounded action-intent rather than ActionProposal settlement; optional EvidenceGraph; lazy context; milestone checkpoint; sequential-first scheduling. Keep admission, Host fencing, K/O/H recovery, budget, UNKNOWN and evidence-driven Completion. No new owner decisions are implied; ADP-03–11 remain OPEN.

## Stage 4 — Implementation planning (not implementation authorization)

- Translate approved contracts into a proposed implementation plan.
- Evaluate runtime, persistence, provider strategy, media analysis, and sandbox alternatives with evidence and trade-offs.
- Define module responsibilities, ports, schemas, threat model, rollback strategy, and verification gates.
- Freeze separate Coding and Video benchmark task schemas and scoring methods.

**Exit:** owner-approved implementation plan and evaluation method. No runtime code or production dependency is authorized by this gate.

**G0 implementation simplification (still OPEN):** first prove a Gateway local durable send marker and no-unqualified-Provider-retry rule; qualify Provider idempotency and charge limits separately. For Host, prioritize **sealed read-only SourceSnapshot + isolated outputs** and a local serialized LaunchGate/fence with explicit grant validity/risk policy. Full file-open tracers, multi-Host linearization and distributed transactions are **not first-slice requirements**; if selected OS/Provider cannot meet the safety contract, mark unsupported rather than silently weakening guarantees. See [Core protocol M1–M6/R5–R7/S1–S3](../contracts/core-protocol.md).

## Stage 5 — Contract verification and task-set preparation

- If separately authorized, test **TaskControl versus aggregate-local CAS and protected read-set races**, K/O/H outbox replay, Host fence/actual Coding execution view, budget hold versus completion, UNKNOWN, L2 cutover, bounded scheduling and both Domain Completion contracts with deterministic providers/hosts/renderers.
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

## Stage 9 — Developer task decomposition and construction acceptance (G0 proposal; no implementation authorization)

**Dependencies are mandatory; the following are future tickets, not completed implementation.** Each handoff includes typed request/result schema and version digest, authority/transaction owner, success/UNKNOWN/failure/cancel path, policy/resource binding, log/receipt events, deterministic fixture, observability fields and unsupported-environment outcome.

| Ticket | Depends on | Deliverable | Blocking acceptance |
| --- | --- | --- | --- |
| K-00 Protocol fixture harness | G0 owner architecture review | Event schema, legal/illegal transitions, deterministic K/G/H crash/replay traces | Mock Core, M/R/S fixtures reproducible without claiming physical proof |
| K-01 Kernel authority | K-00 | Journal/Inbox/Outbox, TaskControl CAS, ModelStep/Invocation/Budget aggregate versions, selective K-local serializable read-sets | Unrelated receipts do not conflict; protected read-set and budget vs completion race are atomic |
| K-02 Model/Provider | K-01 | Adapter maximum-charge certificate, one-use G SendMayHaveOccurred, candidate/selection, invoices/UNKNOWN | M1–M6, no blind provider resend, bounded unresolved liability |
| K-03 Trusted Host | K-01 | Single-Host local gate/fence/nonce, sandbox, execution-view attestations, receipts/process convergence | R1–R7/S1–S3/V1–V3 on named OS; unsupported R2 fails closed |
| K-04 Tool/recovery | K-01,K-02,K-03 | Admission, conflict scopes, idempotent HostResultInbox and reconciliation | Crash before/after K/H/OS, cancel and duplicate side-effect fixtures |
| K-05 Context/Domain ports | K-01 | Lazy indexed ContextManifest, DomainManifest/adapter interface, ScopedReadGrant/artifact resolver | X1/X2/X4, stale source and prompt injection containment |
| K-06 Orchestrator/Guard | K-02,K-04,K-05 | Single decision loop, no-progress/deadline wait, optional verifier policy, deterministic Completion Guard | Cheap + high-risk paths, exactly-once terminal, approval/wait/timeout |
| C-01 Coding intelligence | K-05,K-06 | Repository locator, patches, L0/L1 repair, test impact and source evidence | C-01–C-04,C-08/C-10 with independent oracles |
| C-02 Coding Host verification | K-03,C-01 | Sealed read-only SourceSnapshot and effective ExecutionViewManifest; isolated test outputs | C-05–C-07,C-09/C-11/C-12; unsupported runner blocks completion |
| V-01 Video intelligence | K-05,K-06 | Media/project snapshots, progressive modality evidence, NarrativePlan and rational-time timeline compiler | V-01–V-03,V-06/V-10 and source/time oracles |
| V-02 Video render | K-03,V-01 | Validated RenderPlan, long Host job, one-use staging, cancellation and immutable publish | V-04/V-05/V-09, media resource and process convergence evidence |
| V-03 Video assurance | V-02,K-06 | Actual final decode, semantic/content assessment, provenance, revision validation | V-01/V-07/V-08, independent blinded human rubrics as declared |
| X-01 Office proof | K-05,K-06,C-01,V-01 | **Mock/design-only** Office manifest/adapter, external edit UNKNOWN, scoped Coding→Video artifact handoff | X1–X8 without a new Kernel Loop/TaskControl state |
| E-01 Measured comparison | C-02,V-03,X-01 | Frozen A/B source tasks, raw traces/bills, controlled ablations and failure injector | G1–G5 qualifying evidence and owner-calibrated non-regression thresholds |

### Stage 9.1 Non-collapsible gate ledger

| Gate | Required qualifying evidence | Current status |
| --- | --- | --- |
| G0 static decision and independent design review | Owner dispositions on pending ADPs; no major cross-document conflict; accepted resource/R2/revocation/Verifier policy and runtime target | **OPEN / NOT OWNER APPROVED** |
| G1 protocol | Executed serializability, K/G/H ambiguity, maximum provider budget/candidate selection and recovery fixtures | **NOT RUN** |
| G2 Host | Actual named OS/Host sealed source, spawn/fence races, sandbox isolation, descendants/handle convergence | **NOT RUN** |
| G3 Coding | C-01–C-12 end-to-end including hidden tests, A/B speed/Token/false completion | **NOT RUN** |
| G4 Video | V-01–V-10 real media/render/output and blinded editorial quality/latency | **NOT RUN** |
| G5 domain reuse | X1–X8 Office adapter and exact cross-domain handoff; no Kernel loop or terminal enum change | **NOT RUN** |

**Static construction walk-through:** Kernel supports accepted Goal → one K-local admission/Outbox → H/Provider independent facts → event-driven wait/reconciliation → Guard/terminal; Coding binds patches/tests to exact sealed source and executed read-only test view; Video binds source→analysis→timeline→render→actual output check; Office binds structured edit/etag and external authorization via the same Invocation/UNKNOWN protocol. These are **paper paths, not executable proofs**.

**Blocking choices to owner:** B0 owner acceptance of G0 proposals/ADP-03–11; B1 provider-specific hard-charge and ambiguous submit support or explicit soft-only capability; B2 approved single-Host grant TTL/revocation exposure/R2 policy; B3 selected OS/Host and sealed-source-capable Coding toolchain; B4 selected K storage semantics for atomic selective read-set; B5 accepted assurance/benchmark thresholds and rights-cleared task sets; B6 separate authorization for runtime, physical fault injection, actual provider billing and media runs. These are **P0/P1 unresolved**; full project readiness is **BLOCKED**, even when static documentation is internally coherent.

**Signoff record required for each gate:** owner, independent reviewer, construction simulator, named environment, fixture IDs and results, raw evidence links, outstanding P0/P1, accepted risks and date. At most two targeted document repair/review iterations per gate; unresolved decision forks escalate to owner. No G0 text can be used to assert G1–G5 PASS.
