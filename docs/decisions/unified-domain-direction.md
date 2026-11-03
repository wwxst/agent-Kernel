# Unified Agent Kernel — approved product direction

> **Status: APPROVED PRODUCT DIRECTION (2026-11-02); construction baseline accepted under ARB-01 (2026-11-03).** This record captures the owner's explicit one-Kernel/two-domain decision and the revised first-phase autonomous-editing capability boundary. It does not approve Runtime implementation or a final technology stack.

## 1. Approved direction

Project: **wwxst/agent-Kernel — Unified Autonomous Agent Kernel**

One Kernel, two initial autonomous execution domains:

- **Autonomous Coding:** understand code repositories, plan changes, modify code, run tests, debug/repair, verify, and deliver code.
- **Autonomous Video Editing:** understand editing instructions, analyze source media, plan and generate a timeline, render, inspect the finished video, and deliver the video.

The domains share the Agent Kernel and execution controls. They do not share one forced semantic model.

## 2. Approved architectural principles

1. Use one shared Kernel for Task/Turn/Step lifecycle, model access, planning envelopes, scheduling, permissions, budgets, Journal, Tool Runtime, Trusted ToolHost, cancellation, recovery, verification envelope, and delivery.
2. Keep Domain Intelligence independent:
   - Coding uses RepositoryModel and coding-specific planning, debugging, and verification.
   - Video Editing uses MediaProjectModel and media/timeline-specific planning, editing, and verification.
3. Keep Domain Execution capability sets independent while using the same Kernel admission, budget, Host process, receipt, cancellation, and recovery controls.
4. Use separate immutable Workflow Profiles for each domain.
5. Reuse common GoalContract and PlanRevision envelopes with typed domain payloads; do not force domain-specific cognition into Kernel.
6. Keep Coding and Video task evaluation separate while measuring shared Kernel safety/recovery properties across both.

## 3. Approved Video Editing first-phase scope

ADP-01 was **REVISED and approved on 2026-11-02**. The first Video Editing capability is a **complete natural-language autonomous-editing loop within a bounded core operation set**, not a collection of individually invoked tools:

- ingest, fingerprint, and technically probe user-supplied source media;
- perform task-conditioned basic video/content/shot analysis under the four-stage progressive-analysis and modality-scoped coverage policy approved by ADP-02;
- identify and select task-relevant moments/highlights;
- interpret editing instructions and create a basic, genre-flexible NarrativePlan;
- trim, reorder, hard-cut, concatenate, apply simple fade/crossfade, and perform limited source-audio preserve/mute/gain/fade operations;
- generate an immutable TimelineRevision and render through a bounded FFmpeg RenderPlan;
- inspect the actual rendered artifact against technical and task/content criteria;
- accept natural-language revisions, create new versions, re-render, re-verify, and deliver the video with supporting timeline/verification/provenance artifacts.

Within the accepted GoalContract, authorized source set, operation boundary, and resource envelope, the Agent should make ordinary editing decisions autonomously rather than asking the user to specify every clip or tool call. It must clarify or stop safely for material ambiguity, insufficient evidence, unauthorized scope, material factual risk, or exhausted budget.

Advanced multi-objective highlight ranking, rich cross-scene narrative reasoning, advanced semantic continuity, music-aware pacing, generated captions/titles, music generation/acquisition, multi-track mixing, complex effects, and professional post-production remain outside the first phase. Output-format/platform adaptation is separate from story editing. External upload/publication requires separate authorization.

This is not a full video editor. Explicitly excluded are:

- full visual nonlinear editor or manual multitrack editing workstation;
- advanced effects/compositing/color-grading/VFX workstation;
- Multi-Agent / D9;
- Runtime implementation during the current research stage.

The ADP-01 and ADP-02 decisions are recorded in the [Decision Log](decision-log.md). ADP-03 through ADP-11 remain OPEN. ADP-01 approves the Video capability boundary; ADP-02 approves the progressive-analysis and coverage policy. Neither approves remaining artifact-storage, temporal, output, verification, resource, handoff, interaction, or implementation decisions.

## 4. Retained work

The existing Autonomous Coding Agent first- and second-round research is retained. It becomes the Coding Domain Intelligence design, not the complete platform architecture.

The shared Kernel contracts remain the starting point and are to be reconciled with the new DomainBinding/Workflow Profile contract.

## 5. Current authorization boundary

Authorized now:

- architecture research;
- reference implementation review;
- cross-domain contract design;
- media/timeline/render/verification contract proposals;
- documentation and index/roadmap updates;
- cross-domain consistency review.

Not authorized by this decision:

- Runtime code or production dependency changes;
- final language/runtime/database/deployment selection;
- real-model benchmark runs or media processing on external assets;
- legacy code migration;
- Multi-Agent / D9;
- creating a full video editor.

A later implementation or execution phase requires a separate explicit approval.

## 6. Next review gate

Submit one coherent cross-domain architecture proposal after:

1. the common Kernel and DomainBinding contracts are reconciled;
2. Coding and Video domain boundaries and artifacts are explicit;
3. the MediaProjectModel, TimelineRevision, and RenderJob contracts are reviewed;
4. long-running render/cancel/recovery and media verification are consistent with Trusted ToolHost and Completion Guard;
5. reference implementation findings are recorded with source versions and applicability limits;
6. Coding and Video evaluation protocols are independently specified;
7. cross-document links, terminology, scope, and authority boundaries are checked.

Approval of the product direction is not the same as approval of every proposed contract or implementation detail.
