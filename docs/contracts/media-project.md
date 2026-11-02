# MediaProject, MediaAnalysis, and MediaProjectModel contract

> **Status: PROPOSED Video-domain data contract.** This document defines logical identity, versioning, projection, and evidence-inheritance rules. It does not select a database, object store, analysis provider, model, or implementation topology. Runtime behavior and freshness enforcement remain UNVERIFIED.

## 1. Purpose and authority

The Video domain needs a persistent project container and a reproducible evidence model that survives multiple Tasks and editing revisions.

- **MediaProject** is the durable Video-domain project identity and manifest lineage.
- **ProjectSnapshot** is an immutable, content-digested view of the project's assets and derived artifacts at one generation.
- **MediaAsset** is an immutable source or derived media artifact.
- **MediaAnalysis** is an immutable record of one bounded analysis run over exact inputs.
- **MediaProjectModel** is a versioned Context Engine projection built from an exact ProjectSnapshot and a declared set of analysis/evidence artifacts.
- **NarrativePlan** is a Video-domain artifact defined in [Video Editing Intelligence](../research/multimedia-domain-architecture/intelligence.md).
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

A ProjectSnapshot records at minimum:

- snapshot_id, media_project_id, project_generation;
- manifest_digest, parent snapshot ID/digest;
- ordered/typed references to included source and derived artifacts;
- event/commit sequence that produced this generation;
- creation provenance and schema version.

The snapshot is immutable. A new ingest, derived proxy, selected analysis set, timeline, or render record may produce a new snapshot only through an explicit project-manifest commit. A snapshot does not imply that all referenced analysis claims are current for every future GoalContract.

### 2.3 MediaAsset and stream identity

A MediaAsset reference includes stable media_asset_id, immutable content digest, byte size, media type, source/derived classification, parent/ingredient references, ingest method/time, source reference, provenance and declared usage/rights metadata where supplied, immutable payload locator, access/retention class, probe result reference, and warnings.

A selected stream is not identified only by a mutable stream index. Bind the stream index together with probed stream identity metadata and source digest: stream type, codec/codec parameters, timebase, start PTS, duration, dimensions or sample properties, channel layout, and relevant metadata digest. A new probe or source digest that changes the stream map requires revalidation.

The original source is never overwritten. A proxy, thumbnail, waveform, extracted audio track, normalized transcode, or other derived artifact receives its own Artifact ID/digest and a transformation record naming exact parent digest(s), tool/build/config, parameters, and source-to-derived time mapping.

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

The proposed default ladder is:

1. **Technical baseline:** every supplied asset receives fingerprinting and technical probing, or an explicit failed/unavailable result.
2. **Coverage accounting:** every source asset receives a coverage manifest. For content-based selection, the selected source set receives a coarse temporal navigation index (such as representative frames and shot-boundary candidates) whose sampling density and gaps are explicit. This accounts for coverage; it does not claim exhaustive semantic understanding of every frame.
3. **Task-conditioned depth:** GoalContract criteria determine whether visual event/scene analysis, OCR, ASR/speaker alignment, audio-event analysis, loudness, or other modalities are required.
4. **Adaptive expansion:** the planner requests denser sampling, neighboring context, another modality, or a rerun only when a criterion has an evidence gap, conflict, low confidence, stale mapping, or boundary/context dependency. The request records its trigger, expected evidence, and budget reservation.

The coverage manifest distinguishes observed, sampled, unsampled, unavailable, and decode-failed intervals; records sampling method/density and the exact source/stream/timebase; and states whether the analysis is complete, partial, failed-known, or outcome-unknown. An unobserved interval is not a negative finding. A whole-source absence claim requires coverage and a method appropriate to that claim. No expensive modality is run by default merely because the source is video.

Analysis expansion is bounded by the Task's current Workflow Profile, permissions, privacy/data-minimization rules, and resource budget. Raw frames, audio, transcripts, and embeddings are retained only under the applicable access/retention policy. A final rendered-output inspection is independent and cannot be replaced by source-analysis claims.

