# Second-Round Architecture Revision — Video Intelligence, Media Lineage, and Trusted Rendering

> **Status: PROPOSED second-round revision package — final architecture review pending.** This document records the targeted revisions made against the existing unified architecture. It does not replace the approved one-Kernel/two-domain product direction, approve detailed contracts, authorize Runtime work, select a production stack, or claim empirical validation.

## 1. Review scope and baseline

This revision starts from the existing 33-commit branch baseline:

- Repository: wwxst/agent-Kernel
- Branch: design/autonomous-coding-agent
- Baseline HEAD at review start: a22dfb603eb1102e7dbf5a5ef86286c56b14b45c
- Baseline relation to main: 33 commits ahead, 0 behind.

The baseline already established:

- one shared Agent Kernel and independent Coding/Video Domain Intelligence and Domain Execution;
- immutable GoalContract/PlanRevision envelopes and per-Task DomainBinding/Workflow Profile;
- RepositoryModel and MediaProjectModel as separate domain projections;
- immutable TimelineRevision with rational time/PTS;
- RenderPlan/RenderJob over ToolInvocation, Trusted ToolHost, budgets, cancellation, UNKNOWN, and recovery;
- criterion-level VerificationReport and Completion Guard;
- separate Coding, Video, and shared Kernel evaluation protocols;
- retained Coding research and source-grounded Pi/Codex/DeepSeek Harness/Claude Agent SDK reference comparisons.

The second round does not re-author the Coding Agent design or redo the shared reference comparison. It preserves the existing Coding research and original evidence documents unchanged.

### 1.1 Existing gap diagnosis

The first Video design described ingest/probe → analysis → timeline → FFmpeg render → verification, but did not sufficiently specify:

1. how message intent becomes a narrative rather than a set of salient clips;
2. how query relevance, salience, context value, coverage, redundancy, and sequence value are balanced;
3. how a beat/shot sequence preserves factual chronology, qualifications, speaker meaning, and context;
4. how pacing, visual/semantic continuity, dialogue, ambience, music, and cut timing interact;
5. how MediaProject, MediaAnalysis, MediaProjectModel, and TimelineRevision versions relate and how evidence is inherited safely;
6. how FFmpeg's own protocol, demuxer, filtergraph, path, and nested-resource surfaces are constrained;
7. how RenderJob state relates to Kernel ToolInvocation and Host Ledger facts through cancellation, UNKNOWN, crash, and publication;
8. how final output intervals map back to immutable source ingredients and how independent acceptance differs from editor self-review;
9. which capabilities are core editing, enhanced editorial features, and post-production/platform adaptation.

## 2. Second-round proposed architecture decisions

| ID | Proposed revision | Architectural outcome | Status |
| --- | --- | --- | --- |
| S2-01 | Deepen Video Domain Intelligence | Hierarchical media understanding; message-conditioned moment selection; NarrativePlan; pacing/continuity/A-V reasoning; bounded inspect/critique/revise loop | PROPOSED |
| S2-02 | Define MediaProject data contract | Immutable ProjectSnapshot generations, immutable MediaAnalysis runs, versioned MediaProjectModel projections, exact stream/timebase provenance | PROPOSED |
| S2-03 | Define evidence inheritance | Explicit EvidenceCarryForward with digest, stream, time mapping, criterion compatibility, freshness result, and validator | PROPOSED |
| S2-04 | Secure FFmpeg RenderPlan | Typed compiler/AST, protocol/format/filter allowlists, read-only inputs, staging-only writes, no egress, Host isolation/resource controls | PROPOSED; enforcement UNVERIFIED |
| S2-05 | Clarify RenderJob authority | Kernel owns invocation/admission/cancel/fencing; Host Ledger owns physical process/output facts; RenderJob is a projection across separate state dimensions | PROPOSED; runtime UNVERIFIED |
| S2-06 | Strengthen final acceptance | Technical/content/perceptual/provenance/human disposition separated; output-interval-to-source-interval lineage | PROPOSED; verifier quality UNVERIFIED |
| S2-07 | Separate capability phases | ADP-01 approves the revised bounded core automatic-editing capability; enhanced editorial capabilities and post-production/platform adaptation remain separate | ADP-01 scope REVISED/APPROVED; detailed operation contracts PROPOSED |
| S2-08 | Preserve cross-domain boundary | Shared generic lifecycle/authority/resource/artifact/evidence envelopes; domain-specific plan granularity, cognition, tool semantics, and verifier algorithms | PROPOSED |

