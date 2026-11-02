# Autonomous Video Editing — Domain Architecture

> **Status: PROPOSED domain design.** The owner has approved the product direction and first-phase scope: natural-language-driven automatic editing, not a full video editor. This document defines the domain proposal; runtime behavior, quality, and implementation choices remain unverified/open.

## 1. Product goal and scope

Build a Video Editing domain that accepts natural-language editing instructions and source media, analyzes the material, constructs a timeline, renders a finished video, checks the result, and supports further natural-language revisions.

The system is an autonomous editing workflow, not a manual editor.

### 1.1 First-phase capabilities

The first useful vertical slice should cover:

1. Accept source media and a natural-language editing request.
2. Probe media files and identify usable streams and technical properties.
3. Analyze shots/scenes and useful visual/audio/transcript evidence.
4. Convert the user's intent into a versioned GoalContract.
5. Select source ranges and construct a versioned timeline.
6. Compile the timeline into a bounded render plan and render with FFmpeg.
7. Inspect the actual rendered file against technical and user-facing criteria.
8. Deliver the video, timeline revision, render manifest, and verification report.
9. Accept a follow-up natural-language instruction and create a new timeline/render revision.

The minimum useful edit operations should start with source-range selection, trim, reorder, concatenate, simple transitions, simple audio handling, and output-profile constraints. Captions/titles and richer audio treatment are candidate extensions within the automatic-editing scope, but their exact inclusion and priority remain **OPEN**.

### 1.2 Explicit non-goals

- Full visual nonlinear editor, manual timeline manipulation, multi-track drag-and-drop workspace, or professional editor UI.
- Advanced compositing, motion graphics, keyframe animation, 3D/VFX, advanced color grading, or a general effects workstation.
- Multicam editing, collaborative editor sessions, plugin marketplace, user-authored editing scripts, or NLE project-format compatibility.
- Multi-Agent / D9 or distributed specialist agents.
- Runtime implementation or final language, database, deployment, or media-analysis model selection.

A preview, contact sheet, simple asset list, or approval surface may be useful in a future application layer; none of these implies building a full editor. The timeline is a canonical machine-readable artifact, not a GUI editor.

## 2. Domain boundary in the unified platform

Video Editing is a separate Domain Intelligence and Domain Execution profile over the shared Agent Kernel.

| Shared Kernel | Video-specific |
| --- | --- |
| Task, Turn, Step, ModelStep, Attempt | MediaProjectModel |
| GoalContract/PlanRevision envelopes and lifecycle | Editing intent interpretation and story/pacing model |
| ToolInvocation, permission, budget, Journal | Media ingest/probe/analysis tools |
| Trusted ToolHost process control and receipts | TimelineRevision and RenderPlan |
| Cancellation, UNKNOWN reconciliation, checkpoint | FFmpeg render and media-specific resource profile |
| Artifact identity and delivery | Media quality verifier and video deliverables |
| Completion Guard envelope | Video acceptance criteria and perceptual review |

The Video Workflow Profile binds the media schemas, tool snapshot set, resource policy, output profile, and verification obligations. Kernel remains unaware of the semantics of a shot, a scene, pacing, or narrative coherence.

## 3. Video GoalContract

The common GoalContract envelope is defined by the shared domain contract. The Video payload should capture, where relevant:

- source asset set and allowed source boundaries;
- requested outcome/story, intended audience or use, tone, and pacing;
- desired duration or duration range;
- aspect ratio/orientation and output delivery profile;
- required scenes, people/objects/events described by the user, or content that must be included;
- content that must be excluded or retained unchanged;
- audio/music/voice expectations and any source-audio constraints;
- caption/subtitle/title expectations;
- user-provided style references and their provenance;
- quality, privacy, licensing, storage, and delivery constraints;
- assumptions and unresolved ambiguities.

The system should ask a focused question when ambiguity could materially change the story, source selection, duration, output format, or user-visible content. Low-risk reversible choices may be disclosed as assumptions when the Workflow Profile permits them.

A new user instruction is an append-only EditIntent. It does not overwrite the original request or silently mutate the accepted GoalContract. Protected changes use the existing confirmation and GoalContract version rules.

## 4. MediaProjectModel

MediaProject is the persistent domain container for source assets, derived analysis/proxy artifacts, timelines, render records, and verification reports. It groups durable artifacts across editing Tasks but is not execution authority.

MediaProjectModel is the Video domain's structured, provenance-aware projection of that project and its media evidence. It is not a media database or execution authority.

### 4.1 Source assets and streams

Each MediaAsset should reference:

- stable asset ID, original source reference, content digest, file size, and ingest time;
- container/format and probe result version;
- stream IDs and stream types;
- video dimensions, pixel aspect ratio, frame-rate metadata, time base, duration, start time, rotation/display transform, and color metadata where available;
- audio sample rate, channel layout, duration, time base, and stream metadata where available;
- subtitle/data stream information where present;
- decode/probe warnings and unsupported/corrupt regions;
- immutable source path/object reference and any derived proxy relationship.

