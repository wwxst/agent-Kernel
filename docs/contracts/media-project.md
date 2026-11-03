# MediaProject, MediaAnalysis, and MediaProjectModel contract

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03); implementation NOT started; media-quality and runtime claims UNVERIFIED.** This document defines media identity, ProjectSnapshot canonicalization, the CoverageManifest contract, typed claims, the NarrativePlan schema, and evidence-inheritance rules. Canonical serialization and digest form follow [Kernel data model](kernel-data-model.md) §2.2; execution authority remains with Kernel and Trusted ToolHost. It does not select a database, object store, analysis provider or implementation topology.

## 1. Purpose and authority

The Video domain needs a persistent project container and a reproducible evidence model that survives multiple Tasks and editing revisions.

- **MediaProject** is the durable Video-domain project identity and manifest lineage.
- **ProjectSnapshot** is an immutable, content-digested view of the project's assets and derived artifacts at one generation.
- **MediaAsset** is an immutable source or derived media artifact.
- **MediaAnalysis** is an immutable record of one bounded analysis run over exact inputs.
- **MediaProjectModel** is a versioned Context Engine projection built from an exact ProjectSnapshot and a declared set of analysis/evidence artifacts.
- **NarrativePlan** is an immutable Video-domain artifact; its normative shape is `media.narrative_plan.v1` in §5.1 below. The reasoning method lives in [Video Editing Intelligence](../research/multimedia-domain-architecture/intelligence.md).
- **TimelineRevision** is an immutable editing artifact bound to the exact project snapshot, model/analysis evidence, NarrativePlan, and accepted task contracts.

None of these objects is execution authority. Kernel Task/Journal state, Workflow Profile, authorization, budgets, ToolInvocation admission, and Host Ledger remain authoritative for their respective responsibilities.

## 2. MediaProject and ProjectSnapshot

### 2.1 MediaProject identity

A MediaProject has a stable media_project_id and append-only project history. Its logical manifest includes:

- schema/version and project identity;
- monotonically increasing project_generation;
- current manifest digest and parent snapshot reference;
- immutable MediaAsset and derived-artifact references;
- source/derived lineage edges;
- analysis-run and MediaProjectModel projection references;
- NarrativePlan, TimelineRevision, RenderPlan, RenderJob, and VerificationReport artifact references;
- provenance, access classification, retention, and lifecycle metadata.

The mutable notion of "current project" is only a head reference to an immutable ProjectSnapshot. It is not a mutable bag of files. Every committed project change produces a new snapshot/generation and manifest digest; prior generations remain addressable.

A Task binds the exact ProjectSnapshot/generation it reads or proposes to extend. A project generation change does not silently change an accepted GoalContract, PlanRevision, TimelineRevision, or RenderPlan.

### 2.2 ProjectSnapshot

A ProjectSnapshot records:

| Field | Rule |
| --- | --- |
| `snapshot_id`, `media_project_id`, `project_generation` | Identity; generation increases monotonically. |
| `schema_version` | `media.snapshot.v1`. |
| `parent_snapshot_id`, `parent_manifest_digest` | Null only for the first generation. |
| `artifacts[]` | Typed references `{artifact_id, kind, schema_id/version, digest}` sorted by `(kind, artifact_id)`; no duplicate `artifact_id`. |
| `event_sequence_ref` | Commit/event range that produced this generation. |
| `created_at`, `created_by` | Provenance; never used for ordering. |
| `digest_alg`, `manifest_digest` | `sha256:` over JCS of the snapshot object excluding `manifest_digest`. |

Canonicalization rule: `manifest_digest` is computed over the canonical JCS bytes (UTF-8, NFC, no duplicate keys) of the field set above with the artifact list sorted. Identical logical artifact sets therefore produce identical digests; a digest computed from a quick fingerprint or from an unsorted/implementation-specific list is invalid. Each artifact's own digest is included, so any member change changes the snapshot digest.

The snapshot is immutable. A new ingest, derived proxy, selected analysis set, timeline, or render record may produce a new snapshot only through an explicit project-manifest commit. The mutable head is a separate pointer and never changes prior snapshot bytes or digests. A snapshot does not imply that all referenced analysis claims are current for every future GoalContract.

### 2.3 MediaAsset, content identity and stream identity

Required MediaAsset fields:

