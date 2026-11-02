# Media Timeline artifact contract

> **Status: PROPOSED Video-domain contract.** TimelineRevision is an immutable, non-destructive editing artifact. This contract binds it to exact project, analysis, narrative, and task versions. It does not define a GUI editor or authorize Runtime implementation.

## 1. Purpose and ownership

A MediaProject is the persistent Video-domain container. A TimelineRevision is the canonical, non-destructive description of the intended edit within one exact ProjectSnapshot.

- Video Domain Intelligence owns story, pacing, moment selection, ordering, semantic continuity, and edit rationale.
- MediaProjectModel supplies provenance-aware context; MediaAnalysis supplies bounded raw/derived evidence.
- NarrativePlan records message, story beats, candidate/selected moments, ordering constraints, and rationale before frame-level editing.
- TimelineRevision records exact source ranges and typed edit operations.
- Kernel records artifact identity, lineage, DomainBinding, GoalContract/PlanRevision binding, and authorized state transitions.
- Tool Runtime/Trusted ToolHost compile and render only an admitted revision.
- TimelineRevision is not permission to render, overwrite, or publish a file.

The canonical timeline remains separate from FFmpeg command/filtergraph syntax. FFmpeg is an execution backend, not the source of truth for the edit.

## 2. TimelineRevision identity and binding

A revision binds at minimum:

- MediaProject ID, exact ProjectSnapshot ID/generation/manifest digest;
- timeline ID, revision ID, parent revision ID, immutable content digest, schema version;
- Task ID, accepted GoalContract version, active PlanRevision/PlanStep, DomainBinding/profile version;
- MediaProjectModel projection ID/version/digest;
- selected MediaAnalysis IDs, analysis manifest digest, claim/evidence references;
- NarrativePlan ID/version/digest and selected beat/moment references;
- source MediaAsset IDs/content digests, stream identities, source timebase/PTS mappings;
- timeline timebase and output-profile ID/version;
- ordered tracks, clips, transitions, overlays, audio decisions, and typed operation versions;
- criterion-to-beat/clip/timeline mapping and edit rationale references;
- creation sequence, authoring ModelStep/Attempt, user EditIntent and parent/change-set references;
- EvidenceCarryForward records and validation/invalidation conditions.

A new natural-language instruction creates a new immutable EditIntent and TimelineRevision candidate. It never mutates an accepted prior revision or delivered render.

## 3. Time representation

Floating-point seconds are not the canonical frame-accurate representation.

- Source ranges bind to the selected source stream's integer presentation timestamps (PTS) and exact rational timebase.
- A source range is [start_pts, end_pts); the end is exclusive.
- Timeline placement uses integer ticks against an explicit rational timeline timebase.
- Rational values are stored as integer numerator/denominator pairs, reduced to canonical form where practical.
- Frame rate is a rational value; variable-frame-rate sources retain their source PTS/timebase and are not silently treated as constant-frame-rate.
- Audio ranges use the relevant audio stream timebase/sample positions. Resampling or rate conversion is explicit in RenderPlan.
- Every conversion among source PTS, timeline ticks, frames, and audio samples records source basis, target basis, and deterministic rounding rule.

Illustrative values such as a 1/90000 source timebase or 25/1 timeline rate are examples, not defaults.

### 3.1 Canonical coordinates and conversion records

A source timestamp is interpreted only together with the identity of its stream and that stream's time base. PTS is preserved as a signed integer; a time base is a positive rational value with positive denominator and is reduced to canonical numerator/denominator form where representable. The exact wire encoding and integer-width choice remain open.

For VFR video, preserve each available frame's presentation PTS and duration (or explicitly record duration as unknown). Do not derive per-frame PTS from average/nominal FPS. Decode timestamps such as DTS, when retained for decoder diagnostics, are not substituted for presentation coordinates.

For audio, preserve integer sample positions and sample rate together with the selected stream identity, PTS/time base, and any offset or resampling map. Audio sample ranges are end-exclusive. A/V alignment is represented by explicit per-stream origins/offsets and, where necessary, a piecewise mapping; streams are not independently reset to zero without a declared normalization operation.

Every conversion among source PTS, rational timeline ticks, output frame timestamps, and audio sample positions records a TimeMapping/conversion entry containing:
- source stream and source coordinate/time base;
- target coordinate/time base;
- exact rational value before quantization;
- rounding-policy ID/version and operation semantics;
- resulting integer coordinate and the declared quantization error/bound;
- any normalization, resampling, or frame-rate conversion operation and its provenance.