ADP-01's product capability boundary was separately REVISED/APPROVED by the owner on 2026-11-02 and is recorded in the [Decision Log](decision-log.md). This does not approve the detailed S2 contracts: S2-01 through S2-06 and S2-08 remain proposals, and the exact typed operation registry remains OPEN. Owner disposition is required for each remaining decision.

## 3. Revised Video intelligence architecture

The proposed cognitive artifact chain is:

**UserIntent / GoalContract → MediaProject snapshot → MediaAnalysis evidence → MediaProjectModel projection → NarrativePlan → TimelineRevision → RenderPlan → RenderJob → independent VerificationReport.**

### 3.1 Content understanding and candidate selection

Media understanding is hierarchical across asset/stream, scene, shot, moment, and frame/audio sample. Every claim is bound to exact source digest, stream, PTS/timebase, analysis run/version/configuration, raw evidence, coverage, and uncertainty.

Candidate moments are assessed separately for goal/beat relevance, message utility, salience, evidence strength, coverage, redundancy, continuity, technical usability, audio value, duration cost, and exclusion/risk. Hard constraints are applied before soft ranking. The planner retains dimension-level rationale and alternatives rather than relying on one unexplained score.

### 3.2 NarrativePlan

NarrativePlan is a proposed immutable Video-domain artifact between MediaProjectModel and TimelineRevision. It records message, optional genre-appropriate beats, dependencies/order, selected and alternative moments, source evidence, context requirements, duration ranges, pacing intent, continuity/audio constraints, and unresolved ambiguity.

It is not a universal beginning-middle-end template, not an executable timeline, and not a separate agent. The single Video Domain Intelligence coordinator creates and revises it.

### 3.3 Pacing, continuity, and audiovisual coordination

The planner distinguishes cut tempo, narrative pacing, visual rhythm, audio rhythm, and audiovisual synchronization. It considers action/eyeline/screen direction/shot scale/location/time continuity, dialogue boundaries, ambience bridges, deliberate silence, and music alignment only where authorized and useful.

It preserves factual/causal meaning, chronology requirements, quote qualifications, and speaker context. Intentional discontinuity is permitted when the narrative rationale is explicit and consistent with the accepted goal.

### 3.4 Iterative editing

The loop is bounded:

1. create candidate NarrativePlan/TimelineRevision;
2. validate structural and evidence bindings;
3. render only under current authorization/budget;
4. inspect the actual output independently;
5. classify findings by technical/content/narrative/pacing/continuity/A-V/provenance dimension;
6. map findings to affected beats/clips/criteria;
7. create new EditIntent and immutable revisions with an explicit change set;
8. carry forward unaffected evidence only after freshness checks;
9. rerender/reverify affected obligations and preserve all prior artifacts.

Budget, repair reserve, authorization, and explicit stop conditions bound the loop. A model self-score cannot authorize unlimited revision or publication.

## 4. MediaProject and evidence model

The new [MediaProject contract](../contracts/media-project.md) defines:

- **MediaProject:** stable project identity and append-only manifest history.
- **ProjectSnapshot:** immutable project generation and manifest digest.
- **MediaAsset:** immutable source or derived artifact with content digest and lineage.
- **MediaAnalysis:** immutable bounded analysis run with exact inputs, coverage, tool/model/config version, raw evidence, claims, warnings, and UNKNOWN/Partial status.
- **MediaProjectModel:** immutable Context Engine projection bound to one ProjectSnapshot and exact analysis/evidence set.
- **EvidenceCarryForward:** explicit record that an unchanged claim remains compatible for a new beat/clip/criterion.

A new project generation does not automatically invalidate evidence about an unchanged source asset. A new analysis version does not rewrite old claims. Parent revision linkage alone never proves evidence freshness. Source digest, stream identity, timebase, proxy mapping, analysis method/scope, and criterion meaning determine reuse.

