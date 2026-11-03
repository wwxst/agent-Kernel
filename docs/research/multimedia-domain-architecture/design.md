# Autonomous Video Editing — Domain Architecture

> **Status: MIXED.** The owner REVISED/APPROVED the ADP-01 first-phase scope on 2026-11-02: a complete natural-language autonomous-editing loop within a bounded core operation set, not a full editor. Detailed domain design/contracts remain PROPOSED; runtime behavior, quality, and implementation choices remain UNVERIFIED/OPEN.

## 1. Product goal and scope

Build a Video Editing domain that accepts natural-language editing instructions and source media, analyzes the material, constructs a timeline, renders a finished video, checks the result, and supports further natural-language revisions.

The system is an autonomous editing workflow, not a manual editor.

### 1.1 First-phase capabilities — ADP-01 REVISED/APPROVED

The first phase must complete a natural-language editing task end to end, without requiring the user to specify every clip or individual editing operation:

1. Accept user-supplied source media and a natural-language editing request.
2. Fingerprint and technically probe the source assets; establish usable streams, duration, time bases, and warnings.
3. Perform task-conditioned basic video/content/shot analysis under the ADP-02-approved four-stage progressive policy and modality-scoped coverage contract. Provider/model selection and task-family-specific evidence calibration remain detailed design questions.
4. Identify and select task-relevant moments/highlights with evidence, rationale, and uncertainty.
5. Interpret the request and form a basic, genre-flexible NarrativePlan covering the intended message, useful beats/moments, necessary context, sequence, and simple duration/pacing allocation.
6. Build an immutable TimelineRevision using the bounded core operations: trim, reorder, hard cut, concatenate, simple fade/crossfade, and limited source-audio preserve/mute/per-clip gain/simple fades.
7. Compile a bounded RenderPlan and render through FFmpeg under the Trusted ToolHost contract.
8. Inspect the actual rendered artifact against technical and task/content criteria; a successful FFmpeg exit alone is not acceptance.
9. Accept follow-up natural-language instructions, create new EditIntent/TimelineRevision versions, re-render, re-verify, and preserve prior revisions/evidence.
10. Deliver the video with the relevant timeline, render, verification, and source-provenance artifacts.

Within the accepted GoalContract, authorized source set, core operation boundary, and resource envelope, the Agent makes ordinary editing decisions autonomously. It asks for clarification or stops safely when material ambiguity, insufficient evidence, unauthorized scope, material factual risk, or exhausted budget prevents safe continuation.

ADP-02 freezes the logical progressive-analysis and coverage policy, but does not select providers/models or numeric confidence/performance thresholds. Typed operation schemas, timebase rules, output-profile values, verification policy, resource enforcement, and user preview surface remain governed by ADP-03 through ADP-10.

The scope is separated into three distinct capability classes:

- **Core automatic-editing foundation (ADP-01 REVISED/APPROVED):** source fingerprinting/probing; task-conditioned basic video/shot analysis; task-relevant moment/highlight selection; basic NarrativePlan and simple sequencing/pacing; trim/reorder/hard cut/concatenate; simple fade/crossfade; limited source-audio preserve/mute/gain/fades; immutable timeline; bounded FFmpeg render; actual-output technical/content checks; natural-language revision, re-render, re-verification, and delivery.
- **Enhanced editorial intelligence (not first phase):** advanced multi-objective highlight ranking; rich cross-scene narrative planning; advanced semantic continuity; music-aware pacing/beat alignment; generated captions/titles; music generation/acquisition; multi-track audio mixing/ducking; voice synthesis; advanced loudness mastering; speed ramps; advanced transitions; overlays; reframing; color matching; and richer perceptual critique.
- **Post-production/platform adaptation (separate stage):** codec/container/resolution/aspect/frame-rate/color/audio output profiles, subtitle mux/sidecar, metadata, thumbnails, platform safe areas, packaging, and optional platform delivery. This is not story intelligence; external upload/publication requires separate authorization.

Professional VFX/compositing/color-grading workstations, manual multitrack editing, full NLE UI, plugin marketplaces, and Multi-Agent / D9 remain deferred. See [Video Editing Intelligence](intelligence.md) and the [Decision Log](../../decisions/decision-log.md).

### 1.2 Explicit non-goals