Rounding is explicit per operation. For an interval whose semantics require preserving all covered source material, the declared policy may round the start down and the end up. A nearest-boundary policy is permitted only when the edit operation explicitly defines that behavior and a deterministic tie rule. No implicit default is inferred from the renderer or host language. Missing/invalid PTS or sample timing remains unknown; an estimated mapping must identify its method and uncertainty and cannot be relabelled as original source timing.

Floating-point seconds and timecode strings are presentation values only. They may be generated for UI display but cannot be the sole basis for source-range identity, cut boundaries, or provenance. The conversion policy/version and resulting mappings are included in the TimelineRevision/RenderPlan digests.

## 4. Canonical structures### 3.2 Piecewise stream-to-asset presentation mapping

All streams in one MediaAsset are related through an immutable asset-relative presentation clock represented as an exact rational value. Each stream maps to that clock through one or more explicit StreamTimeMapping segments. This is a logical mapping contract; it does not select a container parser, decoder, database encoding, or media library.

For a continuous video segment, the mapping is:

    asset_time = anchor_asset_time + (source_pts - anchor_source_pts) × stream_time_base

For a continuous decoded-audio segment, the mapping is:

    asset_time = anchor_asset_time + (sample_index - anchor_sample_index) / sample_rate

Each mapping segment records the stream ID, segment ID, source-coordinate interval, anchor source coordinate, anchor asset time, exact time base/sample rate, mapping provenance, and any gap, overlap, discontinuity, or uncertainty. A discontinuity starts a new segment. The system must not interpolate across a gap or reset a stream to zero without an explicit normalization operation and mapping record.

For audio, the mapping must preserve the relationship among packet PTS, stream time base, decoded presentation sample positions, sample rate, codec priming/skip-sample metadata, discard padding, and resampling. Packet positions and decoded presentation sample positions are not assumed to be identical. For VFR video, preserve each available frame PTS and duration. If duration is derived from the next PTS, the derivation is valid only inside the same verified continuity segment and is labelled as derived; otherwise duration remains unknown.

A/V alignment is computed by mapping the relevant video and audio coordinates onto the same asset-relative clock. A mathematically exact mapping is not by itself proof of perceptual synchronization; output verification separately measures rendered A/V drift against the selected profile tolerance. Numeric tolerance remains an evaluation/profile decision, not a universal timeline constant.

All intermediate arithmetic remains exact rational/integer arithmetic. Overflow or an unrepresentable value must produce an explicit failure or use a declared wider exact representation; floating-point seconds are never a silent fallback or canonical substitute.



### 4.1 Media references and provenance

Each clip references an immutable MediaAsset ID/digest and selected stream identity, not an unbound mutable path. It records source PTS/timebase, verified duration bounds, and proxy/derived-media references when analysis used a proxy. The proxy-to-source mapping and transformation digest are required.

### 4.2 Narrative and editorial decisions

The timeline retains:

- NarrativePlan beat ID(s) and message/criterion mapping;
- selected moment/candidate IDs and source evidence references;
- clip/track IDs, track kind, order, and compositing/audio-mix semantics;
- source asset/stream reference and end-exclusive source range;
- timeline start/duration and playback-rate rational where supported;
- crop/scale/position/rotation/volume/fade settings as typed parameters;
- explicit transition/overlap references;
- continuity/audio rationale where a cut is intentionally discontinuous or bridges sound;
- change-set and affected beat/clip/criterion mapping.

The timeline is an execution-ready editorial artifact, but it does not contain arbitrary FFmpeg arguments or raw filtergraph strings.

### 4.3 Output profile and adaptation

The timeline references an immutable Output Profile version and may declare editorial framing intent. Container/codec, resolution, aspect-ratio conversion, frame-rate conversion, color policy, audio layout, metadata, and platform packaging are applied by a separate output-adaptation stage. Profile-specific transformations must be explicit RenderPlan operations and must not silently alter the story.

A profile field not specified by the user is an explicit default/assumption in GoalContract or Workflow Profile; it must not be presented as a user requirement.

## 5. Structural and semantic invariants

Before a TimelineRevision can be accepted:

1. Every clip references an existing immutable MediaAsset and valid stream identity.
2. Every source range is within verified source duration and decodable boundaries.
3. Source and timeline ranges have valid positive durations and exact timebase bindings.
4. Track ordering, overlaps, transitions, overlays, and audio mixing are structurally valid.
5. Output duration/profile are compatible with accepted GoalContract.
6. No source asset is modified in place.
7. Every proxy/analysis artifact points back to original source digest and transformation/time mapping.
8. Every required criterion maps to a NarrativePlan beat, selected moment, timeline region, and verification obligation, or to an explicit human-review obligation.
9. A stale source, stream map, proxy, analysis claim, NarrativePlan, or profile invalidates affected timeline claims and requires revalidation.
10. Serialization/schema validity does not establish story, pacing, continuity, or factual coherence; those remain Video Domain Intelligence responsibilities.
11. The RenderPlan compiler accepts only typed operations in the active supported operation registry.
12. A candidate timeline is not renderable until the applicable GoalContract/PlanRevision/DomainBinding and policy gates are accepted.

