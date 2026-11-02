# Media Timeline artifact contract

> **Status: PROPOSED Video Editing domain contract.** The timeline is a persistent, versioned engineering artifact for natural-language-driven automatic editing. It is not a visual editor document format or a commitment to a particular UI.

## 1. Purpose and ownership

A MediaProject is the persistent Video-domain container that groups immutable source MediaAssets, derived analysis/proxy artifacts, TimelineRevisions, RenderPlans, RenderJobs, and verification/delivery records. It has a stable project ID, a monotonically versioned project generation, and a manifest digest. It is not an editor session, a GUI requirement, or an execution authority; Kernel Task/Journal state remains authoritative for work.

A TimelineRevision is the canonical, non-destructive description of the intended edit within a MediaProject. It is produced by Video Editing Intelligence, stored as an immutable artifact, and executed by the Video Domain Execution tools.

- Domain Intelligence decides story, pacing, shot selection, ordering, and semantic edit quality.
- Kernel records artifact identity, lineage, DomainBinding, GoalContract/PlanRevision binding, and authorized state transitions.
- Tool Runtime/Trusted ToolHost compile and render only an admitted revision.
- The timeline artifact is not itself permission to render or overwrite a file.

The canonical timeline must remain separate from the FFmpeg command line/filtergraph generated from it. FFmpeg is an execution backend, not the source of truth for the edit.

## 2. TimelineRevision identity and binding

A revision binds at minimum:

- MediaProject ID, project generation, project manifest digest, timeline ID, revision ID, parent revision ID, and immutable content digest;
- Task ID, accepted GoalContract version, active PlanRevision, and DomainBinding/profile version;
- source MediaAsset IDs, source content digests, selected stream IDs, and analysis-evidence references;
- timeline timebase and output profile;
- ordered tracks and clips, transition and overlay definitions;
- criterion-to-timeline mapping and edit rationale references;
- creation sequence, authoring ModelStep/Attempt, and user EditIntent references;
- validation results and invalidation conditions.

A new natural-language edit instruction creates a new immutable EditIntent and a new TimelineRevision candidate. It never mutates an accepted prior revision or an already delivered render.

## 3. Time representation

Floating-point seconds are not the canonical frame-accurate representation.

- Source ranges bind to the selected source stream's integer presentation timestamps (PTS) and exact rational time base.
- A source range is [start_pts, end_pts); the end is exclusive.
- Timeline placement uses integer ticks against an explicit rational timeline time base.
- Rational values are stored as integer numerator/denominator pairs, reduced to canonical form where practical.
- Frame rate is recorded as a rational value; variable-frame-rate sources retain their source PTS/timebase and must not be silently treated as constant-frame-rate.
- Audio ranges use the relevant audio stream time base/sample position. Any resampling or rate conversion is explicit in the render plan.

For example, a source stream time base may be represented as {num: 1, den: 90000} and a timeline rate as {num: 25, den: 1}. These are illustrative values, not defaults.

The renderer may convert between source PTS, timeline ticks, frames, and audio samples, but the conversion and rounding policy must be explicit and recorded.

## 4. Canonical structures

A TimelineRevision contains:

### Media references

- MediaAsset ID and content digest, not an unbound mutable file path;
- selected video/audio/subtitle stream IDs;
- source PTS/time base and asset duration bounds;
- proxy/derived-media references where analysis used a proxy.

### Tracks and clips

- stable track and clip IDs;
- track kind (video, audio, subtitle, title/overlay);
- explicit track order and compositing/audio-mix semantics;
- source asset/stream reference;
- source in/out range;
- timeline start/duration;
- playback-rate rational where supported;
- crop/scale/position/rotation/volume/fade settings as typed parameters;
- explicit transition/overlap references;
- criterion and analysis-evidence references.

### Output profile

- target duration range;
- aspect ratio and frame-rate policy;
- output container/codec/profile constraints;
- audio layout/loudness constraints;
- subtitle/caption policy;
- output dimensions and color policy where specified.

A profile field not specified by the user is an explicit default/assumption in the GoalContract or Workflow Profile; it must not be silently presented as a user requirement.

## 5. Structural invariants

Before a TimelineRevision can be accepted:

1. Every clip references an existing immutable MediaAsset and a valid stream.
2. Every source range is within the verified source duration and decodable boundaries.
3. Source and timeline ranges have valid positive durations and exact timebase bindings.
4. Track ordering, clip overlaps, transitions, overlays, and audio mixing are structurally valid.
5. The output duration and profile are compatible with the accepted GoalContract.
6. No source asset is modified in place.
7. Every derived proxy/analysis result points back to the original source digest and transformation record.
8. Every required acceptance criterion has a timeline/verification mapping or an explicit human-review obligation.
9. A stale source asset, stream map, proxy, or analysis version invalidates affected timeline claims and requires revalidation.
10. A timeline revision cannot be accepted merely because it serializes successfully; semantic coherence remains a Domain Intelligence responsibility.

Kernel validates schema, references, binding, size limits, and legal lifecycle. It does not judge the story or pacing.

## 6. User-directed revision

Each follow-up instruction is an append-only EditIntent bound to the current accepted GoalContract and TimelineRevision.

The revision process:

1. Resolve the instruction to affected criteria, clips, tracks, source ranges, and output constraints.
2. Ask the user when multiple materially different interpretations exist or when a protected output/scope/risk field changes.
3. Produce a new TimelineRevision candidate with explicit parent and change set.
4. Reuse unaffected analysis/artifacts only when source digest, timebase, profile, and freshness remain valid.
5. Re-run affected structural checks and create a new RenderPlan.
6. Preserve all previous timeline and render artifacts for comparison or rollback-by-selection; do not overwrite history.

Routine reversible edits such as shortening an intro or changing the order of selected clips may be proposed within the accepted scope. Adding external media, deleting or replacing source assets, materially changing the requested story/output, or introducing new external effects requires the applicable confirmation.

## 7. Rendering boundary

The canonical timeline is compiled into a versioned RenderPlan that binds:

- TimelineRevision digest;
- source asset/stream digests;
- exact filter/transform/encode operations;
- renderer and FFmpeg build/version identity;
- argv/argument digest and environment;
- output profile, resource budget, and expected artifact;
- verification plan.

The model does not directly author or execute an arbitrary shell command. A deterministic compiler maps validated timeline operations to a bounded argv/filtergraph representation. Kernel admits the RenderJob and Trusted ToolHost executes it.

## 8. Artifact delivery

A successful Video Editing Task may deliver:

- the rendered video artifact;
- the accepted TimelineRevision artifact;
- a render manifest with source, timeline, renderer, environment, and output digests;
- a criterion-linked verification report;
- optional preview/contact-sheet artifacts when requested or useful.

The timeline is an inspectable, persistent project artifact. Delivering it does not imply that a manual timeline editor or full editing UI exists.