- Full visual nonlinear editor, manual timeline manipulation, multi-track drag-and-drop workspace, or professional editor UI.
- Advanced compositing, motion graphics, keyframe animation, 3D/VFX, advanced color grading, or a general effects workstation.
- Multicam editing, collaborative editor sessions, plugin marketplace, user-authored editing scripts, or NLE project-format compatibility.
- Multi-Agent / D9 or distributed specialist agents.
- Runtime implementation or final language, database, deployment, or media-analysis model selection.

A preview, contact sheet, simple asset list, or approval surface may be useful in a future application layer; none implies a full editor. Output adaptation is a separate stage from story selection and timeline construction. The timeline is a canonical machine-readable artifact, not a GUI editor.

## 2. Domain boundary in the unified platform

Video Editing is a separate Domain Intelligence and Domain Execution profile over the shared Agent Kernel.

| Shared Kernel | Video-specific |
| --- | --- |
| Task, Turn, Step, ModelStep, Attempt | MediaProjectModel |
| GoalContract/PlanRevision envelopes and lifecycle | Editing intent interpretation and story/pacing model |
| ToolInvocation, permission, budget, Journal | Media ingest/probe/analysis tools |
| Trusted ToolHost process control and receipts | TimelineRevision and RenderPlan |
| Cancellation, UNKNOWN reconciliation, checkpoint | FFmpeg render and media-specific resource profile |
| Artifact identity and delivery | MediaProject, MediaAnalysis, MediaProjectModel, NarrativePlan, TimelineRevision, RenderPlan, and video deliverables |
| Completion Guard envelope | Video criterion evidence, perceptual review, and source-to-output provenance |

The Video Workflow Profile binds the media schemas, tool snapshot set, resource policy, output profile, and verification obligations. Kernel remains unaware of the semantics of a shot, a scene, pacing, or narrative coherence.

### Shared orchestration simplification (Draft PR #1 — PROPOSED)

Video remains an **end-to-end autonomous editing Domain**, not a manual clip picker or partial analysis-only tool. The same **single primary Task Orchestrator loop** selects Strategic/Tactical/Assurance *decision purposes* while Video Intelligence independently handles natural-language goal understanding, progressive source analysis, message-conditioned selection, NarrativePlan, TimelineRevision compilation, FFmpeg render, final technical/content/perceptual validation, and instruction-driven revisions. These are **domain capabilities**, not separate Kernel state machines. Preserve the ADP-01/02 REVISED/APPROVED scope unchanged.

Shared ActionProposal is a bounded immutable action-intent envelope; each long-running render retains a unique ToolInvocation and a Domain RenderJob projection over authenticated Host state. Context and evidence may use minimal EvidenceRefs/criterion bindings and optional indexes without losing raw media provenance, source timestamp integrity, coverage or independent output inspection. Sequential launch is the default; independent read-only media probes may run concurrently only if bounded and individually admitted. No new kernel-level Video scheduler or global Artifact/EvidenceGraph state authority is necessary. See [Architecture subtraction review](../../decisions/architecture-subtraction-review.md). G0 OPEN; real render and quality proof NOT RUN.

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

MediaProjectModel is the Video domain's structured, provenance-aware projection of that project and its media evidence. It is not a media database or execution authority. MediaProject, ProjectSnapshot, MediaAsset, MediaAnalysis, and MediaProjectModel version relationships and evidence inheritance are specified in [MediaProject contract](../../contracts/media-project.md).

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
5. **Understand and select:** retrieve candidate moments against the accepted message/criteria, rank them by relevance, evidence, salience, coverage, redundancy, continuity, audio value, and duration cost.
6. **Narrative planning:** create a versioned NarrativePlan with beats, selected moments, ordering/context constraints, pacing intent, and rationale.
7. **Timeline candidate:** compile the NarrativePlan into exact source ranges and typed TimelineRevision operations; validate structure, timebase, evidence, and change impact.
8. **Render planning:** compile the accepted TimelineRevision into a deterministic RenderPlan bound to source digests, FFmpeg build, typed filtergraph, protocol/filesystem/network policy, environment, output profile, and resource estimate.
9. **Render:** admit a long-running RenderJob through Kernel and execute through Trusted ToolHost.
10. **Inspect:** run technical media checks, source-to-output traceability checks, and criterion-specific content/perceptual review against the actual output.
11. **Deliver:** publish only validated immutable output artifacts and the corresponding report.
12. **Revise:** convert follow-up instructions or verifier findings into new EditIntent, NarrativePlan, TimelineRevision, RenderPlan, RenderJob, and VerificationReport versions.

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