The source file is treated as immutable input. Proxies, thumbnails, waveforms, extracted audio, and normalized media are derived artifacts with their own digests and transformation provenance.

### 4.2 Content and temporal analysis

The model may include:

- shot/scene boundaries and confidence/quality metadata from the actual detector;
- representative frame references and timestamps;
- visual summaries, objects/actions/events described at the level needed for editing;
- transcript segments, language, timestamps, and alignment evidence;
- audio events, silence/music/speech regions, loudness summaries, and speaker-turn boundaries where supported;
- user-defined inclusion/exclusion labels and references;
- cross-links from each derived claim to source asset, stream, timestamp range, analysis tool/model version, and raw evidence.

A shot-boundary detector is not a semantic scene-understanding system. A transcript is not proof that the corresponding visual event is present. The model must preserve UNKNOWN when evidence is insufficient.

### 4.3 Freshness and invalidation

MediaProjectModel claims bind to source content digest, stream identity, analysis version, proxy digest, and timestamp/timebase. If a source asset changes, a proxy is regenerated, or the analysis pipeline/version changes, dependent claims become stale and affected timeline revisions require revalidation.

The model is a Context Engine projection. It does not authorize file access, rendering, or publication.

## 5. Natural-language editing workflow

Proposed end-to-end flow:

1. **Intake:** capture user intent, source assets, output constraints, and ambiguity in a versioned GoalContract.
2. **Ingest and probe:** validate source access, fingerprint files, inspect streams/metadata, and record decode/probe warnings.
3. **Analyze:** create only the analysis needed for the task—representative frames, shot boundaries, audio/transcript segments, and content observations.
4. **Build MediaProjectModel:** link all facts and hypotheses to source timestamps, assets, tools, versions, and freshness.
5. **Plan:** create a domain PlanRevision with outcome-oriented steps such as probe assets, analyze media, select ranges, create timeline, render, inspect output, and deliver.
6. **Timeline candidate:** select source ranges and order, define tracks/overlaps/transitions/audio/captions as required, and validate timeline structure.
7. **Render planning:** compile the accepted TimelineRevision into a deterministic RenderPlan bound to source digests, FFmpeg build, arguments/filtergraph, environment, output profile, and resource estimate.
8. **Render:** admit a long-running RenderJob through Kernel and execute through Trusted ToolHost.
9. **Inspect:** run technical media checks and criterion-specific content/perceptual review against the actual output.
10. **Deliver:** publish only validated output artifacts and the corresponding report.
11. **Revise:** convert follow-up instructions into new EditIntent, TimelineRevision, RenderPlan, RenderJob, and VerificationReport versions.

The common PlanRevision switch barrier applies when the user changes the goal or when an existing timeline/render plan is superseded. Already-started renders must drain or reconcile; conflicting UNKNOWN outputs block a new render publication.

## 6. Timeline as a persistent engineering artifact

The canonical timeline is a non-destructive, immutable, versioned description of the edit. It binds source asset IDs and digests, stream IDs, source PTS ranges, exact time bases, timeline placement, tracks, clips, transitions, overlays, audio treatment, and output profile.

Use integer timestamps and rational time bases rather than floating-point seconds as the canonical frame-accurate representation. Preserve variable-frame-rate source PTS. A source clip range is end-exclusive; timeline placement uses integer ticks against an explicit rational timebase.

Every timeline revision binds its parent revision, user EditIntent, GoalContract, PlanRevision, DomainBinding, source digests, and validation evidence. Previous timelines and renders remain immutable. A follow-up such as “make the opening shorter” produces a new revision and a semantic change set; it does not overwrite the previous project state.

See [Media Timeline artifact contract](../../contracts/media-timeline.md).

## 7. FFmpeg rendering and long-running execution

FFmpeg is the first-phase rendering backend named by the product direction. The canonical timeline remains independent from FFmpeg-specific command/filtergraph syntax.

A deterministic compiler converts validated timeline operations into a bounded RenderPlan. The model does not generate an arbitrary shell command. The RenderPlan binds:

- TimelineRevision digest and source asset/stream digests;
- selected streams and exact temporal ranges;
- filtergraph and transform parameters;
- FFmpeg version/build and environment identity;
- canonical argv/argument digest;
- output profile and unique temporary output target;
- resource estimate/reservation and verification plan.

A RenderJob is a long-running Host execution record. It uses the shared ToolInvocation, hard budget, durable intent, Host Ledger, process-tree containment, cancellation, receipt, and UNKNOWN reconciliation contracts.

Important boundaries:

- Render progress is telemetry, not completion.
- Cancellation is not complete until the Host proves process-tree/handle convergence.
- A Host crash or missing receipt can leave an UNKNOWN render; do not blindly replay.
- A partial output is quarantined and never delivered as a successful artifact.
- Arbitrary FFmpeg encodes are not assumed checkpoint-resumable. The first implementation should restart a reconciled failed render as a new invocation unless a separately verified segmented-render contract is introduced.
- Render output is staged at a unique temporary target and only published after required technical and content checks.