Raw evidence should be retained as immutable, access-controlled artifacts when required for later verification. Privacy, retention, and data-minimization policy governs whether full derived audio/transcript/frame artifacts are stored or only scoped evidence excerpts and digests.

### 3.2 Coverage manifest interval contract

Every supplied source asset has one immutable CoverageManifest bound to the exact ProjectSnapshot/input manifest and source digest. The manifest enumerates all probed streams and the modalities requested or considered for the task. Coverage is scoped independently by asset, stream, modality, and declared source interval; it is never a single project-wide boolean.

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

A status change within an interval requires a segment boundary. A video observation cannot satisfy an audio coverage obligation, nor can a transcript satisfy a visual one. A negative content claim must cite the exact modality-specific intervals, sampling method, resolution, and evidence scope that justify it. NotSampled, NotRequested, Unavailable, and DecodeFailed never count as evidence that an event is absent.

The coarse temporal navigation index spans the selected source set for content-based moment-selection tasks. It records the sampled points and gaps and remains a navigation aid rather than exhaustive semantic evidence. GoalContract criteria choose deep-analysis modalities; no expensive modality is mandatory merely because an asset contains that stream.


## 4. Analysis claims and freshness

A claim is a typed assertion such as speech segment, shot-boundary candidate, object/action observation, scene-context hypothesis, silence interval, or candidate highlight. It binds:

- claim ID and schema/version;
- exact MediaAnalysis ID;
- source asset digest and stream identity;
- source interval in integer PTS/sample positions and rational timebase;
- proxy/derived-media digest and exact source-to-proxy mapping when used;
- raw evidence reference(s);
- method/configuration digest;
- confidence/uncertainty and evidence quality;
- claim status and invalidation conditions.

Claim status is not a universal truth value. At minimum distinguish:

- **Current** — inputs and method/configuration remain compatible for the declared purpose.
- **Stale** — one or more required input/version/mapping bindings no longer match.
- **Superseded** — a newer analysis exists for the same scope; the old claim remains immutable historical evidence.
- **Withdrawn** — the producer or an authorized review explicitly withdrew the claim with a reason.
- **Inconclusive / UNKNOWN** — evidence does not support a reliable conclusion.
- **Partial** — only declared coverage was inspected.

A new model or analysis version does not rewrite prior claims. It creates new records and may mark earlier claims Superseded for future selection. Historical claims remain available to explain why an earlier TimelineRevision was created.

## 5. MediaProjectModel projection

MediaProjectModel is a derived read projection for Video Domain Intelligence. Each immutable projection version binds:

- projection_id, schema version, and projection logic/version;
- MediaProject ID and exact ProjectSnapshot ID/generation/manifest digest;
- exact MediaAnalysis IDs and evidence/claim manifest digest;
- source and derived artifact digests;
- projection build provenance and freshness/invalidation policy;
- normalized entities, scene/shot/moment relations, claim index, uncertainty, and conflicts.

It is not the authoritative store for source bytes or the only copy of evidence. It may denormalize or summarize facts for retrieval, but every material claim resolves to its source claim and raw evidence. The projection cannot grant access to media or authorize a tool call.

A projection built from a new ProjectSnapshot is a new version. Unchanged source-bound claims may be referenced if exact digest, stream, timebase, coverage, analysis method, and task criterion remain valid; the projection still records the snapshot against which it was built.

## 6. Version and lineage rules

The proposed lineage is:

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

A new NarrativePlan or TimelineRevision may carry forward evidence from its parent only by recording an EvidenceCarryForward entry with prior claim/evidence ID and artifact digest; target criterion/beat/clip/range; exact source asset digest, stream identity, PTS/sample interval, and timebase; analysis/proxy/mapping/configuration version; freshness check and compatibility result; reason the evidence is unaffected by the new edit; validator and validation sequence.

Carry-forward is allowed only when underlying source digest, stream identity, time mapping, analysis scope/configuration, and criterion meaning remain compatible. Parent linkage alone does not prove evidence freshness.

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
