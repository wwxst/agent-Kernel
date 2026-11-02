# Architecture Decision Proposals — Cross-Domain Convergence

> **Status: MIXED.** ADP-01 is **REVISED (owner-approved 2026-11-02)** and recorded in the [Decision Log](decision-log.md). ADP-02 through ADP-11 remain **OPEN**; their recommendations remain **PROPOSED**. This packet is a decision aid and proposal register, not blanket approval. No decision authorizes Runtime implementation, selects a production technology stack, or claims empirical validation.

## 1. Purpose and decision boundary

The approved product direction is one shared Agent Kernel with independent Autonomous Coding and Autonomous Video Editing domains. The current architecture and domain contracts are internally aligned as proposals, but several decisions still prevent a bounded implementation plan.

This packet is based on the current repository documents:

- [Unified domain architecture](../architecture/domain-architecture.md)
- [Domain Workflow binding contract](../contracts/domain-workflow.md)
- [Media Timeline artifact contract](../contracts/media-timeline.md)
- [RenderJob contract](../contracts/render-job.md)
- [Video Editing domain design](../research/multimedia-domain-architecture/design.md)
- [Shared Kernel evaluation protocol](../research/shared-kernel/evaluation.md)
- [Open decisions](open-decisions.md)

It is a repository-level design synthesis. It does not report a runtime spike, benchmark, media processing, or fault-injection result. ADP-01 records an explicit owner decision; all other recommendations remain proposals rather than facts demonstrated by experiments.

### Decision summary

| ID | Decision area | Recommended direction | Owner decision |
| --- | --- | --- | --- |
| ADP-01 | Video first-phase autonomous editing capability and operation boundary | Complete autonomous editing loop within a bounded core operation set; defer editor-grade features | REVISED — APPROVED 2026-11-02 |
| ADP-02 | Media analysis | Whole-source technical/coverage accounting, task-conditioned depth, adaptive evidence expansion; no default full multimodal pass | Draft prepared — OPEN |
| ADP-03 | Workflow Profile lifecycle | Immutable versions; current-effective admission and dispatch gate; revocation blocks launch; UNKNOWN remains held | Draft prepared — OPEN |
| ADP-04 | Artifact and media storage | Generic immutable artifact manifest plus opaque blob/object payload; journal stores references, not large media bytes | Confirm logical contract |
| ADP-05 | Media time | Per-stream integer PTS/sample coordinates, rational time bases, explicit versioned conversion/rounding and A/V mapping | Draft prepared — OPEN |
| ADP-06 | Output profiles | Versioned profile registry; one compatibility profile candidate; no silent defaults | Confirm target profile values |
| ADP-07 | Verification and human review | Criterion-level evidence classes; independent content review; human disposition for explicitly subjective/high-impact criteria | Confirm review policy |
| ADP-08 | Host and resource policy | Hard-enforce only Host-supported dimensions; bounded source/output admission; GPU optional | Confirm supported Host envelope |
| ADP-09 | Cross-domain handoff | Separate Tasks, exact immutable ArtifactRef, scoped handoff authorization, no inherited permissions/context | Draft prepared — OPEN |
| ADP-10 | Preview and approval surface | Contact sheet/low-resolution preview plus approve/revise/reject; no manual timeline editor | Confirm minimum user surface |
| ADP-11 | Implementation order | Freeze logical contracts first, then isolated contract spikes, then separately authorized runtime work | Confirm stage gates |

## 2. ADP-01 — Video first-phase autonomous editing capability and operation boundary