| Field | Rule |
| --- | --- |
| `media_asset_id` | Stable opaque identity; never reused for different bytes. |
| `schema_version` | `media.asset.v1`. |
| `digest_alg`, `content_digest` | `sha256:` over **every byte** of the immutable payload (full fingerprint). |
| `size_bytes`, `media_type` | Byte count and declared media type. |
| `source_kind` | `source` or `derived`. |
| `ingest_method`, `ingested_at` | How and when the bytes entered the project. |
| `payload_locator` | Opaque storage reference; never a path, bearer grant or URL. |
| `probe_ref` | Exact probe record id/digest and probe tool version. |
| `classification`, `retention` | Access and retention policy identifiers. |
| `warnings[]` | Probe/decode warnings; never silent. |
| `parent_refs[]`, `transformation` | Required for `derived` only: parent digest(s), tool/build/config, parameters, source-to-derived time mapping. |

**Fingerprint rule.** Only the full-content digest may support equality, deduplication, provenance, cache keys, or acceptance. A quick fingerprint (size, mtime, sampled head/tail ranges) is advisory, must be labelled `quick:`, and may never satisfy an equality or provenance check; it must be upgraded by a full digest before any decision, cache hit or report uses it.

**Duplicate-bytes rule.** `content_digest` is the content identity. Ingesting bytes that already exist returns the existing `media_asset_id` and appends a new reference record (project, purpose, ingest event); it never mints a second content identity. Multiple references and projects may point to one payload. Changed bytes are a new asset with new digest and explicit lineage; the prior asset is never updated.

**Stream identity.** A selected stream is never identified only by a mutable index. Bind the index together with probed stream identity metadata, source digest, timebase, start PTS, duration, codec parameters, and a stream-identity digest. A new probe or source digest that changes the stream map requires revalidation.

The original source is never overwritten. A proxy, thumbnail, waveform, extracted audio track, normalized transcode, or other derived artifact receives its own Artifact id/digest and the `transformation` record above.

## 3. MediaAnalysis run record

Every analysis operation produces an immutable MediaAnalysis record. A record describes one analysis run, not a permanent fact about the project.

Minimum logical fields:

| Field | Meaning |
| --- | --- |
| analysis_id / schema version | Stable identity and record contract |
| media_project_id / project_snapshot_id | Exact project snapshot analyzed |
| input_manifest_digest | Digest of the exact analysis input set |
| asset_stream_bindings | Asset digest, stream identity, and temporal coverage |
| analysis_kind | Probe, coverage index, shot boundary, visual observation, OCR, transcript, audio event, alignment, quality, or other typed analysis |
| tool_model_build | Exact tool/model/build identity, or explicit non-model method identity |
| goal_criteria_refs / analysis_scope | GoalContract criterion IDs and exact modalities/source intervals that justified and bounded this run |
| configuration_digest | Versioned parameters, sampling policy, and relevant prompt/config digest |
| coverage_manifest | Time intervals, frame/sample selection, gaps, and incomplete regions |
| raw_evidence_refs | Immutable frame/audio/packet/transcript/probe evidence artifacts |
| claim_refs | Derived typed claims and their provenance |
| status | Complete, Partial, FailedKnown, or OutcomeUnknown as supported by evidence |
| warnings / uncertainty | Decode errors, low confidence, conflicts, alignment limits, and unknown regions |
| created_at / producer provenance | Creation sequence, Task/ModelStep/ToolInvocation/Host receipt where applicable |

An analysis run states what it did not inspect. Sparse frame samples cannot support claims about every frame; transcript-only passes cannot prove visual content; shot detectors cannot establish semantic scenes; scene summaries cannot establish exact cut boundaries.

### 3.1 Progressive analysis and source-wide coverage accounting

The approved logical default ladder is:

1. **Technical baseline:** every supplied asset receives fingerprinting and technical probing, or an explicit failed/unavailable result.
2. **Coverage accounting:** every source asset receives a coverage manifest. For content-based selection, the selected source set receives a coarse temporal navigation index (such as representative frames and shot-boundary candidates) whose sampling density and gaps are explicit. This accounts for coverage; it does not claim exhaustive semantic understanding of every frame.
3. **Task-conditioned depth:** GoalContract criteria determine whether visual event/scene analysis, OCR, ASR/speaker alignment, audio-event analysis, loudness, or other modalities are required.
4. **Adaptive expansion:** the planner requests denser sampling, neighboring context, another modality, or a rerun only when a criterion has an evidence gap, conflict, low confidence, stale mapping, or boundary/context dependency. The request records its trigger, expected evidence, and budget reservation.

