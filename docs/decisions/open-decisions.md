# Open decisions

> **Status: Mixed register.** The one-Kernel/two-domain product direction and Video Editing first-phase scope are approved. Detailed cross-domain architecture, domain contracts, technology choices, and implementation decisions remain proposed/open.

The current product direction is recorded in [Unified Agent Kernel — approved product direction](unified-domain-direction.md). The cross-domain architecture proposal is [here](../architecture/domain-architecture.md), and the consistency findings are in [Cross-domain architecture review](cross-domain-architecture-review.md). Candidate recommendations, alternatives, risks, and acceptance criteria are collected in [Architecture Decision Proposals](architecture-decision-proposals.md). That packet is a decision aid only; no item is approved merely because it appears in either document.

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
- How should DomainBinding and Workflow Profile versions be accepted, revoked, migrated, and recovered?
- What is the minimal generic artifact envelope needed for both code and media deliverables?
- Which non-token resource dimensions can be hard-enforced across supported hosts?
- How should long-running jobs and progress events be represented in the common ToolInvocation/Host lifecycle?
- How should cross-domain linked tasks exchange artifacts without sharing domain authority?

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

- What is the minimum editing operation set for the first useful automatic-editing slice?
- Are captions/titles and richer audio treatment part of the first phase or a follow-up?
- Which visual/audio/transcription analysis capabilities are required for initial task families?
- How should source PTS, VFR conversion, audio sample alignment, and rounding be represented across supported media?
- Which output profiles/containers/codecs should be offered initially?
- Which media checks are deterministic and which require independent model/human review?
- How much preview/contact-sheet interaction is useful without building a full editor?
- Which subjective edit-quality criteria require human acceptance?
- Which render resource limits and segmented-render strategies are practical across hosts?

See [Video Editing design](../research/multimedia-domain-architecture/design.md), [Media Timeline contract](../contracts/media-timeline.md), [RenderJob contract](../contracts/render-job.md), and [Video evaluation](../research/multimedia-domain-architecture/evaluation.md). Candidate resolutions are in [ADP-01, ADP-02, and ADP-05 through ADP-10](architecture-decision-proposals.md).

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