**Owner decision: REVISED — APPROVED in revised form on 2026-11-02.** The authoritative decision record is [Decision Log — ADP-01](decision-log.md#adp-01-video-first-phase-autonomous-editing-capability-and-operation-boundary).

### Final selection

The first phase must deliver a **genuinely autonomous natural-language video-editing Agent** that can complete an end-to-end editing task, rather than a collection of video tools that only execute individually specified operations.

The required task-level loop is:

**Understand request → analyze source media → identify/select useful moments → organize a basic narrative → create TimelineRevision → render → inspect the actual output → revise from user feedback → re-render/re-verify → deliver.**

Within the accepted task GoalContract, authorized source set, bounded operation registry, permissions, and resource envelope, the Agent should make ordinary editing decisions autonomously. The user must not be required to specify every clip, cut, or tool call. The Agent must ask for clarification or stop safely when ambiguity, evidence gaps, scope/permission boundaries, material factual risk, or budget limits make autonomous continuation unsafe.

### Included first-phase capability scope

1. **Material intake:** ingest user-supplied assets, fingerprint them, and perform technical probing sufficient to identify files, streams, duration, time bases, and known warnings.
2. **Basic media understanding:** analyze video content and shots/scenes sufficiently to navigate the source material and support the current editing task. Exact modalities, coverage, trigger policy, and provider/model remain ADP-02 decisions.
3. **Moment/highlight selection:** identify and select task-relevant candidate moments from source evidence; preserve selection rationale and uncertainty. Advanced multi-objective ranking is not implied.
4. **Natural-language intent understanding:** turn the user's message into explicit editing criteria, required/excluded content, desired duration/style, and relevant constraints.
5. **Basic narrative planning:** create a genre-flexible NarrativePlan with the intended message, a small set of useful beats/moments, sequence/order, necessary context, and simple duration/pacing allocation. A universal story template and advanced cross-scene narrative reasoning are not required.
6. **Bounded editing operations:** source-range trim, reorder, hard cut, concatenate, simple fade/crossfade, and limited source-audio preserve/mute/per-clip gain/simple fades.
7. **Timeline and render:** generate an immutable TimelineRevision and compile it into a bounded RenderPlan for FFmpeg rendering. The exact typed operation schemas and Host enforcement contracts remain subject to their respective architecture decisions.
8. **Actual-output inspection:** check the rendered artifact against technical and task/content criteria; do not treat a successful FFmpeg exit as proof of editing success. The detailed evidence classes and mandatory human-review triggers remain ADP-07 decisions.
9. **Natural-language iteration:** accept follow-up instructions, create new EditIntent/TimelineRevision versions, re-render and re-verify, and preserve prior revisions and evidence.
10. **Delivery:** deliver the rendered video with the relevant timeline, render, verification, and source-provenance artifacts. External upload/publication is not included without separate authorization.

### Explicitly not included in the first phase

- Generated captions/subtitles and title graphics. Existing subtitle-stream pass-through, if supported, is an output-profile concern rather than caption generation.
- Music generation or acquisition, external music sourcing, voice synthesis, multi-track audio mixing/ducking, and advanced loudness mastering.
- Advanced multi-objective highlight ranking, rich cross-scene story construction, advanced semantic continuity, music/beat-aware pacing, and deep perceptual critique.
- Complex transitions, compositing, motion graphics, keyframes, stabilization, advanced color grading, VFX, and arbitrary effects graphs.
- Manual timeline editing, full NLE-style interface, professional editor collaboration, or plugin marketplace.
- Unrequested external asset acquisition or external platform upload/publication.

Codec/container/resolution/aspect/frame-rate/color/audio output adaptation remains a separate Output Profile concern under ADP-06; it is not an editorial operation.

### Rationale

The product outcome is an independently completed, verified edit—not the number of FFmpeg filters or isolated editing tools exposed. A bounded but coherent operation set is sufficient to test whether the Agent can understand a request, make content decisions, construct an edit, render it, detect problems, revise it, and deliver the result. This avoids both a tool-only workflow and premature expansion into a professional editor.

### Alternatives considered and not selected

- **Richer first phase:** add generated captions/titles, music, multi-track audio, and advanced effects. Not selected because it expands content-generation, rights, compiler, and verification obligations before a reliable core loop is established.
- **Ultra-minimal tool set:** trim/reorder/concatenate only, without basic transitions or audio controls. Not selected because it can make the first useful output unnecessarily crude and under-exercises the editing loop.
- **Full visual editor:** not selected; it is outside the natural-language autonomous-editing product boundary.

These alternatives are not permanent product rejections; future scope requires a separate decision.

### Risks and limitations

- Basic moment selection and narrative organization may be insufficient for complex genres or long-form stories.
- Insufficient or conflicting analysis evidence may require clarification or human review.
- Even simple crossfades require correct timebase, overlap, audio, and render validation.
- A bounded operation registry may not satisfy every social-video or professional workflow.
- The Agent can produce a technically valid but semantically misleading edit; factual/context criteria and independent review remain necessary.
- Exact analysis strategy, temporal contracts, output profiles, verification policy, resource enforcement, and preview interaction are governed by ADP-02 through ADP-10 and remain open.

### Acceptance conditions

The first-phase architecture and any later authorized implementation must demonstrate that:

1. A task can start from a natural-language request and authorized source set without the user specifying every editing operation.
2. The Agent can produce task-conditioned source understanding and evidence-backed moment selection.
3. The Agent can form a basic NarrativePlan and derive a valid immutable TimelineRevision from it.
4. The accepted core operations have typed representations, validation, deterministic render compilation, and declared evidence obligations.
5. Rendering occurs through the bounded RenderPlan/Trusted ToolHost path; unsupported operations fail closed rather than being approximated by arbitrary model-authored commands.
6. Verification inspects the actual rendered artifact against technical and task/content criteria.
7. A follow-up natural-language instruction produces a new traceable revision, with re-rendering and re-verification of affected obligations.
8. The deliverable retains source-to-output provenance and the evidence required by its acceptance criteria.
9. The Agent can pause for material ambiguity, insufficient evidence, unauthorized scope, or exhausted budget, and does not claim completion while required checks remain unresolved.
10. End-to-end evaluation measures task completion and editing quality, not merely individual tool success.

Typed schemas, fixtures, tests, thresholds, and Host-specific enforcement are later contract/evaluation gates. Listing these acceptance conditions does not authorize Runtime implementation, real-model use, or media experiments.

### Related decisions and documents

- ADP-02: analysis modalities, coverage, and progressive-analysis policy.
- ADP-03 through ADP-09: profile authority, artifacts, temporal model, output profiles, verification, Host resources, and cross-domain handoff.
- ADP-10: preview/progress/approval interaction surface.
- ADP-11: staged implementation and separate authorization.
- [Video Editing Intelligence](../research/multimedia-domain-architecture/intelligence.md), [Video domain design](../research/multimedia-domain-architecture/design.md), [MediaProject](../contracts/media-project.md), [Media Timeline](../contracts/media-timeline.md), [RenderPlan security](../contracts/render-plan-security.md), [RenderJob](../contracts/render-job.md), and [Completion](../contracts/completion.md).

## 3. ADP-02 — Task-conditioned progressive media analysis

**Recommendation — PROPOSED; decision draft prepared, owner disposition pending (OPEN).**

Adopt a progressive analysis ladder that provides source-wide visibility and explicit coverage accounting without running every expensive modality over every asset by default. The analysis strategy is selected from the accepted GoalContract, source characteristics, evidence gaps, privacy policy, and remaining budget.

### Proposed analysis ladder

1. **Intake and technical baseline — always.** Fingerprint every supplied source asset and probe the streams needed to establish immutable asset/stream identity, duration, start timestamps, rational time bases, frame/sample characteristics, and decode warnings. This stage establishes technical facts, not semantic understanding.
2. **Source-wide coverage accounting — always.** Every source asset receives a coverage manifest that declares the temporal extent considered, observed/sampled intervals, sampling/index method and density, known gaps, unavailable regions, and status. For content-based moment selection, create a coarse temporal navigation index across the selected source set (for example, representative frames and shot-boundary candidates). This is a coverage/indexing obligation, not a claim that every frame or semantic event was exhaustively understood.
3. **Task-conditioned deep analysis — as required.** GoalContract criteria select the modalities and intervals needed: visual event/scene analysis, OCR, ASR/speaker/utterance alignment, audio-event analysis, loudness, or audiovisual alignment. Do not run full transcription, dense visual analysis, or all audio analysis when the accepted criteria do not require them.
4. **Adaptive evidence expansion — when needed.** Domain Intelligence may request denser sampling, neighboring context, additional modalities, or re-analysis when evidence is incomplete, contradictory, low-confidence, stale, boundary-sensitive, or insufficient for a required criterion. Each expansion records the triggering gap, expected evidence, cost reservation, and result. If the gap remains unresolved, preserve Partial/Inconclusive/UNKNOWN and ask the user when it materially affects the edit.

Final-output inspection is a separate verification activity under ADP-07. Source analysis evidence cannot substitute for evidence sampled from the rendered output.

### Evidence and coverage rules

- Every MediaAnalysis binds exact ProjectSnapshot/input manifest, source asset digest, selected stream identity, integer PTS/sample interval and rational time base, analysis method/build/configuration digest, coverage manifest, raw evidence references, and freshness/invalidation conditions.
- A coverage manifest distinguishes **observed**, **sampled**, **not sampled**, **unavailable**, and **decode-failed** intervals. It records the method and resolution; it must not collapse unknown regions into negative findings.
- A negative claim such as "the source contains no instance of X" requires evidence whose declared coverage and method are adequate for that claim. Sparse sampling, shot summaries, or transcript-only evidence cannot establish absence from the entire source.
- Every derived claim carries uncertainty and a declared scope. A model summary or salience score is a navigation aid, not independent proof.
- Analysis expansion is bounded by the Task's permissions and resource budget. Privacy/data-minimization policy controls retention of frames, audio, transcripts, and derived embeddings; analysis convenience alone is not a retention justification.
- Evidence is never silently reused after source, stream, proxy mapping, analysis method/configuration, or criterion meaning changes; freshness follows the MediaProject and EvidenceCarryForward contract.

### Alternatives not selected

- **Always run complete visual/audio/transcription analysis:** higher recall potential but unnecessary cost, latency, exposure, and noisy claims for tasks that do not need every modality.
- **Technical metadata only:** insufficient for autonomous moment selection and narrative editing.
- **Sparse sampling without coverage accounting:** cheaper but hides unobserved intervals and encourages unsupported negative claims.

### Risks and limitations

Progressive analysis can miss an unanticipated cue; coarse indexing is not exhaustive semantic comprehension; analysis models may disagree or hallucinate; dense expansion can consume substantial budget; raw evidence can contain sensitive material. These risks require explicit coverage, uncertainty, budget, privacy, and escalation records rather than a universal confidence threshold.

### Acceptance and later evaluation conditions

1. Every supplied source asset has a technical probe result or an explicit failed/unavailable record.
2. Every source asset has a coverage manifest that accounts for observed/sampled and unobserved/unavailable intervals.
3. For content-based selection tasks, the coarse temporal index spans the selected source set and declares its sampling gaps/density.
4. GoalContract criteria map to required analysis kinds and minimum evidence scopes; unnecessary modalities are not implicitly mandatory.
5. The planner can request bounded additional analysis and records the evidence gap, reason, budget reservation, and resulting coverage.
6. Incomplete/conflicting/weak evidence remains Partial/Inconclusive/UNKNOWN; sparse evidence cannot silently support whole-source absence claims.
7. Claims are traceable to immutable source/stream/timebase, analysis/configuration, raw evidence, and freshness status.
8. Evaluation reports coverage-manifest completeness, relevant-moment recall/miss rate where ground truth exists, false detections, source-range accuracy, escalation quality, and analysis cost separately.
9. Retention follows an explicit data-minimization policy; no provider, model, storage technology, confidence threshold, or production pipeline is selected by this decision.

**Related contracts/evaluation:** [MediaProject and MediaAnalysis](../contracts/media-project.md), [Media Timeline](../contracts/media-timeline.md), [Video evaluation](../research/multimedia-domain-architecture/evaluation.md), [Completion](../contracts/completion.md), and ADP-08 resource policy.

## 4. ADP-03 — Workflow Profile lifecycle, revocation, and safe migration

**Recommendation — PROPOSED; decision draft prepared, owner disposition pending (OPEN).**

Treat each Workflow Profile as an immutable, content-digested policy snapshot. An accepted plan pins an exact DomainBinding/profile version for historical meaning and provenance, but that pin is not a perpetual authorization to launch future operations.

### Proposed lifecycle and authority rules

1. A Task is created with exactly one DomainBinding and one Workflow Profile version. The accepted GoalContract/PlanRevision binds the exact profile ID, version, digest, and binding identity.
2. A profile version is immutable. A change creates a new candidate version and digest; no in-place edits to tool/schema/resource/evidence/permission declarations are allowed.
3. The profile registry distinguishes Draft, Validated, Active, Superseded, and Revoked. Only the current Active version is eligible for new operation admission. Superseded/Revoked versions remain addressable for historical provenance but are not eligible for new launches.
4. Each activation, supersession, or revocation advances a monotonic profile-authority epoch. The active DomainBinding records the effective profile version/digest and epoch.
5. Every ToolInvocation records the exact DomainBinding/profile ID/version/digest, accepted PlanRevision, tool snapshot, authorization/approval references, and profile-authority epoch used at admission. Completed operations and their evidence retain that historical binding permanently; later profile changes do not rewrite history.
6. Both admission and physical dispatch must check current authority. A previously accepted PlanRevision or queued/admitted invocation is not sufficient by itself to launch a new process. Immediately before Host launch, the dispatch gate must establish that the profile version is still current and Active, the authority epoch is current, and all capability/approval/budget/fencing conditions remain valid. A stale/revoked dispatch ticket is rejected. If the current authority state cannot be established, dispatch fails closed.
7. Revocation immediately blocks new ToolInvocation admission. It also blocks any queued or admitted-but-not-yet-launched invocation from starting under the revoked profile. No old approved plan may be used to bypass this rule.
8. An operation whose Host process has already started is reconciled under its exact invocation, profile, epoch, and Host identity. A predeclared policy determines whether it may drain or receives a cancellation request. A cancellation request is not proof of process convergence; Host descendants and writable handles must be reconciled.
9. If any in-flight invocation is UNKNOWN, do not migrate around it, rebind it, replay it, or use a new profile to bypass its unresolved side-effect status. Preserve the hold until Host evidence establishes a safe outcome.
10. A same-domain profile migration uses the existing freeze → stop new admissions → drain/reconcile → refresh → compatibility/impact validation → required user confirmation → new binding + accepted PlanRevision atomic activation barrier. New invocations use only the newly current binding/version after activation. An old plan is not silently rebound.
11. A domain change (Coding ↔ Video) is not a profile migration; it requires a new Task and an explicit ADP-09 artifact handoff.

### Alternatives not selected

- **Pin the profile for the entire Task lifetime and ignore revocation:** simple but unsafe when user authority or policy is withdrawn.
- **Automatically migrate all active Tasks when a new profile is published:** convenient but can silently change tools, effects, budgets, schemas, or evidence obligations.
- **Allow already approved plans to launch after revocation:** rejected because plan acceptance is not a substitute for current authorization at dispatch.

### Risks and limitations

Revocation cannot undo side effects from an already running process. A Host outage can leave physical execution UNKNOWN. Dispatch-time authority checks require a trustworthy, fail-closed boundary; a cached profile allowlist alone is insufficient. The exact registry, epoch storage, ticket transport, and Host implementation remain unselected.

### Acceptance and later evaluation conditions

1. Profile versions/manifests are immutable and content-digested.
2. Every model/tool/artifact/report record binds the exact historical profile version it used.
3. No admission occurs under a Superseded or Revoked profile.
4. No queued/admitted-but-not-started invocation launches after the profile is revoked or superseded; stale dispatch authorization is rejected.
5. An old accepted PlanRevision cannot authorize new work after revocation or profile cutover.
6. In-flight drain/cancel behavior follows the declared policy and is not marked converged until Host process/descendant/handle evidence supports it.
7. UNKNOWN blocks profile migration, replay, and new conflicting side effects until reconciled.
8. A migrated Task uses a new DomainBinding and accepted PlanRevision; protected capability/resource/evidence changes receive required user confirmation.
9. Cross-domain profile migration is rejected.
10. Shared Kernel evaluation includes revoke-before-admission, revoke-after-admission-before-launch, revoke-during-execution, cancellation race, and revoke-while-UNKNOWN fixtures. Any actual unauthorized launch is a blocker.

**Related contracts/evaluation:** [Domain Workflow binding contract](../contracts/domain-workflow.md), [Trusted ToolHost](../security/trusted-host.md), [Shared Kernel evaluation](../research/shared-kernel/evaluation.md), [Plan Revision](../contracts/plan-revision.md), and [Budget](../contracts/model-and-budget.md).

## 5. ADP-04 — Generic artifact and media storage contract

**Recommendation — PROPOSED**

Define a technology-neutral artifact contract with a small metadata manifest and an opaque immutable content payload.

The shared artifact manifest should carry, at minimum:

- stable Artifact ID, artifact kind, schema/version, media type, byte size, and content digest;
- producer DomainBinding/profile, Task/PlanRevision/Step, and creation provenance;
- workspace or MediaProject identity/generation where applicable;
- parent/derived-from artifact references and transformation/tool version;
- access classification, retention policy, and lifecycle state;
- an opaque content locator plus supported read/range/stream semantics.

Storage boundary:

- Kernel Journal stores artifact identity, manifest state, lineage, authorization, and references—not large video, proxy, archive, or other binary payloads.
- The artifact payload store owns immutable bytes and verifies content digests on ingest/read.
- Large media and derived proxies are staged under unique temporary identities and become publishable only after finalization/verification.
- Partial or UNKNOWN outputs remain quarantined and are not exposed as completed deliverables.
- Coding patches/reports and Video media/timeline/render artifacts use the same envelope but retain domain-specific schemas and payloads.

This does not select a database, object store, filesystem, or deployment topology.

**Alternatives**

- Store all payloads inside the transactional database.
- Store mutable files at paths and treat the path as artifact identity.
- Let each domain invent an unrelated artifact lifecycle.

**Risks and trade-offs**

- External blob storage creates a Journal/Host consistency boundary; there is no single transaction spanning database state and physical bytes.
- Content addressing improves integrity and deduplication but requires explicit retention, access-control, and garbage-collection rules.
- Streaming/range reads add interface complexity but are important for large media and proxies.

**Acceptance criteria**

- Manifest schema and payload locator are independent of storage vendor.
- Source assets and finalized artifacts are immutable; replacements create new Artifact IDs/digests.
- Digest verification, quarantine, publication, retention, access checks, and orphan cleanup have explicit state transitions.
- Journal recovery can distinguish a missing blob, an unfinalized blob, a digest mismatch, and a published artifact.
- Large media can be read/streamed without loading the entire payload into Kernel memory.
- No completion claim depends on an unverified mutable path.

## 6. ADP-05 — Media time and synchronization semantics

**Recommendation — PROPOSED; decision draft prepared, owner disposition pending (OPEN).**

Adopt exact per-stream integer/rational temporal coordinates. Floating-point seconds and nominal frame rate are presentation/derived values, never the sole canonical basis for frame-accurate editing.

### Proposed temporal contract

- Video source coordinates use the selected stream's signed integer presentation timestamp (PTS) and that stream's exact positive rational time base. Source ranges are end-exclusive: [start_pts, end_pts).
- Preserve the original PTS origin, including negative or non-zero start PTS, stream start offsets, discontinuities, and available per-frame presentation durations. Do not assume a constant frame interval for VFR media.
- Audio coordinates retain the selected stream identity, integer sample positions/sample rate, stream PTS/time base, and any explicit resampling or sample-rate conversion mapping. Audio ranges are also end-exclusive.
- Every TimelineRevision declares an explicit rational timeline time base. There is no universal project frame rate or implicit conversion of source PTS to frame index.
- Rational values use a canonical mathematical representation: denominator positive, numerator/denominator reduced by their greatest common divisor where representable. The exact wire/storage encoding remains open.
- A timestamp conversion records source coordinate and time base, target coordinate and time base, exact rational value before rounding, named rounding-policy ID/version, resulting integer coordinate, and the resulting mapping/error bound.
- Rounding is operation-specific and explicit. A coverage-preserving interval conversion may use floor for the start and ceil for the end; nearest-boundary conversion is allowed only when the operation semantics explicitly request it and a deterministic tie rule is declared. No implicit global rounding mode is assumed.
- Preserve per-stream A/V offsets and alignment evidence. Do not reset each stream to zero or infer synchronization from nominal frame rate. Any timestamp normalization, CFR conversion, resampling, or sample-rate conversion is an explicit RenderPlan operation with a provenance mapping.
- Missing or invalid PTS/sample timing remains Missing/Unknown. A derived estimate must record its method, uncertainty, and source evidence; it must never be silently substituted as original source timing.
- Timecode strings and floating-point seconds may be displayed to users, but cannot replace canonical integer/rational coordinates.

### Alternatives not selected

- **Floating-point seconds as canonical:** can introduce rounding drift and ambiguous frame/sample boundaries.
- **Normalize all media to one CFR/sample rate at ingest:** simplifies downstream processing but changes source timing, costs time/storage, and creates derived-media quality and provenance obligations.
- **Use nominal FPS to reconstruct VFR timestamps:** loses actual presentation cadence and can create boundary/sync errors.

### Risks and trade-offs

Native time bases and explicit mappings increase timeline/compiler complexity. Different renderers may quantize to different output time bases. Missing or discontinuous timestamps may require normalization or human review. A mathematically exact source mapping does not by itself prove perceptual A/V synchronization; output checks remain necessary.

### Acceptance and later evaluation conditions

1. Canonical source and timeline coordinates use integer ticks/PTS/sample positions plus exact rational time bases.
2. End-exclusive boundary semantics are consistent across ingest, analysis, timeline, render, provenance, and verification.
3. Every conversion records its source/target basis and deterministic, versioned rounding rule.
4. VFR frame timing is preserved or transformed only by an explicit operation with source-to-output mapping.
5. Audio sample positions and stream offsets remain explicit through trims, transitions, resampling, and output conversion.
6. Fixtures cover CFR/VFR, irregular frame intervals, negative/non-zero PTS, differing stream time bases, missing timestamps, 44.1/48 kHz audio, offsets, resampling, and clip/transition boundaries.
7. Validation measures frame/sample inclusion, exact conversion/round-trip properties where applicable, A/V drift, and output sync against a declared profile tolerance. Numeric tolerances are not selected in this architecture decision.
8. No floating-point value or nominal FPS is the sole canonical source of frame-accurate timing.

**Related contracts/evaluation:** [Media Timeline](../contracts/media-timeline.md), [MediaProject/MediaAnalysis](../contracts/media-project.md), [Video evaluation](../research/multimedia-domain-architecture/evaluation.md), [RenderPlan security](../contracts/render-plan-security.md), and [Completion](../contracts/completion.md).

## 7. ADP-06 — Output profile registry and defaults

**Recommendation — PROPOSED**

Use a versioned, finite Output Profile registry. A profile defines container, video/audio codec, pixel format, dimensions, aspect/pixel ratio, frame-rate policy, color policy, audio layout/sample rate, subtitle behavior, metadata, quality/bitrate constraints, and verification tolerances.

For the first slice, prefer one general-compatibility SDR delivery profile rather than exposing a large codec menu. A candidate default for owner review is MP4 with H.264 video and AAC audio, progressive SDR output, preserved display aspect ratio, and a 1080p-class maximum resolution. This is a compatibility-oriented proposal, not a selected codec policy or a claim about every playback target.

Frame-rate behavior, exact resolution cap, color handling, audio layout, and quality/size trade-offs must be explicit profile fields. A reasonable candidate is to preserve the source rate when the selected sources share a compatible timing policy and otherwise require an explicit project output rate. If a user does not specify profile fields, the system must either apply a documented profile default and disclose it as an assumption or ask a question when the choice materially affects the deliverable.

**Alternatives**

- Preserve source codecs/containers wherever possible.
- Offer multiple target profiles (web, archive, mobile, broadcast) in the first release.
- Let the model choose arbitrary output settings per task.

**Risks and trade-offs**

- One compatibility profile is simple but may not fit archival, broadcast, HDR, or specialist workflows.
- Source preservation may produce inconsistent playback compatibility and complex stream-copy/transcode decisions.
- A large profile catalogue expands verification and support obligations.
- Codec, licensing, playback-target, and quality choices require explicit research before they become approved defaults.

**Acceptance criteria**

- Output profiles are versioned, immutable, and referenced by GoalContract, TimelineRevision, RenderPlan, and VerificationReport.
- No model-generated arbitrary codec/argv setting bypasses the registry.
- Defaults and assumptions are visible to the user.
- The initial profile has deterministic technical tolerances and fixture coverage across supported input types.
- The owner confirms target playback environments and codec policy before implementation planning freezes exact profile values.

## 8. ADP-07 — Criterion-level verification and human review

**Recommendation — PROPOSED**

Use criterion-specific evidence obligations rather than one global "video quality score".

| Criterion class | Required evidence | Human disposition |
| --- | --- | --- |
| Container, stream, codec, dimensions, duration, decode integrity | Machine probe/decode and output digest/receipt | Not normally required |
| Timeline structure, source bounds, clip order, timing, render binding | Independent timeline/schema checks plus RenderPlan/output binding | Not normally required |
| Required/excluded content, speaker/event identity, source-range correctness | Independent content verifier using raw sampled frames/audio/transcript and source provenance | Required when ambiguity, impact, or policy demands it |
| Story coherence, pacing, subjective style, sensitive/high-impact content | Blind reviewer/human assessment under a declared rubric; model review may flag issues | Required when the accepted criterion is subjective or policy says so |

Rules:

- A successful FFmpeg exit is execution evidence, not content evidence.
- The editing model's self-summary or aesthetic score cannot satisfy an independent evidence obligation.
- A model verifier's conclusion is a review finding, not a technical test result or a human acceptance event.
- Every criterion declares its evidence class and whether a human disposition is mandatory before rendering/acceptance/delivery.
- Video evidence includes an output-interval-to-source-interval map bound to immutable asset/stream digests, source PTS/sample ranges, timeline clips/transitions, and render operations.
- Technical validity, editorial/content fulfillment, perceptual quality, source provenance, and human acceptance remain separate result dimensions.
- Provenance records lineage and transformations; it does not prove depicted content is true or that source usage is legally licensed.
- Inconclusive evidence remains Inconclusive/UNKNOWN; it is not silently converted to Pass.
- Numeric quality thresholds are set only after a frozen task set and measured baseline exist.

**Alternatives**

- Human review of every output and every criterion.
- Model-only verification.
- Technical checks only.

**Risks and trade-offs**

- Human review improves assurance for subjective work but adds latency and operating cost.
- Independent model review can share blind spots with the editor and is not a substitute for human judgment on subjective criteria.
- Technical-only verification can publish a valid file that is the wrong edit.

**Acceptance criteria**

- Each GoalContract criterion maps to an evidence class, verifier, freshness binding, and optional human disposition.
- Completion Guard rejects missing, stale, self-reported-only, or unresolved required evidence.
- Reviewer rubrics and task sets are frozen before quality comparisons.
- Reports separate technical validity, instruction fulfillment, perceptual quality, and human acceptance.

## 9. ADP-08 — Host capability and resource envelope

**Recommendation — PROPOSED**

Keep the resource vocabulary shared, but make enforcement capability explicit per supported Host profile.

Candidate dimensions:

- wall-clock time and process lifetime;
- CPU time/threads and peak memory;
- temporary/final disk and output size;
- source duration, resolution, stream count, and estimated decoded workload;
- model analysis/transcription cost;
- GPU time/memory only where the Host can reliably account for and constrain it;
- verification and bounded repair reserve.

Rules:

- Workflow Profile declares requested hard limits and required Host capabilities.
- Host advertises which dimensions it can actually enforce and how it measures them.
- Kernel rejects a workload whose required hard limits cannot be enforced by the selected Host; it must not downgrade a hard limit to a best-effort estimate silently.
- GPU is optional in the first phase; CPU execution remains the compatibility baseline until measured evidence justifies a GPU requirement.
- Admission uses source metadata and conservative workload estimates; the Host records actual consumption and settles it against reservations.
- Numeric caps are selected only after target Host environments, task sizes, and controlled measurements are known.

For FFmpeg workloads, see the separate [RenderPlan security contract](../contracts/render-plan-security.md). It specifies per-input protocol/format policy, filesystem and staging boundaries, typed filtergraph allowlists, network isolation, process containment, and output publication. Protocol allowlisting alone is not a sandbox; Host enforcement remains environment-specific and UNVERIFIED.

**Alternatives**

- Depend on model estimates and terminate only on wall-clock timeout.
- Require a GPU-capable Host for all Video work.
- Define one global resource limit for both Coding and Video.

**Risks and trade-offs**

- Strong isolation/accounting varies by operating system and deployment model.
- CPU-only rendering may be slow for large/high-resolution sources.
- A permissive fallback can create unbounded disk, memory, or process consumption.
- Overly conservative admission may reject legitimate workloads.

**Acceptance criteria**

- Each supported Host profile declares enforceable versus advisory dimensions.
- Admission, cancellation, settlement, and overrun behavior are tested per Host profile.
- Process-tree/handle convergence and output-path isolation are proven before claiming safe cancellation.
- Resource reports include estimates, reservations, actual consumption, settlement, and any overrun.
- No numeric cross-platform hard-limit claim is made without environment-specific evidence.

## 10. ADP-09 — Cross-domain ArtifactRef handoff

**Recommendation — PROPOSED; decision draft prepared, owner disposition pending (OPEN).**

Keep one Task bound to exactly one domain and one active DomainBinding. Cross-domain work is represented as separately authorized Tasks connected only by explicit, immutable, typed ArtifactRefs and an auditable handoff record.

### Proposed handoff contract

1. The producing Task creates an immutable artifact with exact Artifact ID, kind, schema/version, digest, byte size/media type, provenance, access classification, retention metadata, and producer Task/DomainBinding references.
2. A handoff record identifies the source Task/domain, exact ArtifactRef and digest, intended consumer domain/Task, purpose, permitted access mode, authorizing principal/approval, authorization scope, and expiry/revocation state where applicable.
3. The producer artifact must be in the consumption-eligible state defined by ADP-04. Staging, partial, quarantined, Missing, DigestMismatch, or UNKNOWN artifacts are not consumable. ADP-09 does not pre-empt ADP-04's final artifact state machine.
4. ArtifactRef is a typed reference, not an access capability. The consumer receives a separate narrowly scoped read capability bound to the exact artifact digest, consumer Task, purpose, and access mode. The default handoff is read-only; any write or external effect requires separate authorization.
5. The consuming Task is created independently with its own principal, DomainBinding, Workflow Profile, GoalContract, PlanRevision, tool capabilities, approvals, resource budget, and verification obligations. It validates artifact type/schema, digest, access classification, provenance/usage metadata, and task suitability before use.
6. The consumer does not inherit producer permissions, approvals, capability tokens, profile version, budget, secrets, workspace/repository access, MediaProject access, private context projection, prompts, or model/session state.
7. The consumer may read only the explicitly handed-off artifact payload through the scoped capability. It cannot traverse the producer Task, workspace, repository, MediaProject, or unrelated artifacts through the ArtifactRef.
8. Lineage records the producer Task → artifact → authorized handoff → consumer Task → derived output artifact relationship. The relationship is audit metadata, not a shared Task aggregate or execution authority.
9. Cross-domain transfer is explicitly authorized by the user unless an immutable prior authorization names the exact artifact scope/type, destination domain, purpose, and allowed operation. Authorization to create a producer artifact does not authorize transfer or consumption.
10. A change in artifact digest, destination domain, purpose, access mode, or material scope requires a new handoff authorization and consumer validation. Revocation blocks new reads/consumption; already materialized copies follow the applicable retention/deletion policy.
11. A Coding ↔ Video transition never changes the domain of an existing Task. Composite cross-domain autonomous Tasks and shared mixed-domain context remain deferred.

### Alternatives not selected

- **Composite Task with multiple active DomainBindings:** risks ambiguous authority, mixed evidence semantics, and accidental capability inheritance.
- **Shared RepositoryModel/MediaProjectModel context:** collapses domain-specific cognition and may expose unrelated private state.
- **ArtifactRef as bearer permission:** confuses identity/reference with authorization and allows accidental privilege escalation.
- **Implicit transfer because the producer was authorized:** fails to express the user's separate decision to expose data to another domain.

### Risks and limitations

Artifact handoff adds orchestration and authorization overhead. A consumer may still misinterpret a valid artifact; schema and digest validation do not establish semantic suitability. ADP-04 must define the consumption-eligible artifact state and generic manifest/payload integrity rules. Cross-domain composite workflows need a separate future decision.

### Acceptance and later evaluation conditions

1. A Task cannot activate two domains or two active DomainBindings.
2. Every handoff binds exact source Task, Artifact ID/digest/schema, destination Task/domain, purpose, access mode, and authorization evidence.
3. A consumer cannot read an artifact without a separate current capability scoped to that exact handoff.
4. Producer permissions, approvals, profile, budgets, secrets, private context, and workspace/project access are not inherited.
5. Digest/schema/classification/authorization mismatch and ineligible artifact states are rejected.
6. Handoff lineage is auditable from producer through consumer to derived output.
7. Revoked/expired handoff authority blocks new reads; any materialized-copy retention behavior is explicit.
8. Shared Kernel evaluation includes positive handoff, wrong-domain/wrong-schema, digest mismatch, stale/revoked grant, attempted producer-context access, and attempted permission inheritance cases.
9. Composite cross-domain autonomous workflows remain deferred; no Runtime or implementation authorization is implied.

**Related contracts/evaluation:** [Domain Workflow binding contract](../contracts/domain-workflow.md), [Completion](../contracts/completion.md), [Shared Kernel evaluation](../research/shared-kernel/evaluation.md), [Unified domain architecture](../architecture/domain-architecture.md), and ADP-04 artifact lifecycle.

## 11. ADP-10 — Minimal preview and approval surface

**Recommendation — PROPOSED**

Do not build a manual timeline editor in the first phase. Provide a lightweight review surface around the autonomous workflow:

- source asset list and technical warnings;
- contact sheet/keyframes with source timecodes for navigation;
- optional low-resolution preview when a visual review materially reduces ambiguity;
- concise edit summary and explicit assumptions;
- approve, request revision, or reject actions tied to the exact TimelineRevision/RenderPlan version.

The review surface does not expose arbitrary track editing, drag-and-drop, or free-form FFmpeg settings. A revision request becomes a new EditIntent and TimelineRevision. Human approval is required only where the accepted criterion/policy requires it or the user explicitly requests approval before final render/delivery.

**Alternatives**

- No preview/approval surface; deliver only the final output and report.
- Build a full timeline UI with manual editing controls.

**Risks and trade-offs**

- No preview can make it harder to catch wrong source selection before an expensive final render.
- A low-resolution preview adds render cost and must be clearly distinguished from the final deliverable.
- A full editor UI would materially expand scope and is not needed to validate the autonomous-editing product direction.

**Acceptance criteria**

- Every preview is bound to the exact source/project and TimelineRevision digest.
- A preview cannot be mistaken for the final verified artifact.
- Approval is version-specific; approving an old revision does not approve a newer one.
- Revision and rejection are append-only user events.
- No preview interaction grants new tool or filesystem permissions.

## 12. ADP-11 — Recommended implementation sequence and gates

**Recommendation — PROPOSED**

After the owner approves the relevant architecture decisions and explicitly authorizes implementation planning, use this sequence:

1. **Shared Kernel minimum foundation first:** define the authoritative Task/Plan lifecycle, admission, budget reservation/settlement, Journal/Host receipt boundary, UNKNOWN reconciliation, cancellation, generic ArtifactRef/manifest, and Completion Guard interfaces. Do not implement domain semantics in Kernel.
2. **Coding vertical slice second:** use the retained Coding research to exercise repository snapshotting, read/write tool admission, tests, evidence freshness, plan revision, and criterion-level completion with deterministic fixtures.
3. **Video vertical slice third, immediately after the shared path is stable:** exercise large immutable media artifacts, source/timebase provenance, long-running RenderJob, CPU/disk accounting, process-tree cancellation, UNKNOWN reconciliation, staged publication, and technical/content verification.
4. **Schema/contract review:** produce examples and deterministic validation rules for GoalContract, DomainBinding, TimelineRevision, RenderPlan, RenderJob, ArtifactRef, and VerificationReport before domain implementation expands.
5. **Isolated contract spikes:** only with separate authorization, test rational-time conversion, timeline compilation, artifact staging/finalization, and Host process convergence using deterministic fixtures/fake providers.
6. **Evaluation preparation:** freeze separate Coding and Video task schemas/rubrics and the shared Kernel fault-injection matrix before any baseline run.
7. **Runtime and external execution:** require separate explicit authorization for code, dependencies, real models, external media, network, budgets, and stop conditions.

The Coding-first order is a sequencing recommendation, not permission to make Kernel code-repository-specific. The generic artifact and long-running Host contracts must exist before the Coding slice so that the subsequent Video slice validates shared abstractions rather than requiring a Kernel redesign.

**Alternatives**

- Implement Video first because its render lifecycle exposes long-running Host/resource behavior; this is preferable if Video is the immediate product priority and the shared artifact/Host contracts are already stable.
- Implement a thin shared Kernel skeleton before either domain vertical slice, then run the two domain slices in parallel; this increases coordination and integration cost.

**Risks and trade-offs**

- Coding-first may under-exercise large binary artifacts and long-running media operations.
- Video-first may overfit common contracts to render jobs.
- Kernel-only implementation can remain abstract without a domain vertical slice.
- Parallel full implementation can create integration churn before authority and artifact boundaries are proven.

**Acceptance criteria**

- Every stage has explicit inputs, outputs, owner approval, and exit criteria.
- The shared Kernel foundation passes deterministic authority, receipt, UNKNOWN, cancellation, budget, artifact-integrity, and completion-contract checks before domain-specific implementation expands.
- The Coding slice validates repository/workspace/test/evidence behavior without introducing domain-specific authority into Kernel.
- The Video slice validates large artifacts and long-running media execution through the same shared interfaces.
- Contract spikes use deterministic fixtures and report PASS/FAIL/NOT RUN accurately.
- No implementation or benchmark authorization is inferred from architecture approval.
- The first vertical slices validate each domain end-to-end without merging their models.

## 13. Owner decision record

The following choices require explicit owner disposition. "Accept" means accept the recommendation as an architecture direction, not authorize implementation.

| ID | Recommended disposition | Owner response |
| --- | --- | --- |
| ADP-01 | Approve complete autonomous editing loop in the revised bounded core scope; defer advanced/editor-grade features | REVISED — APPROVED 2026-11-02 |
| ADP-02 | Accept four-stage progressive analysis with source-wide coverage accounting and adaptive evidence expansion | OPEN — draft prepared |
| ADP-03 | Accept immutable profile versions, current-effective admission/dispatch checks, immediate revocation, and UNKNOWN hold | OPEN — draft prepared |
| ADP-04 | Accept generic manifest + opaque immutable payload contract | OPEN |
| ADP-05 | Accept per-stream integer/rational time, explicit conversion/rounding, and A/V mapping | OPEN — draft prepared |
| ADP-06 | Accept profile registry; decide compatibility-profile values separately | OPEN |
| ADP-07 | Accept criterion-level evidence classes and risk-based human review | OPEN |
| ADP-08 | Accept Host-declared enforcement capability; GPU optional | OPEN |
| ADP-09 | Accept separate Tasks, typed ArtifactRef, scoped transfer authorization, and no capability inheritance | OPEN — draft prepared |
| ADP-10 | Accept lightweight preview/approval surface; no full editor | OPEN |
| ADP-11 | Accept staged implementation sequence and separate authorization gates | OPEN |

ADP-01 is the only item with an explicit owner disposition so far: REVISED, approved in revised form and recorded in the Decision Log. Detailed first-batch drafts for ADP-02, ADP-03, ADP-05, and ADP-09 are now prepared, but all four remain OPEN pending explicit owner disposition. ADP-04, ADP-06 through ADP-08, and ADP-10 through ADP-11 also remain OPEN. Any later partial acceptance must identify the accepted clause and required revision. Approval of ADP-01 or draft readiness does not authorize Runtime implementation, production dependencies, real-model/media experiments, or technology selection.
