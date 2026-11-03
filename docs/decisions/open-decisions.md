# Open decisions

> **Status: Mixed register.** The one-Kernel/two-domain product direction, revised ADP-01 Video first-phase capability boundary, and revised ADP-02 progressive media-analysis policy are approved. ADP-03 through ADP-11 and the remaining detailed cross-domain/domain contracts, technology choices, and implementation decisions remain OPEN/PROPOSED.

The current product direction and ADP-01/ADP-02 dispositions are recorded in [Unified Agent Kernel — approved product direction](unified-domain-direction.md) and the [Decision Log](decision-log.md). The cross-domain architecture proposal is [here](../architecture/domain-architecture.md), and consistency findings are in [Cross-domain architecture review](cross-domain-architecture-review.md). Candidate recommendations, alternatives, risks, and acceptance criteria are collected in [Architecture Decision Proposals](architecture-decision-proposals.md). ADP-01 and ADP-02 are REVISED/APPROVED; no other item is approved merely because it appears in the proposal packet.

### First-batch decision status

ADP-02 is **REVISED/APPROVED**. The remaining first-batch drafts — **ADP-03, ADP-05, and ADP-09** — now propose an initially scoped **single-Host-local** launch/revocation ordering with separately acknowledged fences (multi-Host global ordering deferred), piecewise asset-clock mappings, and resolver-mediated scoped handoff grants; they remain **OPEN** until explicit owner disposition. These are documentation contracts, not empirically verified implementations, and approval does not authorize implementation.

### Draft PR #1 architecture-subtraction review (OPEN)

[Architecture subtraction and feasibility review](architecture-subtraction-review.md) is a **candidate G0 refinement, not an owner decision**. Proposed: one primary Agent Loop with Strategic/Tactical/Assurance modes; selective aggregate version read-sets rather than global TaskControl CAS on each Invocation; L2-only structural PlanRevision; bounded ActionProposal intent; optional EvidenceGraph; lazy context; sequential-first scheduling and milestone checkpoints. Retain approved shared Kernel + Coding/Video autonomy, Host fencing, K/O/H transactions, actual Coding execution-view evidence, budget and Completion Guard.

**G0 remains OPEN; G1–G5 NOT RUN. ADP-03–11 remain OPEN.** Specific implementation choices remain open for multi-aggregate transaction isolation, Host grant/OS proof, sandbox file view and Provider maximum-charge certificates.

### Current Draft PR #1 G0 Owner choices (all OPEN)

- **Provider ambiguity / cost:** approve whether a Provider adapter can claim **exact request identity plus server-side execution-and-billing dedup within a verified lifetime**. Without that proof, Gateway must never automatically retransmit a possibly submitted request; `ProviderOutcomeUnknown` and original reservation remain. A distinct replacement Attempt needs explicit admission, separate budget and reconciliation of hosted external effects. Decide Provider-specific hard/soft compatibility, cancellation/status authority and maximum unresolved cost hold.
- **Host revocation window:** decide allowed R0/R1 request-to-HostFenceInstalled/expiry exposure, measurable grant TTL/clock-skew/liveness and fence ACK target, and whether any risk class requires **zero post-K-request launch** (unsupported by local fence only). Decide R2 high-risk effect map, default disabled exceptions and drain/cancel authority.
- **Verification Host baseline:** prefer enforceable read-only sealed SourceSnapshot and disjoint writable build/test outputs, with authenticated ExecutionViewManifest. Approve OS/toolchain/profile support; no automatic full file tracing, writable protected overlay or distributed transaction framework. An unsupported toolchain stays Unverified until a separate alternative passes G2.
- **G1/G2 proof:** [Core protocol](../contracts/core-protocol.md) M1–M6, R5–R7 and S1–S3 are **specified but NOT RUN**; no G0 acceptance, runtime authorization or numerical safety target is inferred.

## 1. Approved product direction