The coverage manifest distinguishes Observed, Sampled, NotSampled, NotRequested, Unavailable, and DecodeFailed intervals; records sampling method/density and the exact source/stream/timebase; and states whether the analysis is complete, partial, failed-known, or outcome-unknown. Coverage is modality-specific: a visual observation does not establish audio coverage, and a transcript does not establish visual coverage. An unobserved interval is not a negative finding. A whole-source absence claim requires coverage and a method appropriate to that claim. No expensive modality is run by default merely because the source is video.

Analysis expansion is bounded by the Task's current Workflow Profile, permissions, privacy/data-minimization rules, and resource budget. Raw frames, audio, transcripts, and embeddings are retained only under the applicable access/retention policy. A final rendered-output inspection is independent and cannot be replaced by source-analysis claims.

Raw evidence should be retained as immutable, access-controlled artifacts when required for later verification. Privacy, retention, and data-minimization policy governs whether full derived audio/transcript/frame artifacts are stored or only scoped evidence excerpts and digests.

### 3.2 Coverage manifest identity and interval contract

A CoverageManifest is bound to `(media_asset_id, analysis_generation)` and is immutable. `analysis_generation` is the manifest version for that asset; any rerun that changes coverage produces the next generation. Each MediaAnalysis record references exactly one `coverage_manifest_id` and digest and may reference it but never mutate it. This resolves the per-asset/per-run ambiguity: the manifest belongs to the asset generation, and runs cite it.

Manifest fields: `coverage_manifest_id`, `schema_version=media.coverage.v1`, `media_asset_id` + content digest, `analysis_generation`, `project_snapshot_id`, `input_manifest_digest`, `declared_analysis_scope[]`, `segments[]`, `created_at`.

`input_manifest_digest` is `sha256:` over JCS of `{sorted [{artifact_id, content_digest}], tool_snapshot_digest, configuration_digest, declared_analysis_scope[]}`: artifacts sorted by `artifact_id`, duplicates de-duplicated before hashing, and `configuration_digest` covering analyzer/profile parameters. A run whose inputs cannot be reconstructed to that digest is invalid and cannot support a criterion.

A `declared_analysis_scope` entry is `{modality, stream_id|null, interval_set[{start_pts,end_pts}], coordinate_basis (video PTS+timebase | audio sample+rate), declared_resolution, sampling_policy}`. A modality considered but not requested uses `NotRequested` over its declared scope. A modality whose stream is absent has an empty declared scope plus the probe's stream-inventory fact (§3.1 technical baseline). Segments must partition each declared scope exactly; the manifest is never a single project-wide boolean.

Each coverage segment records:
- asset digest, stream identity, modality/analysis kind, and exact source interval;
- source coordinate basis: video PTS plus rational time base, or audio sample position plus sample rate and stream mapping;
- method/build/configuration digest, sampling policy, declared resolution/density, and actual sample coordinates;
- status, raw evidence references, decode/access warnings, and the reason for any gap.

Segments use end-exclusive intervals and form a disjoint, gap-accounted partition of the declared analysis scope. Any unobserved interval is explicitly represented. The status vocabulary is mutually exclusive per segment and modality:

| Status | Contract meaning |
| --- | --- |
| Observed | The interval was processed throughout at the declared resolution; this is not a claim of exhaustive semantic understanding beyond that resolution. |
| Sampled | Only the declared subset of samples was inspected; unsampled portions remain unknown for denser claims. |
| NotSampled | The modality was in scope but no sample was successfully inspected. |
| NotRequested | The task/policy did not request this modality; this is not a failed analysis and is not evidence of absence. |
| Unavailable | The required source/stream/access/decoder/environment was unavailable. |
| DecodeFailed | Decoding was attempted and failed for the declared interval. |

A modality stream that is absent from the source is recorded as a **stream-inventory fact by the technical probe**, not fabricated as a stream-scoped coverage segment and not mislabeled as DecodeFailed. If the accepted GoalContract requires that absent modality, the corresponding evidence requirement remains unavailable/unsatisfied and cannot support a content claim. Stream absence is distinct from an existing stream that is inaccessible or fails to decode.


