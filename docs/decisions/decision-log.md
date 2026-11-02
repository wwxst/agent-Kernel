# Architecture Decision Log

> **Authority:** This file records explicit owner dispositions for Architecture Decision Proposals (ADPs). It is the authoritative status register. A decision approves only the stated scope and does not implicitly approve related contracts, implementation, experiments, technology choices, or deployment.

## 1. Decision status vocabulary

| Status | Meaning |
| --- | --- |
| **ACCEPTED** | The proposal is approved as proposed. |
| **REVISED** | The proposal is approved only in the explicitly revised form recorded in the decision entry. |
| **DEFERRED** | The decision is intentionally postponed; no implementation authority is inferred. |
| **REJECTED** | The proposal is explicitly declined. |
| **OPEN** | No owner decision has been made. |

Every decision entry records the final selection, rationale, alternatives not selected, risks/limitations, acceptance conditions, related contracts/documents, and authorization boundary. An ADP approval is not Runtime implementation authorization.

## 2. Decision register

| ID | Decision | Status | Owner disposition date |
| --- | --- | --- | --- |
| ADP-01 | Video first-phase autonomous editing capability and operation boundary | **REVISED** | 2026-11-02 |
| ADP-02 | Task-conditioned progressive media analysis | OPEN | — |
| ADP-03 | Workflow Profile lifecycle | OPEN | — |
| ADP-04 | Artifact and media storage contract | OPEN | — |
| ADP-05 | Media time, PTS, VFR, and audio sample alignment | OPEN | — |
| ADP-06 | Output profiles and defaults | OPEN | — |
| ADP-07 | Verification and human review | OPEN | — |
| ADP-08 | Host and resource policy | OPEN | — |
| ADP-09 | Cross-domain handoff | OPEN | — |
| ADP-10 | Preview and approval surface | OPEN | — |
| ADP-11 | Implementation order and authorization gates | OPEN | — |

## 3. ADP-01 — Video first-phase autonomous editing capability and operation boundary

- **Status:** REVISED — approved in revised form.
- **Owner disposition date:** 2026-11-02.
- **Owner response:** “REVISED：按本轮提出的完整自主剪辑闭环方案修订后批准。”
- **Supplementary comment:** None.
- **Final selection:** Deliver a genuinely autonomous natural-language video-editing Agent that can complete an end-to-end editing task within a bounded core operation set. The task-level loop is: understand the request → analyze source media → identify/select useful moments → organize a basic narrative → create an immutable timeline revision → render → inspect the actual output → revise from user feedback → re-render/re-verify → deliver.
- **Included first-phase capabilities:**
  1. Ingest, fingerprint, and technically probe user-supplied source media.
  2. Perform task-conditioned basic video/content/shot analysis. Exact analysis modalities, coverage, trigger policy, and model/provider are deferred to ADP-02.
  3. Identify and select task-relevant moments/highlights with evidence, rationale, and uncertainty.
  4. Understand natural-language editing intent and form a basic, genre-flexible NarrativePlan with message, useful beats/moments, necessary context, sequence, and simple duration/pacing allocation.
  5. Support trim, reorder, hard cut, concatenate, simple fade/crossfade, and limited source-audio preserve/mute/per-clip gain/simple fades.
  6. Generate an immutable TimelineRevision and render through a bounded FFmpeg RenderPlan/Trusted ToolHost path.
  7. Inspect the actual rendered artifact against technical and task/content criteria; successful process exit alone is insufficient.
  8. Accept natural-language revisions, create new EditIntent/TimelineRevision versions, re-render, re-verify, and preserve prior versions/evidence.
  9. Deliver the video with relevant timeline, render, verification, and source-provenance artifacts.
