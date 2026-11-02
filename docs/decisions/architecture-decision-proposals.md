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
| ADP-02 | Media analysis | Task-conditioned, progressive analysis with provenance | Confirm default analysis policy |
| ADP-03 | Workflow Profile lifecycle | Immutable per accepted plan; revoke future admission immediately; migrate only through explicit safe cutover | Confirm revocation/migration semantics |
| ADP-04 | Artifact and media storage | Generic immutable artifact manifest plus opaque blob/object payload; journal stores references, not large media bytes | Confirm logical contract |
| ADP-05 | Media time | Integer source PTS and rational time bases; exact conversion with explicit rounding; audio sample positions remain explicit | Confirm temporal contract |
| ADP-06 | Output profiles | Versioned profile registry; one compatibility profile candidate; no silent defaults | Confirm target profile values |
| ADP-07 | Verification and human review | Criterion-level evidence classes; independent content review; human disposition for explicitly subjective/high-impact criteria | Confirm review policy |
| ADP-08 | Host and resource policy | Hard-enforce only Host-supported dimensions; bounded source/output admission; GPU optional | Confirm supported Host envelope |
| ADP-09 | Cross-domain handoff | Separate Tasks linked by immutable typed ArtifactRefs; no composite cross-domain Task in first phase | Confirm handoff boundary |
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

## 3. ADP-02 — Task-conditioned media analysis

**Recommendation — PROPOSED**

Use progressive, task-conditioned analysis rather than running every expensive analysis on every source by default.

- Always perform source fingerprinting and technical probing needed to establish asset/stream identity, duration, time bases, and decode warnings.
- Generate a basic temporal index (for example, shot-boundary candidates and representative frames) when it helps source navigation and selection.
- Run speech transcription only when dialogue, spoken-content requirements, or captions are relevant to the accepted criteria.
- Run richer visual semantic analysis only for criteria that require locating or distinguishing visual events.
- Run audio-event/loudness analysis only when the user intent or output policy requires it.
- Preserve every derived claim's source digest, stream, time range, analysis version, raw evidence reference, and freshness status.

**Alternatives**

- Always run a complete visual/audio/transcription pipeline.
- Use only technical metadata and leave all semantic selection to the user.

**Risks and trade-offs**

- Progressive analysis reduces unnecessary cost and latency but can miss a cue that was not anticipated during intake.
- Full analysis improves broad recall but increases cost, data exposure, and the chance that noisy model output is mistaken for evidence.
- A detector's shot boundary or transcript does not prove semantic scene content.

**Acceptance criteria**

- GoalContract criteria determine which analysis capabilities are required.
- The planner can request additional analysis when current evidence is insufficient and records why it is needed.
- UNKNOWN is preserved when evidence is weak; the system does not infer missing events from a summary alone.
- Evaluation reports analysis cost, coverage, false detections, and downstream source-range accuracy separately.

## 4. ADP-03 — Workflow Profile acceptance, revocation, and migration

**Recommendation — PROPOSED**

Treat every Workflow Profile as an immutable, content-digested policy/configuration snapshot. Keep the active DomainBinding stable for each accepted plan version.

1. A new Task is created with one explicit DomainBinding and Workflow Profile version.
2. An accepted GoalContract/PlanRevision pins that binding; no in-place mutation of the profile or its tool/schema/resource/evidence sets is allowed.
3. A same-domain profile update creates a candidate DomainBinding and requires compatibility/impact analysis.
4. Activation occurs only through the existing freeze → drain/reconcile → refresh → validate → plan-switch barrier. The new binding becomes active with a new accepted PlanRevision.
5. If the change affects scope, tool capabilities, external effects, resource authority, output obligations, or criterion evidence, require explicit user confirmation unless an exact immutable prior authorization covers that change.
6. Revocation immediately blocks **new** admissions under the revoked profile. Already admitted operations are reconciled under their exact invocation/fencing identity; policy determines whether they drain or receive a cancellation request. A cancellation request is not proof of process convergence.
7. If an in-flight operation is UNKNOWN, do not migrate around it or blindly replay it. Preserve the hold until Host evidence proves a safe cutover.
8. A domain change (Coding ↔ Video) is never a profile migration; it requires a new Task and an explicit artifact handoff.

**Alternatives**

- Pin the Workflow Profile for the entire Task lifetime, with all changes deferred to a new Task.
- Automatically migrate active Tasks whenever a profile version is published.

**Risks and trade-offs**

- Full Task-lifetime pinning is simple but can leave long-running Tasks on a revoked or unusable profile.
- Automatic migration is operationally convenient but can silently change capabilities, budgets, or verification obligations.
- Revocation during a running Host operation cannot erase physical side effects already admitted; receipt reconciliation remains mandatory.

**Acceptance criteria**