- One shared Agent Kernel supports Autonomous Coding and Autonomous Video Editing.
- Domain Intelligence remains independent: RepositoryModel for Coding; MediaProjectModel for Video.
- Domain Execution uses separate domain capability sets over shared Kernel admission, budgets, Journal, Trusted ToolHost, cancellation, recovery, and completion controls.
- Each Task binds one immutable Workflow Profile version at a time.
- Video Editing first phase is natural-language-driven automatic editing, not a full visual editor.
- Multi-Agent / D9 remains deferred and unauthorized.
- Current work remains architecture research and documentation only.

See [unified domain direction](unified-domain-direction.md).

## 2. Shared Kernel contracts

**PROPOSED — owner review pending.**

- Which fields belong in the minimal common GoalContract/PlanRevision envelope versus typed domain payloads?
- How should DomainBinding and Workflow Profile versions be accepted, revoked, migrated, and recovered, including the dispatch-time current-version gate and UNKNOWN hold?
- What is the minimal generic artifact envelope needed for both code and media deliverables?
- Which non-token resource dimensions can be hard-enforced across supported hosts?
- How should long-running jobs and progress events be represented in the common ToolInvocation/Host lifecycle?
- How should cross-domain linked tasks exchange exact immutable ArtifactRefs with scoped authorization and no inherited producer permissions or context?

See [Domain Workflow contract](../contracts/domain-workflow.md) and the proposed dispositions in [ADP-03, ADP-04, ADP-08, and ADP-09](architecture-decision-proposals.md).

## 3. Autonomous Coding domain

**PROPOSED — retained first/second-round design; owner review pending.**

- Which plan-switch UNKNOWN cases can a future Host prove non-blocking?
- What exact protected GoalContract fields and confirmation policy should apply to different risk classes?
- What evidence-independence level should each criterion risk class require?
- How should semantic plan quality and RepositoryModel sufficiency be measured without moving those judgments into Kernel?
- What is the minimum useful PlanStep granularity for cross-package and migration work?
- Which task suite and hidden-test design best expose plan churn, false completion, and weak debugging?

See [Coding design](../research/autonomous-coding-agent/design.md), [Coding reference review](../research/autonomous-coding-agent/reference-review.md), and [Coding evaluation](../research/autonomous-coding-agent/evaluation.md).

## 4. Autonomous Video Editing domain

**PROPOSED — first-phase design and contracts drafted.**

- What typed timeline schemas, deterministic compiler mappings, and per-operation evidence obligations are required to implement the ADP-01-approved core operation set?
- Which exact analysis kinds and minimum evidence scopes should each initial task family declare under the approved ADP-02 progressive-analysis policy, and which provider/model capabilities can satisfy them?
- How should source PTS, VFR conversion, audio sample alignment, exact conversion records, and operation-specific rounding be represented across supported media?
- Which output profiles/containers/codecs should be offered initially?
- Which media checks are deterministic and which require independent model/human review?
- How much preview/contact-sheet interaction is useful without building a full editor?
- Which subjective edit-quality criteria require human acceptance?
- Which render resource limits and segmented-render strategies are practical across hosts?
- What NarrativePlan beat schema and factual/chronology guardrails support different editing genres without imposing one story template?
- Which moment-ranking dimensions and conflict-resolution policy should be used; how should salience, message relevance, context value, continuity, and duration trade off?
- What task-family-specific evidence sufficiency and confidence calibration are appropriate, and what raw frame/audio/transcript retention/privacy settings satisfy data minimization?
- Which MediaAnalysis/MediaProjectModel versions may be carried forward when source assets are unchanged but analysis methods or proxies change?
- Which exact EvidenceCarryForward checks are required when a TimelineRevision changes only a subset of beats/clips?
- What FFmpeg demuxer/decoder/filter/protocol allowlists and input media matrix are acceptable for the first profile?
- Which Host profiles can enforce filesystem/network isolation, process-tree convergence, CPU/memory/disk/output limits, and receipt authenticity?
- How should cancellation-vs-success races and Host crash windows be reconciled when process identity or output state is unavailable?
- Which output-interval-to-source-interval provenance map is required for transitions, generated overlays, audio beds, and external ingredients?
- Which criteria require blind human review, external assurance, or a user approval before publication?
- Which public datasets (MEDit-Bench, QVHighlights, TVSum, or others) are suitable components of a rights-cleared project task set?