- **Autonomy boundary:** Within the accepted GoalContract, authorized source set, bounded operation registry, permissions, and resource envelope, the Agent makes ordinary editing decisions autonomously; the user is not required to specify every clip or tool call. It must clarify or stop safely for material ambiguity, insufficient evidence, unauthorized scope, material factual risk, or exhausted budget.
- **Explicitly deferred:** Generated captions/subtitles and title graphics; music generation/acquisition and external music sourcing; voice synthesis; multi-track audio mixing/ducking and advanced loudness mastering; advanced multi-objective highlight ranking; rich cross-scene narrative reasoning; advanced semantic continuity; music/beat-aware pacing; complex transitions; compositing, motion graphics, keyframes, stabilization, advanced color grading, VFX, arbitrary effects graphs; manual timeline editing/full NLE; professional editor collaboration/plugin marketplace; unrequested external asset acquisition and external upload/publication. Existing subtitle-stream pass-through, if supported, is an output-profile concern rather than caption generation. Codec/container/resolution/aspect/frame-rate/color/audio adaptation is separate under ADP-06.
- **Rationale:** The product outcome is an independently completed and verified edit, not the count of tools or filters exposed. A bounded but coherent operation set exercises understanding, content selection, narrative organization, editing, rendering, inspection, revision, and delivery without prematurely building a professional editor.
- **Alternatives considered and not selected:**
  - A richer first phase with captions/titles, music, multi-track audio, and advanced effects was not selected because it expands content-generation, rights, compiler, and verification obligations before the core loop is established.
  - An ultra-minimal trim/reorder/concatenate-only first phase was not selected because it risks visually crude outputs and under-exercises the editing loop.
  - A full visual editor was not selected because it is outside the natural-language autonomous-editing product boundary.
  - These are not permanent product rejections; future scope requires a separate decision.
- **Risks and limitations:** Basic moment selection/narrative planning may be insufficient for complex genres; weak or conflicting analysis evidence may require clarification/human review; simple transitions still require timebase/audio/render validation; a bounded operation set will not satisfy every professional workflow; technical validity does not prove semantic correctness. Detailed analysis, temporal, output, verification, resource, and interaction contracts remain open under ADP-02 through ADP-10.
- **Acceptance conditions:**
  1. A task starts from a natural-language request and authorized source set without the user specifying every operation.
  2. The Agent produces task-conditioned source understanding and evidence-backed moment selection.
  3. The Agent creates a basic NarrativePlan and derives a valid immutable TimelineRevision.
  4. Core operations have typed representations, validation, deterministic render compilation, and evidence obligations.
  5. Rendering uses the bounded RenderPlan/Trusted ToolHost path; unsupported operations fail closed.
  6. Verification inspects the actual output against technical and task/content criteria.
  7. Follow-up natural-language instructions produce traceable new revisions, with affected obligations re-rendered/re-verified.
  8. Delivery retains source-to-output provenance and required acceptance evidence.
  9. Material ambiguity, insufficient evidence, unauthorized scope, or exhausted budget causes clarification/safe stop rather than false completion.
  10. End-to-end evaluation measures task completion and editing quality, not merely tool success.
- **Related decisions/contracts:** ADP-02 (analysis); ADP-03 (profile authority); ADP-04 (artifacts); ADP-05 (time); ADP-06 (output profiles); ADP-07 (verification); ADP-08 (resources/Host); ADP-09 (handoff); ADP-10 (preview/progress/approval); ADP-11 (implementation sequence); MediaProject, Media Timeline, RenderPlan security, RenderJob, Trusted ToolHost, Completion, Video Intelligence, and Video evaluation.
- **Authorization boundary:** This decision approves the product capability boundary only. It does not authorize Runtime code, production dependencies, real-model/media experiments, external asset acquisition, external publication, a final technology stack, or deployment. Those require separate explicit decisions/authorizations.

## 4. First-batch draft readiness

Detailed first-batch decision and linked contract/evaluation drafts for ADP-02, ADP-03, ADP-05, and ADP-09 have been refined on the architecture branch. The drafts now define modality-scoped coverage-manifest closure, linearizable Host launch/revocation ordering, piecewise stream-to-asset time mapping, and resolver-mediated ScopedReadGrant boundaries. Their Decision Register statuses remain **OPEN** until explicit owner disposition. Draft preparation is not ACCEPTED/REVISED approval and does not authorize Runtime implementation, experiments, technology selection, or deployment.

## 5. Remaining decisions

ADP-02 through ADP-11 remain OPEN. ADP-01 is recorded above as REVISED. Their recommendations and alternatives are maintained in [Architecture Decision Proposals](architecture-decision-proposals.md). No status is inferred from roadmap order, document presence, or dependency relationships.