- Profile versions and manifests are immutable and content-digested.
- Every ModelStep, PlanRevision, ToolInvocation, artifact, and VerificationReport binds the exact DomainBinding/profile version it used.
- Tests cover revocation before dispatch, after admission, during execution, during cancellation, and while an invocation is UNKNOWN.
- No new invocation is admitted under a revoked profile.
- A migrated Task has a new binding and accepted plan; old evidence is reused only when its full freshness and compatibility conditions pass.
- Cross-domain profile migration is rejected.

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

**Recommendation — PROPOSED**

Retain the current integer/rational time model and make conversion rules explicit at every boundary.

- Video source ranges use integer PTS plus the selected stream's exact rational time base; ranges remain end-exclusive.
- Variable-frame-rate source PTS are preserved. Do not reinterpret VFR media as constant-frame-rate by assumption.
- Audio ranges carry the selected audio stream identity and integer sample positions/sample rate (and stream time base where needed).
- Each TimelineRevision declares an explicit rational timeline time base. Do not assume one global fixed timeline rate for every project.
- Keep conversions in exact rational/integer arithmetic as long as possible. Every conversion to frame ticks, output timestamps, or audio samples records its source basis, target basis, and deterministic rounding rule.
- Resampling, frame-rate conversion, timestamp normalization, and audio sample-rate conversion are explicit RenderPlan operations with provenance.
- Preserve non-zero start PTS, stream offsets, and audio/video alignment evidence.

**Alternatives**

- Normalize all sources to one constant frame rate and sample rate during ingest.
- Use floating-point seconds as the canonical timeline coordinate.

**Risks and trade-offs**

- Preserving native time bases increases compiler and validation complexity.
- Normalization simplifies later rendering but introduces a derived media artifact, processing cost, and possible quality loss.
- Ambiguous rounding can create off-by-one-frame edits, audio drift, or incorrect clip boundaries.

**Acceptance criteria**

- The contract specifies canonical serialization and allowed rational-number normalization.
- Conversion rules are deterministic, versioned, and included in the RenderPlan digest.
- Fixtures cover CFR and VFR, non-zero start PTS, differing stream time bases, 44.1/48 kHz audio, offsets, resampling, and end-exclusive boundaries.
- Tests assert frame/sample boundary behavior and audio/video sync within a declared profile tolerance.
- No floating-point value is used as the sole canonical source of frame-accurate timing.

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

## 10. ADP-09 — Cross-domain artifact handoff

**Recommendation — PROPOSED**

Keep one Task bound to one domain. Represent a Coding-to-Video or Video-to-Coding handoff as two separately authorized Tasks connected by immutable, typed ArtifactRefs.

- The producing Task publishes an immutable artifact with digest, schema/type, provenance, access classification, and retention metadata.
- The consuming Task receives an explicit ArtifactRef and validates type, schema, integrity, access policy, and suitability within its own Workflow Profile.
- The consumer may read the artifact through an authorized capability but does not load the producer's private domain projection or inherit its permissions.
- The relationship between Tasks is metadata (for example, derived-from/consumes), not a shared Task aggregate or shared execution authority.
- Cross-domain transfer is explicit and user-authorized where it changes scope, exposes data, or causes external effects.

**Alternatives**

- Introduce a composite cross-domain Task with multiple active DomainBindings.
- Share a common context projection containing both RepositoryModel and MediaProjectModel.

**Risks and trade-offs**

- Separate Tasks add handoff and orchestration overhead.
- A composite Task risks ambiguous authority, mixed evidence semantics, and profile/capability inheritance.
- Artifact-only handoff may be insufficient for a future tightly coupled workflow, which should be designed separately rather than weakening the initial isolation boundary.

**Acceptance criteria**

- A Task cannot activate two domain bindings.
- A consumer validates an ArtifactRef against its own schema and access policy.
- Producer capabilities, approvals, and context are not inherited by the consumer.
- Handoff lineage and user authorization are auditable.
- Composite cross-domain autonomous workflows remain deferred until separately designed and approved.

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
| ADP-02 | Accept progressive, task-conditioned analysis | OPEN |
| ADP-03 | Accept immutable profile versions and explicit safe cutover/revocation | OPEN |
| ADP-04 | Accept generic manifest + opaque immutable payload contract | OPEN |
| ADP-05 | Accept integer PTS/rational time and explicit conversion rules | OPEN |
| ADP-06 | Accept profile registry; decide compatibility-profile values separately | OPEN |
| ADP-07 | Accept criterion-level evidence classes and risk-based human review | OPEN |
| ADP-08 | Accept Host-declared enforcement capability; GPU optional | OPEN |
| ADP-09 | Accept separate Tasks and explicit ArtifactRef handoff | OPEN |
| ADP-10 | Accept lightweight preview/approval surface; no full editor | OPEN |
| ADP-11 | Accept staged implementation sequence and separate authorization gates | OPEN |

ADP-01 is the only item with an explicit owner disposition so far: REVISED, approved in revised form and recorded in the Decision Log. ADP-02 through ADP-11 remain OPEN. Any later partial acceptance must identify the accepted clause and required revision. Approval of ADP-01 does not authorize Runtime implementation, production dependencies, real-model/media experiments, or technology selection.