See [RenderJob contract](../../contracts/render-job.md) and [FFmpeg RenderPlan security contract](../../contracts/render-plan-security.md). RenderJob status is a projection of Kernel invocation state, Host physical facts, domain verification, and artifact publication—not an independent state authority.

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
- selected content, order, required context, and exclusions match GoalContract and NarrativePlan;
- beat coverage/order, factual/causal integrity, and source-range selection are supported by evidence;
- pacing, shot/action/speaker/spatial continuity, and audiovisual coordination meet criterion-specific obligations;
- transitions, captions/titles where supported, and audio treatment match the accepted timeline;
- every output interval maps to exact source ingredient(s) or an explicitly declared generated/externally supplied asset;
- the rendered output corresponds to the exact accepted ProjectSnapshot, NarrativePlan, TimelineRevision, and RenderPlan.

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

Each instruction creates an immutable EditIntent and a candidate NarrativePlan/TimelineRevision. The system identifies affected beats, clips, ranges, tracks, criteria, analysis claims, and verification obligations; carries forward unaffected evidence only through explicit freshness-checked EvidenceCarryForward records; and renders a new version. A fresh verifier finding can also trigger a targeted revision. The prior plan, timeline, render, and report remain immutable historical artifacts. The revision loop is bounded by accepted budgets, repair reserve, authorization, and stop conditions.

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

- Exact typed timeline operation schemas, deterministic compiler mappings, and per-operation evidence obligations for the ADP-01-approved core capability set.
- MediaAnalysis taxonomy, temporal coverage requirements, confidence calibration, and raw-evidence retention/privacy policy.
- NarrativePlan schema, beat vocabulary flexibility, factual/chronology guardrails, and multi-objective moment-ranking policy.
- EvidenceCarryForward compatibility rules for changed analysis versions, proxies, and criteria.
- Output Profile values and supported media/container/stream matrix.
- Platform-specific Host isolation, enforceable resource dimensions, and FFmpeg build/demuxer/decoder/filter allowlists.
- Human-review triggers and independent-evidence classes for narrative, factuality, and perceptual criteria.
- Benchmark task-set selection, source/media rights, reviewer rubrics, and baseline thresholds.
- Whether optional content credentials (for example C2PA) are needed for any delivery target.

First-round candidate resolutions remain in [Architecture Decision Proposals](../../decisions/architecture-decision-proposals.md). The second-round additions are tracked in [Second-round architecture revision](../../decisions/second-round-architecture-revision.md). All remain PROPOSED/OPEN and do not select a media-analysis provider or production stack.

No threshold or technology choice is inferred merely from this design draft.


## 12. Media execution references and limits

The media execution proposal is grounded in the following official documentation:

- [FFmpeg documentation](https://ffmpeg.org/ffmpeg.html) describes stream selection, simple/complex filtergraphs, and machine-readable progress output. Its progress records are execution telemetry, not content-quality evidence.
- [ffprobe documentation](https://ffmpeg.org/ffprobe.html) describes machine-readable container, stream, packet, and frame inspection. Probe success establishes inspectability and metadata facts, not that the requested story or pacing is correct.
- [PySceneDetect documentation](https://www.scenedetect.com/docs/latest/) describes shot-change detection and splitting. Shot boundaries are useful temporal evidence but do not by themselves establish semantic scene understanding.

The first phase uses FFmpeg as the named render backend. It does not select the media-analysis model/provider, storage system, packaging strategy, or host deployment. FFmpeg's own protocol, demuxer, filtergraph, and escaping behavior must be treated as a security surface; see [RenderPlan security contract](../../contracts/render-plan-security.md).

## 13. Video first-slice adapter and execution trace (G0 candidate)

The `video_editing` adapter supplies MediaProjectModel, progressive analysis, moment retrieval, NarrativePlan, TimelineRevision compiler, technical/content verification and typed tool snapshots under [Domain Extension](../../contracts/domain-extension.md). It does not extend TaskControl, create its own authoritative RenderJob completion state or bypass Trusted Host.

**Typed capability minimum:** `media.ingest_probe` (R0 over exact source IDs/digests), `media.sample_analyze` (bounded modality/interval, policy-controlled privacy), `media.timeline_validate_compile` (typed rational-time timeline to allowlisted RenderPlan), `media.preview_render` (budgeted disposable preview), `media.final_render` (one R1 staging output, bounded Host resource reservation), `media.output_inspect` (independent technical and content evidence), `media.publish_artifact` (guarded final digest). Any public upload/share, uncontrolled media decoder/filter or external asset download is R2/unapproved unless separately authorized. All tool snapshots have explicit resource/effect/target-conflict/idempotency declarations.

**Happy-path trace V-01:**

1. **Intake and ingest:** bind EditIntent, source set rights/permissions/digests and output criteria. Trusted probe enumerates actual streams/time bases, VFR/rotation/audio tracks, source failures and exact ProjectSnapshot. Work on immutable source IDs rather than user-provided paths as authority.
2. **Progressive content understanding:** select task-conditioned relevant modalities and time ranges; save per-stream/per-modality coverage (`Observed/Sampled/NotSampled/NotRequested/Unavailable/DecodeFailed`) and analysis provenance. Reuse cache only for unchanged exact source digest + parser/analyzer/profile/method + policy; missing coverage cannot be treated as no event. Escalate frame/audio/transcript analysis only when acceptance evidence requires it; no automatic full-transcode/model pass.
3. **Editorial decision:** select evidence-backed moments preserving required context and uncertainty; produce a versioned NarrativePlan and typed TimelineRevision with rational timestamps, source-range lineage, operation allowlist, clip/audio alignment, edit acceptance criteria and source references. A mere metadata cut list is not task completion.
4. **Validate and preview:** deterministic timeline/compiler checks catch out-of-bounds/zero-length intervals, PTS discontinuities, VFR mapping, invalid transitions, audio clipping/sync and illegal FFmpeg paths/filters. Request an appropriately small preview only if uncertainty/accepted review policy requires it; a preview does **not** certify the final render.
5. **Render:** Kernel admits the RenderPlan against current ProjectSnapshot, plan, resource hold and Host authority; Host executes one-use ticket in sealed sources + isolated staging with bounded CPU/GPU/memory/disk/wall time. Report authenticated progress without LLM polling; cancel/drain/reconcile all descendants and handles before staging seal. RenderJob remains a projection. Final output is never overwritten in place.
6. **Inspect and publish:** independently probe/decode the actual staged output, verify duration/profile/streams/sync, inspect sampled final frames/audio and task-relevant narrative/context against source evidence, apply policy-required model/human content assurance, and bind source-output interval provenance. A green FFmpeg exit or preview cannot substitute. After current receipt, exact output digest, process convergence and criteria all pass, publish immutable ArtifactRef and Guard-commit Completed.
7. **Revise:** new user instruction creates versioned EditIntent/NarrativePlan/TimelineRevision; invalidate only affected source/range/criterion evidence under read-set proof and re-render affected deliverable. Retain prior published revision; do not silently reuse stale inspection against changed rendered bytes.

**Recovery cases:** V-02 Host crash before spawn → spent nonce/UNKNOWN until physical proof; V-03 cancel during render → no final publication without convergence; V-04 lost receipt after finalization → idempotent Host receipt/import and exact digest recovery, no second render; V-05 bad codec/VFR → explicit unsupported profile or corrected plan with revalidation; V-06 source asset changed after analysis → invalidate relevant analysis/timeline/output; V-07 visually misleading edit despite valid decode → fail semantic criterion/escalate; V-08 resource exhausted → quarantine output and preserve usage/hold. A partial file is never a final artifact. Asset rights and external distribution remain separately gated.

**Latency policy:** prioritize source metadata/cache, targeted samples and timeline proof before expensive media processing; queue heavyweight render asynchronously with concurrency/resource backpressure, event-driven status and a deterministic finalizer. Compare preview/no-preview and targeted/exhaustive analysis **under the same** accepted semantic criteria; a faster but misleading edit fails. The approved ADP-01/02 operation/analysis boundaries remain unchanged.