## 5. FFmpeg RenderPlan security and execution authority

The new [RenderPlan security contract](../contracts/render-plan-security.md) requires:

- only immutable locally staged input artifacts in the initial render profile;
- deny-by-default per-input protocol policy and a reviewed format/stream allowlist;
- no remote URL/redirect/DNS/network access during rendering;
- read-only source/sidecar bindings, isolated writable staging, and no final artifact path access;
- trusted path resolution, digest pinning, symlink/hardlink/path traversal/race protection;
- typed timeline operations compiled to a validated filtergraph AST and canonical argv array;
- a versioned filter allowlist; no raw model filtergraph, arbitrary script/path, or unbounded expression;
- no egress, credentials, host sockets, or unrelated project/system mounts;
- unprivileged process isolation, descendant containment, enforceable CPU/memory/process/wall-time/disk/output limits, and process/handle convergence;
- unique staging, independent verification, immutable final ArtifactRef, and recoverable publication.

Linux namespaces/cgroup v2/seccomp and Windows Job Objects are candidate platform primitives only. No Host OS or sandbox stack is selected. A required hard control that cannot be enforced causes admission to fail closed.

### 5.1 RenderJob and state authority

The revised [RenderJob contract](../contracts/render-job.md) distinguishes:

- Kernel Invocation state — admission, authorization, budget, cancellation intent, fencing, legal transitions, and reconciled outcome;
- Host execution state — durable launch intent, process identity, exit/signal, descendants, resource facts, output identity/digest, convergence, and receipt;
- domain verification state — technical/content/perceptual/human findings;
- artifact publication state — quarantine, verified-ready, finalized, published, or rejected.

RenderJob is a correlation/projection record, not a second state machine authority. UNKNOWN blocks replay and conflicting publication. Cancellation is complete only after Host proves descendant and writable-handle convergence. A retry is a new invocation and unique staging target. A stale/superseded/cancelled/partial output cannot replace the current deliverable.

## 6. Final video acceptance and source provenance

The revised completion and render contracts separate:

1. **Technical validity:** container/streams/profile, decode, duration/timing, audio/video sync, integrity, digest, Host receipt.
2. **Editorial/content fulfillment:** required/excluded content, message/beat coverage, order/context, factual/causal integrity, and actual output match.
3. **Perceptual quality:** continuity, pacing, audiovisual coherence, readability, and artifacts.
4. **Source provenance:** each output interval maps to immutable source asset/stream/range and transformation nodes, or to a declared generated/external ingredient.
5. **Human/external acceptance:** required disposition is bound to the exact artifact version and criterion.

A transition may map one output interval to multiple source intervals. A generated overlay/music/voice or external ingredient is declared, not misrepresented as source footage. Content provenance documents lineage and edit history; it does not establish real-world truth or legal usage rights.

## 7. Capability scope matrix

| Capability class | Examples | First-phase status |
| --- | --- | --- |
| Core automatic-editing foundation | Ingest/probe; task-conditioned basic video/shot analysis; task-relevant highlight/moment selection; basic NarrativePlan and simple sequence/duration planning; trim/reorder/hard cut/concatenate; simple fade/crossfade; limited source-audio preserve/mute/gain/fades; immutable timeline; bounded FFmpeg render; actual-output technical/content checks; natural-language revision and re-delivery | Capability scope REVISED/APPROVED under ADP-01 (2026-11-02); analysis policy and typed operation contracts remain OPEN under ADP-02 and related decisions |
| Enhanced editorial capabilities | Rich cross-scene narrative planning; advanced semantic continuity; music-aware pacing/beat alignment; generated captions/titles; multi-track mixing/ducking; speed ramps; overlays; reframing; color matching; deeper perceptual critique | Roadmap capability, not implied core support |
| Post-production/platform adaptation | Codec/container/bitrate/resolution/aspect/frame-rate/color/audio profile; subtitle mux/sidecar; metadata; thumbnail/cover; platform safe areas/packaging; optional upload/delivery | Separate output-adaptation stage and Output Profile; not story intelligence |
| Professional editor platform | Manual multitrack editor, arbitrary effects graph, collaborative NLE, plugin marketplace, advanced VFX/compositing/color-grading workstation | Deferred / outside first-phase scope |

