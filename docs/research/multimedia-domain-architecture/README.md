# Multimedia Domain Architecture

> **Status: PROPOSED domain design — aligned to an APPROVED product direction.** The Video Editing first-phase scope is natural-language-driven automatic editing, not a full video editor. No Runtime implementation or technology stack is authorized.

## 1. Objective

Add Autonomous Video Editing as a second domain of the existing Agent Kernel while retaining the Autonomous Coding research.

The architecture uses one shared Kernel and separate domain intelligence:

- Coding uses RepositoryModel, coding workflow policy, code tools, and code verification.
- Video Editing uses MediaProjectModel, editing workflow policy, media tools, timeline artifacts, FFmpeg rendering, and media verification.

## 2. Documents

- [Video Editing domain design](design.md) — scope, MediaProjectModel, workflow, timeline, render, verification, and natural-language revision.
- [Video Editing evaluation protocol](evaluation.md) — task families, quality/safety metrics, and staged baseline method.
- [Unified domain architecture](../../architecture/domain-architecture.md) — the shared Kernel and three-layer platform model.
- [Domain Workflow binding contract](../../contracts/domain-workflow.md) — immutable Workflow Profile and typed domain payload bindings.
- [Media Timeline artifact contract](../../contracts/media-timeline.md) — persistent timeline revisions and rational time representation.
- [RenderJob contract](../../contracts/render-job.md) — long-running FFmpeg execution, resource accounting, cancellation, recovery, and output checks.

## 3. First-phase boundary

**In scope:** ingest and probe source media, build a MediaProjectModel, analyze shots/scenes/audio/transcript, interpret editing intent, generate and revise a timeline, render through FFmpeg, inspect the rendered output, and deliver the result plus its timeline/verification artifacts.

**Not in scope:** a complete visual editor, manual multitrack editing workstation, advanced VFX/compositing/color-grading suite, plugin marketplace, Multi-Agent / D9, or Runtime implementation in this research phase.

## 4. Research discipline

The design uses official FFmpeg/ffprobe documentation and PySceneDetect documentation to ground media probing, filtergraph rendering, progress reporting, and shot-boundary detection. These tools do not by themselves provide semantic editing intelligence or prove perceptual quality.

All concrete media models, workflow policies, quality thresholds, and implementation choices remain proposed or open until reviewed and evaluated.
