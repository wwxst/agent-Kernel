# Autonomous Video Editing — Evaluation and Experiment Protocol

> **Status: PROPOSED.** This document defines a staged evaluation method for the Video Editing domain. No runtime, benchmark, or quality result is reported.

## 1. Evaluation objective

Measure whether the Video Editing domain can transform natural-language instructions and source media into a technically valid, content-faithful, coherent rendered artifact, revise it correctly after user feedback, and do so within authorized resources.

The primary result is not “FFmpeg returned zero.” It is verified fulfillment of the accepted editing criteria.

## 2. Task families

Prepare a reproducible task set with pinned source assets, source digests, prompts, output constraints, acceptance criteria, and hidden or independently authored review material.

Candidate task families:

1. **Single-source highlight edit:** select a short set of useful moments from one long recording.
2. **Multi-source montage:** combine clips from multiple assets in a specified order/story.
3. **Instruction-constrained cut:** include required events and exclude specified segments.
4. **Interview/talk edit:** preserve semantic continuity while removing pauses or redundant material.
5. **Pacing revision:** shorten/lengthen sections without losing required content.
6. **Audio-aware edit:** preserve dialogue, reduce silence, balance source audio/music, and check sync.
7. **Caption/title edit:** generate or apply captions/titles under explicit language and readability criteria, if included in the first-phase scope.
8. **Format adaptation:** create a specified duration/aspect/orientation/output profile.
9. **Difficult media:** mixed frame rates, variable frame rate, multiple audio streams, rotation metadata, unusual timebases, damaged inputs, or long media.
10. **Natural-language revision:** after an initial render, provide a follow-up edit instruction and evaluate whether the new revision changes only the intended parts.
11. **Recovery task:** interrupt a long render, restart the Host, lose a receipt, cancel during execution, or exhaust a resource budget; verify safe reconciliation.
12. **Adversarial/ambiguous task:** contradictory inclusion/exclusion instructions, ambiguous time references, missing source content, or prompt-injection-like text embedded in media metadata/subtitles.

Each task should specify the required evidence classes and any criteria requiring human review.

## 3. Experimental controls

Pin and record:

- source asset IDs, content digests, stream metadata, and licensing/provenance declarations;
- GoalContract and EditIntent versions;
- Workflow Profile and tool-definition snapshots;
- model/provider and relevant model settings;
- media-analysis tool/model versions and configuration;
- FFmpeg build/version and exact RenderPlan/argv/filtergraph digests;
- Host environment, OS, CPU/GPU/memory/disk limits, and resource policy;
- output profile, hard budget, timeout, and cancellation policy;
- timeline and render artifact digests;
- verifier version, input evidence manifest, and human-review rubric;
- task-set version, difficulty strata, and random/repeat controls.

Compared systems must receive the same source media, instructions, output constraints, policy, and resource envelope. Report distributions and all failures, not only the best render.

## 4. Primary metrics

| Metric | Definition |
| --- | --- |
| Verified edit success | Required editing criteria pass with current evidence and valid delivery |
| Instruction fulfillment | Human/independent assessment of story, requested content, exclusions, order, tone, and pacing |
| Source-range accuracy | Correctness of selected source clips and temporal boundaries against reference/rubric |
| Timeline validity | Structural invariants, timebase/source-range correctness, and artifact binding |
| Technical output validity | Probe/decode/container/stream/duration/profile checks pass |
| Audio/video integrity | Sync, audio continuity, loudness/clipping and subtitle timing where applicable |
| Perceptual edit quality | Blind reviewer assessment of coherence, pacing, transitions, readability, and obvious artifacts |
| Revision fidelity | Follow-up instruction is applied without unintended changes to protected or unrelated timeline regions |
| False completion | Agent claims a finished edit without the required output/evidence |
| Recovery correctness | Safe cancel, process convergence, UNKNOWN reconciliation, and no duplicate/conflicting publication |
| Resource efficiency | Wall time, CPU/GPU/memory/disk, model cost, render retries, and cost per verified successful edit |
| Human escalation quality | Necessary and timely clarification/review requests, not avoidable interruptions |

Report technical validity and perceptual quality separately. A technically valid file may still be the wrong edit.

## 5. Shared Kernel metrics

Use the same cross-domain safety metrics for Coding and Video:

- unauthorized side-effect attempts and actual executions;
- false-completion rate;
- unresolved UNKNOWN outcomes and age;
- unsafe retry or duplicate-publication attempts;
- cancellation/process-convergence failures;
- resource-budget overshoot and settlement gaps;
- stale GoalContract/PlanRevision/Profile/evidence accepted;
- checkpoint/recovery errors;
- audit-trace completeness and artifact provenance;
- user clarification/approval handling correctness.

A high-severity unauthorized execution or false completion is a safety blocker regardless of average edit quality.

## 6. Video evidence classes

For each criterion, declare one or more required classes:

- **Technical machine evidence:** ffprobe metadata, decode results, stream/timing checks, output digest, render receipt.
- **Timeline machine evidence:** schema validation, source-range checks, duration/track/transition/caption timing validation, timeline-to-render binding.
- **Independent content evidence:** independently authored reference segments, hidden checks, human-labelled source intervals, or a fresh verifier review of raw sampled evidence.
- **Perceptual/human evidence:** blind reviewer assessment or explicit user acceptance when the criterion is subjective and policy requires it.

A model's own summary or aesthetic score cannot stand in for machine evidence or a required human disposition.

## 7. Ablation plan

After a stable baseline exists, vary one capability at a time:

- metadata-only probing versus richer media analysis;
- scene-boundary detection enabled/disabled or alternative detector settings;
- transcript/audio analysis enabled/disabled;
- structured MediaProjectModel versus raw prompt context;
- timeline validation enabled/disabled;
- canonical timeline compiler versus direct command construction (the latter only as a controlled research comparison, never as production authority);
- technical-only verification versus layered technical/content/perceptual verification;
- fresh independent verifier versus implementer self-report;
- no timeline revision lineage versus immutable revisions;
- naive render retry versus Host reconciliation and unique output staging;
- no render-progress/recovery handling versus typed long-running RenderJob;
- no natural-language revision loop versus versioned EditIntent and TimelineRevision.

Do not introduce Multi-Agent / D9 as a baseline dependency.

## 8. Staged evaluation gates

| Stage | Required output | Gate |
| --- | --- | --- |
| Architecture design | Metric definitions, task families, safety floors, evidence classes, and experiment method | Owner review; no runtime result implied |
| Task-set preparation | Pinned assets, task prompts, criteria, difficulty strata, reference intervals/rubric, hidden checks | Freeze task-set and rubric before comparisons |
| Baseline | Declared reference system or first controlled implementation on the frozen set | Publish distributions, failure taxonomy, and confounders |
| Target confirmation | Proposed quality/safety thresholds based on measured baseline and intended risk | Explicit owner approval; do not backfill thresholds |
| Formal evaluation | Repeated comparisons, ablations, recovery/fault-injection and regression runs | Publish all outcomes and confidence limits |

The architecture-level evaluation method can be reviewed before a benchmark baseline exists. Runtime and real-model baseline runs require separate explicit authorization of provider, assets, workspace isolation, tools, network, budgets, and stop conditions.

A fixture-only renderer/provider test is useful for contract checks but is not a real-model editing-quality baseline. Target thresholds remain OPEN until the baseline stage.

## 9. Current status

- Video Editing runtime: **NOT STARTED**.
- Video task set: **NOT BUILT**.
- Baseline and target thresholds: **NOT RUN / OPEN**.
- Media quality and verifier effectiveness: **UNVERIFIED**.