See [Video Editing design](../research/multimedia-domain-architecture/design.md), [Video Editing Intelligence](../research/multimedia-domain-architecture/intelligence.md), [MediaProject contract](../contracts/media-project.md), [Media Timeline contract](../contracts/media-timeline.md), [RenderPlan security contract](../contracts/render-plan-security.md), [RenderJob contract](../contracts/render-job.md), and [Video evaluation](../research/multimedia-domain-architecture/evaluation.md). The second-round recommendation and change map are in [Second-round architecture revision](second-round-architecture-revision.md). ADP-01 and ADP-02 approvals are recorded in the [Decision Log](decision-log.md); ADP-03 through ADP-11 remain open in [Architecture Decision Proposals](architecture-decision-proposals.md).

## 5. Reference implementation applicability

**REVIEWED AT THE EXECUTION-LAYER LEVEL; ADOPTION DECISIONS PROPOSED.**

- Pi, Codex, DeepSeek Harness, and Claude Agent SDK provide transferable patterns for loops, session/event lifecycles, user control, tool scheduling, permissions, context, and observability.
- None establishes the complete Kernel authority, Host receipt, UNKNOWN recovery, or criterion-level completion contract required here.
- None supplies a complete Video Editing domain model or proves perceptual editing quality.

See [Shared Kernel reference review](../research/shared-kernel/reference-review.md).

## 6. Runtime, language, persistence, and Host

**OPEN.**

- Runtime/language/package manager/module system/build stack.
- Event journal, aggregate reconstruction, transaction isolation, fsync/durability, inbox/outbox, checkpoint co-commit, migrations, backup, and crash recovery.
- OS identity binding, process-tree containment, namespaces/seccomp/cgroups, filesystem/network confinement, workspace/media snapshots, receipt authenticity, and cross-platform support.
- Generic artifact storage, large media/proxy storage, retention, and streaming.
- FFmpeg packaging/build policy and media-analysis provider/model selection.
- Deployment and application surfaces.

No technology is selected by implication.

## 7. Evaluation

**PROPOSED METHOD; NO BASELINE RUN.**

- Coding and Video require separate task sets, metrics, baselines, and domain-quality thresholds.
- Shared Kernel safety/authority/lifecycle/recovery metrics are defined once and measured across both domains.
- Numeric Kernel safety/service thresholds are selected only after the implementation environment and measured fault-injection baselines exist.
- Domain-quality thresholds are selected only after each domain's frozen task set and measured baseline exist.
- Real-model and external-media benchmark runs require separate explicit authorization.

See [Coding evaluation](../research/autonomous-coding-agent/evaluation.md), [Video evaluation](../research/multimedia-domain-architecture/evaluation.md), and [Shared Kernel evaluation](../research/shared-kernel/evaluation.md).

## 8. Extensions and Multi-Agent

- Extension host isolation and lifecycle: **OPEN**.
- Multi-Agent / D9, ChildTask ownership, distributed workers, and capability inheritance: **DEFERRED / NOT AUTHORIZED**.
- Full visual Video Editor and professional post-production workstation: **DEFERRED / OUT OF FIRST-PHASE SCOPE**.

## 9. Decision record requirements

For each future decision, record:

- problem and constraints;
- alternatives considered;
- source evidence and tested versions;
- trade-offs and failure modes;
- security and recovery implications;
- recommendation and rejected alternatives;
- validation plan and acceptance criteria;
- status and explicit owner approval.

Do not silently turn an experiment result into a permanent decision.