Existing subtitle pass-through is not caption generation. Editorial framing intent is not the same as platform-specific crop/pad. Output codec/container selection is not a narrative decision. External upload/publication is a separately authorized side effect.

## 8. Cross-domain boundary

The common Kernel continues to own Task/Plan lifecycle, ModelStep/ToolInvocation identity, admission, authorization, budgets, Journal, Host receipt/reconciliation, cancellation/fencing, generic ArtifactRef, provenance envelopes, and Completion Guard.

The domains retain independent:

- context projections and cognitive models (RepositoryModel vs MediaProjectModel);
- GoalContract and PlanStep payload vocabularies;
- semantic plan quality and plan-step granularity;
- tool capability sets and operation semantics;
- evidence vocabularies, freshness rules, and repair loops;
- verification algorithms and quality metrics.

Coding may use fine-grained inspect/edit/test/debug steps. Video may use coarser analysis/story/timeline/render/verify steps with multiple separately admitted ToolInvocations under one PlanStep. The Kernel does not force equal step size, a universal semantic DAG vocabulary, or one verifier algorithm. The existing Coding and shared reference research is preserved.

## 9. Change mapping

| File | Second-round change |
| --- | --- |
| [Video Intelligence](../research/multimedia-domain-architecture/intelligence.md) | New cognitive design for media understanding, candidate selection, NarrativePlan, pacing, continuity, A/V coordination, bounded revision, and capability phases |
| [MediaProject contract](../contracts/media-project.md) | New ProjectSnapshot/MediaAnalysis/MediaProjectModel schema responsibilities, lineage, freshness, and evidence inheritance |
| [Media Timeline](../contracts/media-timeline.md) | Bind ProjectSnapshot, projection, analysis claims, NarrativePlan, EvidenceCarryForward, change impact, and source/output mapping |
| [RenderPlan security](../contracts/render-plan-security.md) | New FFmpeg protocol/filesystem/filtergraph/network/process/resource security contract |
| [RenderJob](../contracts/render-job.md) | Clarify Kernel/Host/domain/publication state authority, cancellation, UNKNOWN, crash recovery, and staged publication |
| [Trusted ToolHost](../security/trusted-host.md) | Add media-specific Host filesystem/network/process/resource obligations |
| [Completion](../contracts/completion.md) | Strengthen video provenance bindings, source-to-output map, independent checks, and human disposition |
| [Video domain design](../research/multimedia-domain-architecture/design.md) | Align workflow, scope categories, security, verification, and links |
| [Video evaluation](../research/multimedia-domain-architecture/evaluation.md) | Add narrative, moment selection, continuity, pacing, A/V, revision, provenance, and human evaluation |
| [Domain Workflow](../contracts/domain-workflow.md) | Explicitly separate domain-specific PlanStep granularity from shared invocation admission |
| [Unified domain architecture](../architecture/domain-architecture.md) | Clarify independent cognitive/execution granularity and verifier boundaries |
| [Open decisions](open-decisions.md) | Record unresolved Video/data/security/provenance/evaluation questions |
| [Cross-domain review](cross-domain-architecture-review.md) | Add Video intelligence, data lineage, RenderPlan security, RenderJob authority, provenance, and granularity consistency rows |
| [Roadmap](../development/roadmap.md) | Add second-round Video architecture work and review gate |
| [README/indexes](../../README.md) | Expose new documents and distinguish core/enhanced/adaptation scope |

### 9.1 Explicitly preserved documents

No content change is intended to:

- docs/research/autonomous-coding-agent/design.md
- docs/research/autonomous-coding-agent/evaluation.md
- docs/research/autonomous-coding-agent/failure-model.md
- docs/research/autonomous-coding-agent/reference-review.md
- docs/research/shared-kernel/reference-review.md
- docs/research/shared-kernel/evaluation.md
- docs/decisions/second-round-contract-review.md

The Coding research, Pi/Codex/DeepSeek Harness/Claude Agent SDK comparison, and their original source evidence remain the existing baseline. The new cross-domain prose only clarifies the shared-versus-domain-specific boundary.