A status change within an interval requires a segment boundary. A video observation cannot satisfy an audio coverage obligation, nor can a transcript satisfy a visual one. A negative content claim must cite the exact modality-specific intervals, sampling method, resolution, and evidence scope that justify it. NotSampled, NotRequested, Unavailable, and DecodeFailed never count as evidence that an event is absent.

The coarse temporal navigation index spans the selected source set for content-based moment-selection tasks. It records the sampled points and gaps and remains a navigation aid rather than exhaustive semantic evidence. GoalContract criteria choose deep-analysis modalities; no expensive modality is mandatory merely because an asset contains that stream.


## 4. Analysis claims and freshness

A claim is a typed assertion. Claim kinds are closed per schema version:

| Schema | Kind-specific required fields (in addition to the common set) |
| --- | --- |
| `media.claim.shot.v1` | detector id/version, threshold, boundary kind `cut\|gradual`, boundary interval |
| `media.claim.transcript.v1` | language tag, text artifact ref + digest, word-timing ref or `unknown`, speaker-turn ref or `unknown`, alignment-quality class, ASR model/config digest |
| `media.claim.ocr.v1` | text artifact ref, region `{x,y,w,h}` in frame pixels + frame dimensions, script/language or `unknown`, detector config digest |
| `media.claim.audio_event.v1` | event-class vocabulary id/version, stream/channel, energy-basis method id, interval |
| `media.claim.visual_observation.v1` | predicate vocabulary id/version, subject refs, scene/shot refs, method/config digest |

Common required fields: `claim_id`, `schema_version`, `analysis_id`, `media_asset_id` + content digest, `stream_id` + stream-identity digest, `interval {start,end}` in integer source coordinates + `timebase`, `method_config_digest`, `raw_evidence_refs[]`, `confidence {value: 0..1 float | "unknown", method_id}`, proxy digest + source-to-proxy mapping when a proxy was used, `status`, `created_at`.

Rules: `confidence` is a producer-reported scalar with a declared method id. It is **never evidence by itself** and never substitutes for coverage, raw evidence or independent verification; `unknown` is valid and must not be coerced to zero. A claim over a proxy without a verified mapping cannot support frame-accurate edits. Absence claims require adequate coverage; `NotSampled`, `NotRequested`, `Unavailable` and `DecodeFailed` never support absence.

Claim status is not a universal truth value. At minimum distinguish:

- **Current** — inputs and method/configuration remain compatible for the declared purpose.
- **Stale** — one or more required input/version/mapping bindings no longer match.
- **Superseded** — a newer analysis exists for the same scope; the old claim remains immutable historical evidence.
- **Withdrawn** — the producer or an authorized review explicitly withdrew the claim with a reason.
- **Inconclusive / UNKNOWN** — evidence does not support a reliable conclusion.
- **Partial** — only declared coverage was inspected.

A new model or analysis version does not rewrite prior claims. It creates new records and may mark earlier claims Superseded for future selection. Historical claims remain available to explain why an earlier TimelineRevision was created.

### 4.1 Media moment (`media.moment.v1`)

A **moment** is an immutable candidate or selected interval that a NarrativePlan beat may reference. It is not a claim and not a timeline clip; it is the editorial shortlist entry that carries why an interval is usable.

| Field | Type | Required |
| --- | --- | --- |
| `moment_id`, `schema_version`, `digest` | id/version/digest | yes |
| `project_snapshot_id` | ref | yes |
| `media_asset_id`, `content_digest` | ref/digest | yes |
| `stream_id`, `stream_identity_digest` | ref/digest | yes |
| `interval {start,end}`, `timebase` | integer source coordinates + rational | yes (end-exclusive) |
| `analysis_refs[]`, `claim_refs[]` | refs | yes (≥1 claim or an explicit `unanalyzed` marker) |
| `status` | `candidate \| selected \| rejected \| superseded` | yes |
| `rank_dimensions` | map `dimension_id -> rational \| unknown` | no |
| `selection_rationale` | string ref | yes for `selected`/`rejected` |
| `created_at`, `created_by_model_step` | timestamp, ref | yes |

Invariants: `selected` moments must be members of the plan's `candidate` set for the same snapshot; a moment may be referenced by several beats; rejected candidates are retained with their rationale; a change to source digest, stream mapping or analyzer config stales the moment. This schema is the identity behind `candidate_moment_ids` / `selected_moment_ids` in §5.1; a bare interval is not a moment.

