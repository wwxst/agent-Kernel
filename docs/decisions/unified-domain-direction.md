# Unified Agent Kernel — approved product direction

> **Status: APPROVED PRODUCT DIRECTION; ARCHITECTURE DETAILS PROPOSED.** This record captures the owner's explicit decision to develop Autonomous Coding and Autonomous Video Editing over one shared Agent Kernel. It does not approve runtime implementation or a final technology stack.

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

The first Video Editing capability is **natural-language-driven automatic editing**:

- ingest and inspect source media;
- analyze useful visual/audio/temporal evidence;
- interpret editing instructions;
- create and persist a canonical timeline revision;
- render through FFmpeg;
- inspect the actual rendered video;
- accept natural-language revisions and produce new versions;
- deliver the rendered output and supporting timeline/verification artifacts.

This is not a full video editor.

Explicitly excluded from the first phase:

- full visual nonlinear editor or manual multitrack editing workstation;
- advanced effects/compositing/color-grading/VFX workstation;
- Multi-Agent / D9;
- runtime implementation during the current research stage.

The exact minimum editing operation set and optional caption/title/audio features remain open for detailed scope review.

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