See [RenderJob contract](../../contracts/render-job.md).

## 8. Verification: validate the video, not only the process

A successful FFmpeg exit is necessary execution evidence but not sufficient evidence that the user received the requested edit.

### 8.1 Structural and technical checks

Depending on the accepted output profile:

- container can be probed and the output file is complete/non-empty;
- expected video/audio/subtitle streams exist;
- codec, dimensions, aspect ratio, frame rate/timebase, duration, sample rate, and channel layout match declared tolerances;
- packets/frames decode without truncation or corruption under the required scan policy;
- audio/video synchronization and subtitle timing are within declared bounds;
- no unintended black/frozen segments, silence gaps, clipping, or loudness violations are present where criteria require those checks;
- output digest and final artifact receipt are recorded.

### 8.2 Timeline and content checks

- source ranges are valid and all required clips are present;
- selected content, order, and exclusions match the GoalContract;
- duration and pacing constraints are met;
- transitions, captions, titles, and audio treatment match the accepted timeline;
- the rendered output corresponds to the exact accepted TimelineRevision and RenderPlan.

### 8.3 Perceptual and human assurance

A fresh Video Verifier receives the original UserIntent, accepted GoalContract/PlanRevision, TimelineRevision, current render, sampled frames/audio/transcript evidence, and raw probe/decode results. It must not rely on the editor's self-assessment as evidence.

The verifier can report content mismatches, poor pacing, abrupt or confusing cuts, unreadable captions, obvious audio/visual artifacts, and insufficient evidence. Its opinion is a review finding, not a technical test result or criterion Pass.

Subjective style, narrative quality, sensitive content, or other criteria may require explicit human review. The criterion contract defines the required evidence-independence class.

## 9. Natural-language revision loop

The user may continue with instructions such as:

- “把开头缩短一些，直接进入主题。”
- “中间这段删掉，保留后面的采访。”
- “节奏再快一点，但不要删掉关键内容。”
- “字幕改大一些，音乐音量降低。”

These are examples of interaction shape, not a promise that every editing operation is supported in the first slice.

Each instruction creates an immutable EditIntent and a candidate TimelineRevision. The system identifies affected clips, ranges, tracks, criteria, and verification obligations; reuses only still-current source analysis; and renders a new version. The prior timeline and video remain available as historical artifacts.

Ask the user when the instruction has multiple materially different interpretations or changes a protected output/scope/risk field. Do not silently add external assets, overwrite original sources, or publish over a prior deliverable.

## 10. Failure model

| Failure | Required response |
| --- | --- |
| Unsupported/corrupt source | Record probe/decode evidence; ask for another source or a supported conversion within authorization |
| Ambiguous editing intent | Ask a focused clarification; do not invent story-critical content |
| Weak scene/transcript evidence | Preserve UNKNOWN and request analysis or user input |
| Invalid source range/timebase | Reject timeline candidate and rebuild from current source evidence |
| Render resource exhaustion | Settle usage, preserve partial output as quarantined evidence, revise budget/plan only with authorization |
| FFmpeg failure | Classify failure, inspect stderr/receipt, form a new hypothesis; do not repeat blindly |
| Host crash or lost receipt | Reconcile process and output state; preserve UNKNOWN until resolved |
| Technically valid but semantically wrong output | Fail criterion-level review, create a new TimelineRevision, and rerender |
| User changes instructions during render | Record new intent; reconcile/cancel old render; do not let stale output replace the newer target |
| Output verification failure | Do not deliver as complete; repair timeline/render or ask for human review |

## 11. Open decisions

- Minimum first-phase editing operations and exact support boundaries.
- Which visual/audio/transcription analysis capabilities are required for the first task families.
- How to represent source PTS, VFR conversion, audio sample alignment, and rounding across supported media formats.
- Which output profiles/containers/codecs should be offered initially.
- Which media checks are deterministic and which require model/human review.
- How much preview/contact-sheet interaction is needed without building an editor.
- How to define objective or blinded human scoring for subjective edit quality.
- Which resource limits and segmented-render strategies are practical across target hosts.

No threshold or technology choice is inferred merely from this design draft.


## 12. Media execution references and limits

The media execution proposal is grounded in the following official documentation:

- [FFmpeg documentation](https://ffmpeg.org/ffmpeg.html) describes stream selection, simple/complex filtergraphs, and machine-readable progress output. Its progress records are execution telemetry, not content-quality evidence.
- [ffprobe documentation](https://ffmpeg.org/ffprobe.html) describes machine-readable container, stream, packet, and frame inspection. Probe success establishes inspectability and metadata facts, not that the requested story or pacing is correct.
- [PySceneDetect documentation](https://www.scenedetect.com/docs/latest/) describes shot-change detection and splitting. Shot boundaries are useful temporal evidence but do not by themselves establish semantic scene understanding.

The first phase uses FFmpeg as the named render backend. It does not select the media-analysis model/provider, storage system, packaging strategy, or host deployment.