## 5. MediaProjectModel projection

MediaProjectModel is a derived read projection for Video Domain Intelligence. Each immutable projection version binds:

- projection_id, schema version, and projection logic/version;
- MediaProject ID and exact ProjectSnapshot ID/generation/manifest digest;
- exact MediaAnalysis IDs and evidence/claim manifest digest;
- source and derived artifact digests;
- projection build provenance and freshness/invalidation policy;
- normalized entities, scene/shot/moment relations, claim index, uncertainty, and conflicts.

It is not the authoritative store for source bytes or the only copy of evidence. It may denormalize or summarize facts for retrieval, but every material claim resolves to its source claim and raw evidence. The projection cannot grant access to media or authorize a tool call.

A projection built from a new ProjectSnapshot is a new version. Unchanged source-bound claims may be referenced only through a §7 `ReuseRecord` when exact digest, stream, timebase, coverage, analysis method, and task criterion remain valid; the projection still records the snapshot against which it was built.

### 5.1 NarrativePlan schema (`media.narrative_plan.v1`)

NarrativePlan is a normative immutable Video-domain artifact between the projection and the timeline. It is not executable and not a second agent.

| Field | Type | Required |
| --- | --- | --- |
| `plan_id`, `schema_version`, `digest` | id/version/digest | yes |
| `media_project_id`, `project_snapshot_id`, `model_projection_id` | refs | yes |
| `intent_ref`, `goal_id`, `goal_version` | refs | yes |
| `parent_plan_id`, `revision_number` | id/int | yes (root `null`) |
| `message`, `message_element_ids[]` | string, ids | yes |
| `criterion_ids[]` | ids | yes (≥1) |
| `beats[]` | beat records | yes (≥1) |
| `ordering`, `beat_edges[]` | `ordered\|partially_ordered`, edges | yes |
| `alternatives[]`, `assumptions[]`, `unresolved[]` | records | no |

`beat` = `{beat_id (stable across revisions), role, role_label (only for `other`), required, depends_on[], criterion_refs[], candidate_moment_ids[], selected_moment_ids[], context_before_ticks, context_after_ticks, target_duration {min_ticks,max_ticks}, pacing_intent, transition_requirements[], required_content_refs[], excluded_content_refs[], evidence_refs[]}`.

`role` is closed in v1: `hook | orientation | premise | demonstration | reaction | complication | resolution | summary | call_to_action | other`. `other` requires `role_label` and rationale. Durations are integer ticks in the timeline timebase.

Invariants: `selected_moment_ids ⊆ candidate_moment_ids`; every id in `criterion_ids[]` appears in at least one beat's `criterion_refs[]` and at least one beat is non-optional for it; digest is `sha256:` over JCS excluding `digest`; every revision names its parent and EditIntent and never mutates a prior plan. `intelligence.md` owns the reasoning method; this schema owns the shape.

## 6. Version and lineage rules

The lineage is:

**MediaProject → ProjectSnapshot[n] → MediaAsset/MediaAnalysis set → MediaProjectModel[v] → NarrativePlan[v] → TimelineRevision[v] → RenderPlan[v] → RenderJob[attempt] → VerificationReport[v]**

1. Source MediaAssets are immutable; replacement or normalized media is a new asset with explicit lineage.
2. ProjectSnapshots are immutable; generation increments on a committed manifest change.
3. MediaAnalysis records are immutable; reruns create new analysis IDs even when requested scope is identical.
4. MediaProjectModel projections are immutable and bind exact snapshot/evidence inputs.
5. NarrativePlan and TimelineRevision are immutable; each revision names its parent and append-only EditIntent/change set.
6. RenderPlan is immutable and binds one exact TimelineRevision and its input digests.
7. Each RenderJob attempt is bound to one exact RenderPlan and one or more separately admitted ToolInvocations as declared by the domain contract.
8. VerificationReport binds the actual output digest and all relevant upstream versions; it is stale if any required binding changes.
9. A new project generation or analysis result does not mutate an old TimelineRevision or report.

## 7. Evidence inheritance and invalidation

Evidence inheritance is explicit, not implicit.

A new NarrativePlan or TimelineRevision may carry forward evidence from its parent only by recording an `EvidenceCarryForward` record:

| Field | Type | Required |
| --- | --- | --- |
| `carry_forward_id`, `schema_version`, `digest` | id/version/digest | yes |
| `prior_evidence_id`, `prior_digest` | ref/digest | yes |
| `target {criterion_id, beat_id?, clip_id?, interval}` | refs/interval | yes |
| `source {media_asset_id, content_digest, stream_id, interval, timebase}` | refs | yes |
| `analysis_config_digest`, `proxy_mapping_digest?` | digests | yes / conditional |
| `freshness {result, checked_at, validator}` | enum/timestamp/ref | yes |
| `rationale`, `validation_sequence` | string, uint64 | yes |

Carry-forward is allowed only when underlying source digest, stream identity, time mapping, analysis scope/configuration, and criterion meaning remain compatible. Parent linkage alone does not prove evidence freshness.

**ReuseRecord (cache and cross-task reuse).** Reusing a prior probe, analysis, projection or proxy outside a parent-plan lineage (for example a cache hit) requires `{reuse_id, reuse_kind: probe|analysis|projection|proxy, prior_id + digest, media_asset_id + digest, stream_id/timebase/mapping digest, analyzer/proxy/config digest, privacy/access class, policy_digest, freshness_result, validator, validated_at}`. A cache hit without a ReuseRecord is invalid. Reuse is forbidden across access classes and after retention expiry or authorization revocation; parent linkage alone is never freshness.

| Change | Evidence consequence |
| --- | --- |
| New project snapshot adds an unrelated source asset | Existing evidence for unchanged assets may remain current; recheck project-level completeness and exclusions |
| Source bytes/digest change | All claims and timeline references to that source become stale |
| Stream identity, timebase, rotation, or decode mapping changes | Affected stream/time-based claims become stale |
| New proxy with a verified exact source-time mapping | Source evidence may be reused only after mapping and digest validation; proxy-specific claims need revalidation |
| Analysis tool/model/config changes | New claims are required for claims dependent on changed behavior; raw source evidence remains historical |
| New task criteria or changed criterion meaning | Re-evaluate claim suitability; no automatic carry-forward |
| Timeline changes in an unrelated beat | Unaffected claims may carry forward with explicit scope and freshness check |
| Timeline changes a source interval, order, transition, or audio relationship | Revalidate affected beat/clip/continuity/audio claims and final-output evidence |
| Renderer/build/output profile changes | Re-run technical output checks and source-to-output mapping validation |
| Final output bytes change | Prior final-output verification and publication evidence become stale |

A new analysis result may supersede an old claim without invalidating the old claim as historical evidence. The current projection chooses a current compatible claim set; it does not erase disagreement. If evidence conflicts, the model preserves the conflict and the planner resolves it or asks for human input.

## 8. Relationship to TimelineRevision and completion

TimelineRevision binds exact ProjectSnapshot ID/generation/manifest digest; exact MediaProjectModel projection ID/version/digest; selected MediaAnalysis IDs and claim/evidence refs; NarrativePlan ID/version/digest; accepted GoalContract, PlanRevision, DomainBinding/profile version; parent TimelineRevision and EditIntent/change-set; explicit EvidenceCarryForward entries; source asset/stream digests and output profile.

Final VerificationReport independently binds actual output artifact digest, render receipt, and source-to-output provenance map. A MediaProjectModel claim or NarrativePlan rationale cannot replace evidence sampled from the rendered output.

## 9. Non-claims and open questions

This contract does not select a relational/document/graph database, event-store topology, object/blob store, filesystem, cache, streaming technology, media-analysis provider/model, prompt strategy, GPU policy, universal entity ontology, or confidence threshold. C2PA is not mandatory.

Open questions include raw-evidence retention, privacy/redaction of transcripts and frames, stable stream identity across remuxing, proxy time-mapping tolerances, and how analysis-method changes affect evidence compatibility.

## 10. Research references

- [C2PA Technical Specification](https://spec.c2pa.org/specifications/specifications/2.1/specs/C2PA_Specification.html) describes signed provenance claims, edit actions, and ingredient relationships. It is an interoperability reference, not a requirement to adopt C2PA. Provenance can document lineage and tamper-evidence; it does not establish that depicted content is true or that a source is legally licensed.
- [MEDit-Bench](https://ogatakatsuya.github.io/medit-bench/) demonstrates that the same source footage can support different valid edits under different messages; analysis and selected moments must therefore bind to the exact GoalContract/EditIntent.