## 10. External research basis and limits

The following external sources inform this revision. They are research inputs, not adopted dependencies or proof of project performance.

### 10.1 Video cognition and editing

- [MEDit-Bench (2026 preprint)](https://ogatakatsuya.github.io/medit-bench/) shows that the same long-form source can yield different valid cuts for different editing messages. It includes professional cut references and evaluates temporal alignment alongside preference/human review. Its cut-only scope and benchmark protocol do not cover all editing genres or every perceptual criterion.
- [VideoAgent (EMNLP 2026)](https://aclanthology.org/2026.emnlp-main.949/) highlights long-video understanding, shot planning, and cross-modal retrieval. Its multi-agent architecture is not adopted because D9 remains deferred.
- [QVHighlights (NeurIPS 2021)](https://proceedings.neurips.cc/paper_files/paper/2021/hash/62e0973455fd26eb03e91d5741a4a3bb-Abstract.html) informs query-conditioned moment retrieval and saliency, not full narrative sequencing.
- [TVSum (CVPR 2015)](https://openaccess.thecvf.com/content_cvpr_2015/html/Song_TVSum_Summarizing_Web_2015_CVPR_paper.html) informs shot-level importance research, not message-conditioned editing.

### 10.2 FFmpeg and Host security

- [FFmpeg Protocols](https://ffmpeg.org/ffmpeg-protocols.html) documents protocol access and protocol_whitelist; the documented default protocol surface requires an explicit policy.
- [FFmpeg Formats](https://ffmpeg.org/ffmpeg-formats.html) documents demuxers and concat safe path behavior; the concat safe option is not a general filesystem sandbox.
- [FFmpeg Filters](https://ffmpeg.org/ffmpeg-filters.html) and [FFmpeg Utilities](https://ffmpeg.org/ffmpeg-utils.html) document filtergraph syntax and multi-layer escaping.
- [Linux seccomp documentation](https://docs.kernel.org/userspace-api/seccomp_filter.html) explicitly says syscall filtering is not a complete sandbox.
- [Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html) documents hierarchical process/resource control.
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) document process grouping, resource accounting, termination, and descendant-process caveats.

### 10.3 Media provenance

- [C2PA Technical Specification](https://spec.c2pa.org/specifications/specifications/2.1/specs/C2PA_Specification.html) provides a reference for ingredient relationships and edit-action provenance. It is not mandatory and does not prove truth, authenticity of depicted events, or legal rights.

## 11. Cross-document consistency checks

The intended meanings after this revision are:

| Invariant | Authoritative document(s) | Consistency rule |
| --- | --- | --- |
| One Kernel / two independent domains | Domain architecture, Domain Workflow | Kernel remains domain-neutral; no universal cognitive model |
| Domain-specific plan granularity | Domain Workflow, Video Intelligence | PlanStep semantics and step size are profile-defined; each ToolInvocation is independently admitted |
| Media project identity | MediaProject contract | ProjectSnapshot is immutable; project head is only a pointer |
| Analysis/projection provenance | MediaProject contract | Every claim resolves to exact MediaAnalysis/raw evidence and input digests |
| Evidence reuse | MediaProject and Media Timeline | Carry-forward is explicit and freshness-checked; parent link alone is insufficient |
| Narrative vs timeline vs render | Video Intelligence, Media Timeline, RenderPlan security | NarrativePlan is semantic; TimelineRevision is temporal/edit structure; RenderPlan is backend execution |
| FFmpeg security | RenderPlan security, Trusted Host | Typed compiler plus OS boundary; protocol allowlist alone is insufficient |
| Render execution authority | RenderJob, Trusted Host | Kernel Journal owns invocation/cancel/fencing; Host Ledger owns physical process facts |
| UNKNOWN and retry | RenderJob, Host, lifecycle | No blind retry; new attempt uses new invocation and unique staging |
| Output publication | RenderJob, RenderPlan security, Completion | Stage → converge → seal → verify → recheck fencing → finalize/publish |
| Video acceptance | Completion, Video evaluation | Technical, content, perceptual, provenance, and human dispositions remain separate |
| Feature scope | Video design, Video Intelligence, README | Core vs enhanced vs platform adaptation remains consistent |

## 12. Remaining OPEN / UNVERIFIED questions

### 12.1 Video intelligence

- What exact NarrativePlan schema and beat vocabulary support diverse genres without overfitting to one narrative template?
- How should candidate-moment ranking combine hard constraints and soft objectives; which weights or Pareto policy are appropriate?
- What evidence coverage is sufficient for semantic claims over long-form/VFR media?
- How should confidence be calibrated, conflicts preserved, and model hallucinations detected?
- What continuity and pacing rubrics are reproducible across genres?
- Which analysis modalities are baseline versus criterion-triggered, and what raw evidence retention/privacy policy is acceptable?

### 12.2 Media data and lineage

- What stable stream identity survives remuxing and metadata changes?
- What proxy time-mapping tolerance is acceptable for frame-accurate source attribution?
- Which analysis method/config changes invalidate derived claims versus merely supersede them?
- What evidence retention, redaction, and deletion policy applies to transcripts, frames, and audio excerpts?
- How are rights/licensing declarations verified and separated from technical provenance?

### 12.3 FFmpeg and Host security

- Which exact container/demuxer/decoder/filter/protocol allowlists are needed for the core operation registry?
- Which FFmpeg build/packaging policy and supported media matrix are acceptable?
- Which supported Host profiles can enforce filesystem, network, process-tree, CPU, memory, disk, and output-size limits?
- How are PID reuse, Host Ledger unavailability, leaked handles, cancellation races, and partial output reconciled on each platform?
- What receipt authentication/key-management mechanism is appropriate?
- Is segmented rendering needed, and if so what independently verifiable segment/merge contract is required?

### 12.4 Verification and product scope

- Which criteria require independent machine evidence, blind human review, external assurance, or explicit user acceptance?
- What source-to-output mapping granularity is required for transitions, overlays, audio beds, and generated assets?
- Which public benchmark components are rights-compatible and representative enough for the project's task set?
- Which enhanced editorial features should be prioritized after the core baseline?
- Which Output Profile targets and platform adapters are required, and is any external upload/publication authorized?

### 12.5 Cross-domain and implementation planning

- What is the minimal shared PlanStep/ToolInvocation relation without forcing identical step granularity?
- Which Host resource dimensions can be enforced consistently across supported environments?
- Should a shared generic artifact manifest expose range/stream semantics without selecting a storage technology?
- What contract spikes are needed before implementation planning can freeze?

No numeric quality/resource thresholds or production technology choices are introduced in this revision. They remain OPEN until supported environments, task sets, and evidence exist.

## 13. Validation record and authorization boundary

- Repository target: **PASS** — all second-round commits are on design/autonomous-coding-agent.
- Baseline relation: **PASS** — 20 commits and 19 Markdown files changed since baseline HEAD a22dfb6.
- Relation to main: **PASS** — branch is 53 commits ahead and 0 behind; no non-Markdown files differ from main.
- Markdown relative-link audit: **PASS** — 18 second-round documents checked; 174 relative link targets resolved with no missing targets. Newly added cross-references in Architecture Decision Proposals were separately checked.
- Coding/shared reference preservation: **PASS** — blob digests for Coding design/evaluation/failure/reference review, Coding README, shared Kernel reference/evaluation, and the prior second-round Coding contract review are unchanged from the baseline.
- Change type: **Markdown documentation only**.
- Runtime, production dependencies, tests, and CI: **NOT MODIFIED**.
- Real-model/media experiments: **NOT RUN**.
- FFmpeg execution, process isolation, cancellation, crash recovery, and publication: **UNVERIFIED**.
- Video cognition and verifier quality: **UNVERIFIED**.
- Coding research/reference evidence: **PRESERVED**.
- Detailed architecture approval: **PENDING**.
- Runtime implementation authorization: **NOT GRANTED**.
- Pull request creation/merge: **NOT PERFORMED**.

The link audit verifies relative target existence, not runtime behavior, schema correctness, or security enforcement. Any passing documentation audit does not imply runtime or security verification.