Kernel validates schema, references, binding, size limits, and legal lifecycle. It does not judge the story or pacing.

## 6. Evidence inheritance and change impact

Evidence is not inherited merely because a new revision names an old parent.

A new NarrativePlan/TimelineRevision may carry forward unaffected evidence only through an explicit EvidenceCarryForward entry that binds:

- prior claim/evidence ID and digest;
- target beat, clip, criterion, and source interval;
- exact source asset digest, stream identity, PTS/sample range, and timebase;
- analysis/proxy/mapping/configuration version;
- freshness/compatibility result and validation sequence;
- reason the evidence remains relevant to the new revision.

Carry-forward is allowed only if source digest, stream identity, time mapping, analysis scope/configuration, and criterion meaning remain compatible. A change-impact record declares affected beats, clips, source intervals, analysis claims, audio relationships, output profile fields, and verification obligations.

| Change | Required response |
| --- | --- |
| New revision changes only one unrelated beat | Revalidate changed beat and explicit dependencies; carry forward other evidence only after freshness checks |
| Selected source interval changes | Revalidate source-range, content, continuity, audio, and final-output evidence for affected regions |
| Clip order changes | Re-evaluate narrative/chronology, transition, continuity, and criterion mapping across affected neighbors |
| Transition/overlap changes | Revalidate duration, temporal mapping, audio/video sync, and final-output region |
| Audio bridge/mix changes | Revalidate dialogue integrity, source alignment, loudness/clipping, and sync |
| Project adds an unrelated asset | Existing source-bound evidence may remain current; recheck project-level completeness/exclusions |
| Source digest/stream/timebase changes | Affected claims and timeline references become stale |
| Analysis/proxy mapping changes | Revalidate claims that depend on the changed analysis or mapping |
| Output profile/renderer/build changes | Recompile RenderPlan and repeat affected technical/output adaptation checks |
| Final output bytes change | Prior final-output verification and publication evidence become stale |

A newer analysis may supersede an older claim for future planning without deleting the old claim as historical evidence. Conflicting claims remain visible and unresolved until assessed.

## 7. User-directed revision

Each follow-up instruction is an append-only EditIntent bound to the current accepted GoalContract and TimelineRevision.

1. Resolve the instruction to affected criteria, beats, clips, tracks, source ranges, audio, and output constraints.
2. Ask the user when multiple materially different interpretations exist or a protected output/scope/risk field changes.
3. Produce a new NarrativePlan/TimelineRevision candidate with explicit parent and change set.
4. Reuse unaffected analysis only when source digest, timebase, proxy mapping, profile, criterion meaning, and freshness remain valid.
5. Re-run affected structural/semantic checks and create a new RenderPlan.
6. Preserve previous timelines, renders, and reports for comparison; do not overwrite history.

Routine reversible edits may be proposed within accepted scope. Adding external media, changing source assets, materially changing the requested story/output, or introducing external effects requires applicable confirmation.

## 8. Rendering boundary

The canonical timeline is compiled into a versioned RenderPlan binding:

- TimelineRevision digest, source asset/stream digests, and source-to-output mapping;
- exact typed transform/encode operations and compiler version;
- renderer/FFmpeg build identity and canonical argv/filtergraph digest;
- output profile, resource budget, Host isolation profile, and expected artifact;
- verification plan, idempotency identity, and fencing epoch.

The model does not author or execute arbitrary shell commands. A deterministic compiler maps validated timeline operations to bounded argv/filtergraph structures. Kernel admits the RenderJob and Trusted ToolHost executes it. See [RenderPlan security contract](render-plan-security.md) and [RenderJob contract](render-job.md).

## 9. Artifact delivery and traceability

A successful Video Editing Task may deliver the rendered video, accepted TimelineRevision, NarrativePlan, render manifest, criterion-linked VerificationReport, source-to-output provenance map, and optional preview/contact-sheet artifacts.

For every output interval, the provenance map identifies the contributing source asset digest, stream, source PTS/sample interval, timeline clip/transition, transformation operations, and RenderPlan node(s). A transition may map one output interval to multiple source intervals. Generated or externally supplied elements are marked as such and bind their authorized origin/derivation record.

The timeline is an inspectable project artifact. Delivering it does not imply a manual timeline editor or full editing UI.
