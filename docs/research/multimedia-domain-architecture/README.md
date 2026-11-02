# Multimedia Domain Architecture

> **Status: ADP-01 REVISED/APPROVED (2026-11-02); detailed domain architecture PROPOSED.** Video first phase is a complete natural-language autonomous-editing loop within a bounded core operation set, not a full video editor. No Runtime implementation or technology stack is authorized.

## 1. Objective

Add Autonomous Video Editing as a second domain of the existing Agent Kernel while retaining the Autonomous Coding research.

The architecture uses one shared Kernel and separate domain intelligence:

- Coding uses RepositoryModel, coding workflow policy, code tools, and code verification.
- Video Editing uses MediaProjectModel, editing workflow policy, media tools, timeline artifacts, FFmpeg rendering, and media verification.

## 2. Documents

- [Video Editing domain design](design.md) — scope, workflow, and the boundary between core editing, enhanced editorial capabilities, and platform adaptation.
- [Video Editing Intelligence](intelligence.md) — media understanding, candidate moment/highlight selection, NarrativePlan, pacing, continuity, audiovisual coordination, and bounded revision.
- [Video Editing evaluation protocol](evaluation.md) — narrative, selection, continuity, pacing, audiovisual, provenance, technical, and recovery metrics.
- [MediaProject contract](../../contracts/media-project.md) — ProjectSnapshot, MediaAnalysis, MediaProjectModel versioning, and evidence inheritance.
- [Media Timeline contract](../../contracts/media-timeline.md) — immutable TimelineRevision, NarrativePlan binding, timebase, and evidence carry-forward.
- [RenderPlan security contract](../../contracts/render-plan-security.md) — FFmpeg input/protocol, filesystem, filtergraph, network, process, and resource security.
- [RenderJob contract](../../contracts/render-job.md) — Kernel/Host state authority, cancellation, UNKNOWN, crash recovery, and output publication.
- [Unified domain architecture](../../architecture/domain-architecture.md) — the shared Kernel and three-layer platform model.
- [Shared Kernel reference review](../shared-kernel/reference-review.md) — source-grounded comparison of common execution mechanisms.
- [Shared Kernel evaluation](../shared-kernel/evaluation.md) — common safety, authority, lifecycle, budget, and recovery metrics.
- [Cross-domain architecture review](../../decisions/cross-domain-architecture-review.md) — consistency matrix and remaining design questions.
- [Domain Workflow binding contract](../../contracts/domain-workflow.md) — immutable Workflow Profile and typed domain payload bindings.
- [Media Timeline artifact contract](../../contracts/media-timeline.md) — persistent timeline revisions and rational time representation.
- [RenderJob contract](../../contracts/render-job.md) — long-running FFmpeg execution, resource accounting, cancellation, recovery, and output checks.

## 3. First-phase boundary

**Core automatic-editing foundation — ADP-01 REVISED/APPROVED:** ingest/probe; task-conditioned basic video/shot analysis; task-relevant highlight/moment selection; basic NarrativePlan and simple sequencing/pacing; trim/reorder/hard cut/concatenate; simple fade/crossfade; limited source-audio controls; immutable timeline; bounded FFmpeg render; actual-output technical/content checks; natural-language revision, re-render, re-verification, and delivery. Exact analysis policy and typed operation contracts remain OPEN under the relevant ADPs.

**Enhanced editorial capabilities:** advanced multi-objective highlight ranking, rich cross-scene narrative planning, advanced semantic continuity, music-aware pacing, generated captions/titles, music generation/acquisition, multi-track audio mixing, voice synthesis, speed ramps, overlays, reframing, color matching, and advanced perceptual critique. These are roadmap capabilities, not implied core support.

**Post-production/platform adaptation:** codec/container, resolution/aspect/frame-rate/color/audio output, subtitle mux/sidecar, metadata, thumbnail/cover, platform safe areas, packaging, and optional platform delivery. This is a separate Output Profile stage, not editorial intelligence.

**Deferred:** full visual editor/manual multitrack UI, professional VFX/compositing/color-grading workstation, plugin marketplace, Multi-Agent / D9, and Runtime implementation in this research phase.

## 4. Research discipline

The design uses official FFmpeg/ffprobe documentation and PySceneDetect documentation to ground media probing, filtergraph rendering, progress reporting, and shot-boundary detection. These tools do not by themselves provide semantic editing intelligence or prove perceptual quality.

The ADP-01 product capability boundary is approved in revised form; concrete media models, workflow policies, quality thresholds, typed operation contracts, and implementation choices remain proposed or open until separately reviewed and evaluated. See the [Decision Log](../../decisions/decision-log.md).
