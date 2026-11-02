# Agent Kernel

> **Project status: Unified two-domain product direction APPROVED; ADP-01 Video capability scope REVISED/APPROVED; remaining architecture PROPOSED and under owner review.** The project is one shared Agent Kernel for Autonomous Coding and Autonomous Video Editing. The domain models, workflow profiles, and execution capabilities remain separate. No Runtime implementation or final technology stack is authorized.

## Purpose

Build a unified autonomous Agent platform that can understand different classes of work, create and revise plans, execute through a trusted boundary, recover from interruption, verify the actual deliverable, and return useful artifacts.

The first two domains are:

- **Autonomous Coding** — understand code repositories, plan development work, modify code, run tests, diagnose/repair, and deliver verified code.
- **Autonomous Video Editing** — understand natural-language editing instructions, analyze source media, construct a timeline, render a finished video, inspect the output, and deliver the video.

The product principle is **one Kernel, two independent domains**. Coding and Video share execution authority and lifecycle mechanics; they do not share a forced cognitive model.

## Video Editing capability boundary

The first Video Editing capability is natural-language-driven automatic editing, not a full video editor. The current proposal separates three capability classes:

- **Core automatic-editing foundation — ADP-01 REVISED/APPROVED:** ingest/probe; task-conditioned basic video/shot analysis; task-relevant highlight/moment selection; basic NarrativePlan and simple sequencing/pacing; trim/reorder/hard cut/concatenate; simple fade/crossfade; limited source-audio controls; immutable timeline; bounded FFmpeg render; actual-output technical/content checks; natural-language revision, re-render, re-verification, and delivery. Exact analysis policy and typed operation contracts remain OPEN.
- **Enhanced editorial capabilities:** richer cross-scene narrative planning, semantic continuity, music-aware pacing, generated captions/titles, advanced audio mixing, speed ramps, overlays, reframing, color matching, and deeper perceptual critique. These are roadmap capabilities, not implied first-phase support.
- **Post-production/platform adaptation:** codec/container/resolution/aspect/frame-rate/color/audio profiles, subtitle mux/sidecar, metadata, thumbnails, platform safe areas, packaging, and optional platform delivery. This is a separate output-adaptation stage, not story intelligence.

Deferred: full visual nonlinear editor/manual multitrack workstation, professional VFX/compositing/color-grading suite, plugin marketplace, Multi-Agent / D9, and Runtime implementation during the current research stage.

See [Video Editing Intelligence](docs/research/multimedia-domain-architecture/intelligence.md) and [Second-round architecture revision](docs/decisions/second-round-architecture-revision.md).

## Architecture baseline

The platform has three logical layers:

1. **Shared Agent Kernel** — Task/Turn/Step, GoalContract/PlanRevision envelopes, Model Gateway, Context Engine infrastructure, Tool Runtime, Permission, Budget, Journal, Trusted ToolHost boundary, Recovery, Verification envelope, and Delivery.
2. **Domain Intelligence** — independent Coding Intelligence and Video Editing Intelligence, each with its own domain model, planning semantics, evidence interpretation, and verifier.
3. **Domain Execution** — independent domain tool/capability sets executed under shared Kernel admission, resource accounting, Host process control, cancellation, and receipts.

See [Unified domain architecture](docs/architecture/domain-architecture.md) and [Architecture overview](docs/architecture/overview.md).

## Research map

- [Autonomous Coding Agent design](docs/research/autonomous-coding-agent/README.md) — retained first/second-round Coding Domain Intelligence design.
- [Multimedia Domain Architecture](docs/research/multimedia-domain-architecture/README.md) — natural-language Video Editing design, timeline, render, and evaluation.
- [Video Editing Intelligence](docs/research/multimedia-domain-architecture/intelligence.md) — media understanding, message-conditioned moment selection, narrative planning, pacing, continuity, audiovisual coordination, and revision.
- [Second-round architecture revision](docs/decisions/second-round-architecture-revision.md) — complete revision plan, change mapping, consistency review, and unresolved questions.
- [Shared Kernel reference review](docs/research/shared-kernel/reference-review.md) — Pi, Codex, DeepSeek Harness, and Claude Agent SDK execution-layer review.
- [Shared Kernel evaluation](docs/research/shared-kernel/evaluation.md) — common cross-domain safety, authority, lifecycle, and recovery metrics.
- [Unified domain direction](docs/decisions/unified-domain-direction.md) — owner-approved product scope and authorization boundary.
- [Cross-domain architecture review](docs/decisions/cross-domain-architecture-review.md) — consistency review and remaining questions.
- [Architecture Decision Proposals](docs/decisions/architecture-decision-proposals.md) — recommendations, alternatives, risks, and acceptance criteria for ADP-02 through ADP-11 owner review.
- [Decision Log](docs/decisions/decision-log.md) — authoritative owner dispositions; ADP-01 is REVISED/APPROVED.

## Current state

- Unified one-Kernel/two-domain product direction: **APPROVED**.
- Coding Domain Intelligence: first- and second-round research retained; proposed.
- Video Editing first-phase capability boundary: **REVISED/APPROVED under ADP-01**; detailed Domain Intelligence and contracts remain proposed/open.
- DomainBinding and Workflow Profile contract: proposed.
- MediaProjectModel, TimelineRevision, and RenderJob contracts: proposed.
- Runtime implementation and production dependencies: not started / not authorized.
- Technology choices: open.
- Multi-Agent / D9: deferred and not authorized.
- Legacy code migration: not started.

## Repository rules

- This repository is the sole formal development home for the new Kernel.
- The former repository wwxst/agent- has been deleted by its owner. It is not an available source, dependency, or ongoing project.
- Only knowledge and architecture principles already re-authored in this repository are available; do not assume deleted files, branches, or commits can be recovered.
- No old Git history, old Kernel implementation, obsolete architecture draft, or development-process archive is imported.
- Knowledge may be re-authored when useful; code is not migrated unless it is reviewed independently against this repository's contracts.
- Architecture principles and contracts are versioned here. Unresolved design and technology choices remain explicitly open.
- No production implementation, dependency stack, or security capability is claimed until it is implemented and verified.

## How to work in this repository

Read [AGENTS.md](AGENTS.md) before changing project files. Use [Open decisions](docs/decisions/open-decisions.md) and the research documents to distinguish approved direction, proposed contracts, and unknowns.

The current milestone is cross-domain architecture research and contract reconciliation. Implementation starts only after the relevant contracts, experiments, and scope have been explicitly agreed.
