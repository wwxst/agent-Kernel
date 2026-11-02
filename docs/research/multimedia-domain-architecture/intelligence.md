# Autonomous Video Editing Intelligence — Second-Round Design

> **Status: MIXED.** The first-phase Video capability boundary is **REVISED/APPROVED under ADP-01 (2026-11-02)**. This document's detailed domain-intelligence architecture remains **PROPOSED**; no model/provider is selected, no Multi-Agent / D9 is introduced, no Runtime behavior is implemented, and no editing quality is claimed as measured.

## 1. Purpose and boundary

Autonomous Video Editing Intelligence must do more than retrieve visually salient clips and serialize them into a timeline. It must infer what the user wants the finished video to communicate, understand which source moments can support that message, construct a coherent sequence, control pacing and audiovisual relationships, and revise the edit from evidence about the rendered result.

The proposed decision chain is:

**UserIntent / GoalContract → MediaProject snapshot → MediaAnalysis evidence → MediaProjectModel projection → NarrativePlan → TimelineRevision → RenderPlan → RenderJob → independent VerificationReport.**

| Artifact | Responsibility | Must not be confused with |
| --- | --- | --- |
| MediaProject / ProjectSnapshot | Persistent project identity and immutable asset/manifest set | Editor session or execution authority |
| MediaAnalysis | One bounded analysis run and its raw outputs/observations | A timeless fact about the source |
| MediaProjectModel | Versioned, provenance-aware projection of project facts, claims, and uncertainty | Media database, model memory, or permission source |
| EditIntent | Append-only user request for an initial or follow-up edit | Mutation of prior intent |
| NarrativePlan | Message, story beats, candidate moments, sequence constraints, and rationale | Executable timeline or FFmpeg graph |
| TimelineRevision | Frame/sample-accurate non-destructive edit decisions | Render command |
| RenderPlan | Deterministic compilation of an accepted timeline into bounded execution operations | Model-authored shell command |
| RenderJob | Domain correlation record for one render attempt | Second execution authority |
| VerificationReport | Criterion-to-evidence result for the actual output | Editor self-assessment |

Video owns semantic interpretation, moment selection, story planning, pacing, continuity judgments, and perceptual verification. Kernel owns authority, legal state transitions, budgets, invocation admission, immutable artifact identity, provenance envelopes, Host receipt reconciliation, and completion gating. Kernel must not score a shot, infer a story beat, or decide whether a cut is aesthetically coherent.

## 2. Cognitive workflow

### 2.1 Intent decomposition

The Video planner turns immutable UserIntent and the accepted GoalContract into explicit editing criteria:

- message or proposition the finished video should convey;
- audience, context, use, tone, and intended emotional effect;
- required events, subjects, actions, statements, and contextual material;
- forbidden, sensitive, misleading, or must-preserve material;
- desired duration/range, format, aspect/orientation, and delivery constraints;
- pacing intent (calm, energetic, escalating, reflective) rather than an unqualified global cut-rate;
- dialogue, natural sound, music, silence, caption, and voice constraints;
- chronology/factuality requirements and whether non-chronological storytelling is allowed;
- user-provided style references and provenance;
- uncertainty, assumptions, and questions that could materially alter the edit.

The planner distinguishes a content request ("include the product demonstration") from a message request ("show why the demonstration solves the problem"). The latter requires contextual and narrative reasoning, not just object detection.

Ask a focused question when two plausible interpretations would produce materially different story, source selection, claims, or user-visible content. Low-risk reversible choices may be disclosed as assumptions only where the active Workflow Profile permits them.

### 2.2 Hierarchical media understanding

Analysis operates at multiple temporal scales rather than treating a video as an unordered set of frames:

1. **Asset and stream:** container, stream identity, codec, duration, timebase, start PTS, frame/sample properties, rotation/display transform, color/audio metadata, and decode warnings.
2. **Scene:** location/context, participants or recurring entities, activity, temporal setting, and scene-level purpose where evidence supports it.
3. **Shot:** boundaries, shot scale/type, camera motion, composition, visible action, and continuity cues.
4. **Moment:** a temporally bounded event, utterance, reaction, reveal, demonstration, or other candidate editorial unit.
5. **Frame/audio sample:** raw, timestamped evidence needed to verify a claim or edit boundary.

Cross-modal observations may include visual entities/actions; scene and shot transitions; representative frames; speech segments, transcript text, language, timestamps, speaker-turn tracks, and alignment quality; music, ambience, silence, impacts and other audio events; on-screen text/OCR where relevant; motion, camera movement, framing, exposure, blur, obstruction; and source chronology/relations when supported.

Every observation or claim carries source asset digest, stream identity, temporal interval, exact timebase/PTS mapping, analysis run, tool/model/config version, raw evidence reference, confidence/uncertainty, and freshness. A shot-boundary detector is not semantic understanding; a transcript is not proof of the corresponding visual event; a visual caption is not proof of chronology or causality. Insufficient evidence remains UNKNOWN.

Analysis is progressive and task-conditioned. Technical probing and source fingerprinting are baseline requirements. Expensive visual, speech, OCR, or audio analysis is requested when needed to satisfy a criterion or resolve material uncertainty. The planner records why each additional analysis is necessary and which claims it is expected to support.

### 2.3 Candidate moment retrieval and highlight selection

The system first generates a candidate set of source intervals. It must not equate visual salience with the best editorial choice.

Candidate generation and ranking consider separate dimensions:

| Dimension | Question |
| --- | --- |
| Goal/beat relevance | Does this moment support an accepted criterion or narrative beat? |
| Message utility | Does it establish, explain, demonstrate, contextualize, challenge, or resolve the intended message? |
| Salience | Is the moment perceptually noticeable or memorable in this source? |
| Evidence strength | Is the interpretation grounded in adequate visual/audio/transcript evidence? |
| Coverage | Does it contribute a required event, perspective, participant, or story stage not already covered? |
| Redundancy | Is it substantially duplicative of a stronger selected moment? |
| Continuity | Can it connect coherently to neighboring moments in time, space, action, speaker, and sound? |
| Technical usability | Is the interval decodable, sufficiently clear, and suitable for the requested output? |
| Audio value | Does its dialogue, ambience, music, or sound event contribute to the edit? |
| Duration cost | How much runtime does it consume, including needed context? |
| Exclusion/risk | Does it violate a protected exclusion, privacy, rights, factuality, or safety constraint? |

Hard constraints (authorization, exclusions, source validity, required content, and protected factual context) are applied before soft ranking. A weighted score may help order candidates, but the system retains dimension-level rationale and uncertainty; it must not hide trade-offs in one unexplained scalar. Where objectives conflict, preserve alternatives or a multi-objective shortlist for the narrative planner.

A useful highlight is query- and goal-conditioned. A visually dramatic shot may be irrelevant to the requested message; a quiet establishing shot or short contextual statement may be essential to make a later event understandable. Selection therefore optimizes both moment value and sequence value.

For every selected interval, preserve rejected alternatives and a compact rationale: which criterion/beat it supports, exact source range, evidence references, uncertainty, and why it was preferred over plausible alternatives.

### 2.4 Narrative planning

NarrativePlan is a proposed immutable Video-domain artifact between MediaProjectModel and TimelineRevision. It records the intended message and an ordered or partially ordered beat structure before exact frame-level editing.

A beat may include a hook, orientation/context, premise/question/objective, demonstration/action/explanation, reaction/consequence/contrast, complication/reveal/turning point, resolution, summary, conclusion, or call to action. These are optional editorial patterns, not a universal template. A montage, interview, tutorial, documentary excerpt, event recap, and product demonstration need different structures.

Each beat binds:

- stable beat ID and role;
- criterion(s) and message element it serves;
- required/optional status and ordering/dependency constraints;
- candidate source moments and selected moment(s);
- supporting analysis claims/evidence;
- minimum context needed to preserve meaning;
- estimated duration range and pacing intent;
- transition/continuity requirements;
- unresolved ambiguity and alternative sequences.

NarrativePlan preserves factual and semantic context. It must not create a false cause/effect relation, reverse a real-world sequence in a way that changes the claim, remove a qualification needed to interpret a quote, splice a statement to imply a different meaning, or imply that a person witnessed an event when the source does not support that inference. Non-chronological presentation is allowed only when consistent with accepted intent and not distorting factual meaning; chronology and presentation order remain separately represented.

NarrativePlan is not a second autonomous agent. It is a typed artifact produced and revised by the single Video Domain Intelligence control loop.

### 2.5 Pacing and editorial optimization

Pacing is perceived progression, not merely average shot duration. The planner reasons over a time-varying pacing curve across story beats and distinguishes:

- **Cut tempo:** frequency and placement of cuts.
- **Narrative pacing:** how quickly information, context, and emotional development unfold.
- **Visual rhythm:** motion, shot scale, composition, and contrast across adjacent shots.
- **Audio rhythm:** speech cadence, pauses, ambience, music, and sound-event timing.
- **Audiovisual synchronization:** whether a cut/action aligns with a meaningful sound/beat when intended.

A candidate timeline accounts for duration budget per beat and whole edit; minimum context before/after an action or statement; shot-duration variation; action completion and motion continuity; screen direction, eyeline, shot scale, camera movement, location, lighting, and time continuity where relevant; dialogue phrase boundaries and natural pauses; audio continuity across picture cuts, ambience beds, and deliberate silence; music beat/phrase alignment only when authorized and useful; and transitions chosen for semantic and temporal purpose rather than decoration.

Continuity is multi-dimensional. A visually discontinuous cut may be narratively valid (intentional contrast); two visually similar shots may be semantically incoherent. The planner records the reason for an intentional discontinuity and the evidence/rationale for continuity-sensitive cuts.

### 2.6 Audiovisual coordination

The edit preserves the relationship between what is seen and heard:

- dialogue meaning and speaker-turn boundaries are not damaged by a visual cut;
- source audio remains aligned to source PTS/sample positions;
- an audio bed or ambience bridge may continue across a picture cut when intent requires continuity;
- music is not presumed authorized merely because a track exists in the source set;
- beat-aligned cuts are optional and subordinate to message, action, and dialogue;
- ducking, mixing, loudness normalization, channel mapping, and fades are typed operations with explicit limits;
- output audio/video synchronization is verified against the actual render.

The planner must not invent speech, attribute an utterance to an unsupported speaker, or replace source audio with generated music/voice unless GoalContract and authorization explicitly permit it.

### 2.7 Timeline synthesis

The selected NarrativePlan is translated into a TimelineRevision containing exact source ranges, tracks, clip order, overlaps, transitions, audio, and output-profile decisions. The timeline compiler accepts only typed operations in the supported operation registry.

- NarrativePlan says what story and sequence should be communicated.
- TimelineRevision says which exact source intervals and typed edit operations realize that sequence.
- RenderPlan says how the validated timeline is compiled into a bounded backend execution plan.

The model cannot insert raw FFmpeg arguments, arbitrary filter names, unbounded expressions, external paths, or network URLs into a TimelineRevision or RenderPlan.

### 2.8 Inspect, critique, and revise

Editing is a bounded evidence-driven loop:

1. Produce a candidate NarrativePlan and TimelineRevision.
2. Run structural timeline validation.
3. Render a preview or final candidate only when policy and budget authorize it.
4. Independently inspect the actual rendered artifact against accepted criteria using raw sampled frames/audio, technical probe/decode results, source lineage, and timeline binding.
5. Classify each finding as technical defect, content mismatch, narrative/context problem, pacing/continuity issue, audiovisual issue, or inconclusive evidence.
6. Map each actionable finding to affected beat, clip, source interval, criterion, and evidence.
7. Create a new EditIntent and immutable NarrativePlan/TimelineRevision revision with a change set; reuse unaffected evidence only after freshness validation.
8. Re-render and re-verify affected obligations; preserve the prior render and report.

A revision is local where possible. It should not reorder or reselect unrelated clips merely because a new instruction changes one section. A change-impact record declares affected beats, clips, analysis claims, output settings, and verification obligations.

The loop is bounded by accepted budget, maximum revision/repair reserve, user-control policy, and explicit stop conditions. It stops when required criteria pass, evidence is inconclusive and needs a user/human decision, a hard budget/authorization boundary is reached, or further changes have no justified expected benefit. No model self-score authorizes unlimited iterations or final publication.

## 3. Evidence and uncertainty rules

- Raw observations, derived claims, model summaries, editorial hypotheses, and verifier findings are different evidence classes.
- Every semantic claim is grounded to exact source asset/stream/time range and raw evidence.
- Confidence is not proof; calibration and error rates remain empirical questions.
- Conflicting evidence is retained with provenance and marked unresolved; the planner does not average away contradictions.
- Evidence that is not temporally aligned or whose proxy/source mapping is uncertain cannot support frame-accurate edits.
- A source claim does not prove the same content is visible/audible in the final output; final-output evidence is required.
- Editor rationale and self-review are not independent verification evidence.
- Human disposition is a separate attributable event bound to the exact artifact version reviewed.

## 4. Domain-specific plan and execution granularity

Video plan steps may be outcome-oriented and relatively coarse (analyze a project, build a narrative, produce a timeline, render, verify). A single Video PlanStep may result in several separately admitted ToolInvocations; a long render attempt may be one ToolInvocation linked to one RenderJob. The Domain Intelligence profile defines these units.

This is not a requirement that Coding use the same step size. Coding may use finer-grained inspect/edit/test/debug steps. Kernel validates only the common PlanStep envelope, dependency graph, references, authority, resource reservations, and legal transitions. It does not normalize semantic granularity across Coding and Video.

A single task-level Orchestration coordinator may perform intent analysis, moment retrieval, story planning, timeline synthesis, and critique as internal phases. This does not introduce Multi-Agent / D9, independent sub-agent authorities, distributed workers, or inherited capabilities.

## 5. Capability phases and scope boundary

| Capability class | Included capabilities | Status / boundary |
| --- | --- | --- |
| **Core automatic-editing foundation** | Ingest/probe user-supplied assets; source fingerprinting; task-conditioned basic video/shot analysis; task-relevant highlight/moment identification and selection; basic NarrativePlan (message, simple beats, context, sequence); simple duration/pacing allocation; trim; reorder; hard cut; concatenate; simple fade/crossfade; preserve/mute/source gain/basic fades; immutable timeline; bounded FFmpeg render; actual-output technical/content checks; natural-language revision, re-render, re-verification, and delivery | Capability scope REVISED/APPROVED under ADP-01 (2026-11-02). Exact analysis policy remains ADP-02 OPEN; typed operation schemas/compiler/evidence contracts remain PROPOSED/OPEN |
| **Enhanced editorial intelligence** | Advanced multi-objective/query-conditioned highlight ranking; rich cross-scene narrative planning; advanced semantic continuity; music-aware pacing and beat/phrase alignment; generated captions/titles; music generation/acquisition; multi-track audio mixing/ducking; voice synthesis; advanced loudness mastering; speed ramps; advanced transitions; overlays; automatic reframing; color matching; richer perceptual critique | Product capability roadmap; not implied by the ADP-01 core slice. Each operation needs typed timeline semantics, authorization, compiler mapping, and verification criteria |
| **Post-production/platform adaptation** | Container/codec/bitrate/resolution; aspect-ratio crop/pad; frame-rate conversion; color/SDR/HDR policy; loudness/channel layout; subtitle mux/sidecar; metadata; thumbnails/covers; platform safe areas and packaging; optional platform-specific delivery/upload | Separate output-adaptation stage and versioned Output Profile. Not story intelligence or a base editing operation. External upload/publication is a separate side effect and remains out of scope unless explicitly authorized |
| **Professional editor platform** | Manual multitrack UI, free-form effects graph, collaborative editing, plugin marketplace, NLE project compatibility, advanced VFX/compositing/color-grading workstation | Deferred / outside first-phase scope |

The same feature must not appear in multiple phases with conflicting meanings. Output aspect ratio and codec selection belong to post-production adaptation; editorial framing intent may be expressed by the planner, but the output adapter determines profile-specific conversion. Generated captions are enhanced editorial capability; preserving an existing subtitle stream is profile-controlled pass-through, not caption generation.

The core capability boundary in this table is the owner-approved revised ADP-01 decision; the detailed intelligence design, analysis policy, and typed execution contracts remain proposed/open. See the [Decision Log](../../decisions/decision-log.md).

## 6. Evaluation implications

Video evaluation separately measures message/criterion fulfillment; candidate-moment retrieval and source-range accuracy; beat coverage/order and context preservation; factual/causal distortion and contradiction; narrative coherence, pacing, continuity, and audiovisual coordination; technical output validity; revision locality/fidelity and regression; source-to-output provenance completeness; human preference/review disposition; and shared Kernel safety/recovery metrics.

No single automated score is sufficient for overall editing quality. Dataset metrics, model-judge preference, expert rubrics, and user acceptance are different evidence types.

See [Video evaluation protocol](evaluation.md), [MediaProject and MediaAnalysis contract](../../contracts/media-project.md), [Media Timeline contract](../../contracts/media-timeline.md), and [RenderPlan security contract](../../contracts/render-plan-security.md).

## 7. Research basis and limits

These external sources inform problem decomposition. They do not select a model/provider or prove that a particular architecture will meet this project's quality bar.

- [MEDit-Bench: A Dataset for Evaluating Message-Driven Narrative Video Editing](https://ogatakatsuya.github.io/medit-bench/) (Ogata et al., 2026 preprint). It pairs long-form source videos with multiple editing messages and multiple professional cut sequences for each message. This supports evaluating edits against the requested message rather than treating one summary as the only ground truth. Temporal-IoU and model-judge measures do not fully establish narrative quality; its human study separately evaluates message transmission, cut order, shot continuity, contextual depth, and narrative pacing.
- [VideoAgent: All-in-One Framework for Video Understanding and Editing](https://aclanthology.org/2026.emnlp-main.949/) (Zhou et al., EMNLP 2026). It highlights long-video understanding, shot planning, and cross-modal retrieval. Its multi-agent orchestration is not adopted: this project retains the approved single-Kernel/two-domain boundary and D9 remains deferred.
- [Detecting Moments and Highlights in Videos via Natural Language Queries](https://proceedings.neurips.cc/paper_files/paper/2021/hash/62e0973455fd26eb03e91d5741a4a3bb-Abstract.html) (Lei et al., NeurIPS 2021; QVHighlights). Query-conditioned moment retrieval and saliency are useful for candidate discovery, but a relevant/high-salience moment is not automatically a coherent story beat.
- [Temporal Sentence Grounding in Videos: A Survey and Future Directions](https://doi.org/10.1109/TPAMI.2023.3258628) (Zhang et al., TPAMI 2023). Temporal grounding connects language claims to intervals in untrimmed videos; source/timebase and evidence freshness remain necessary for frame-accurate use.
- [TVSum: Summarizing Web Videos Using Titles](https://openaccess.thecvf.com/content_cvpr_2015/html/Song_TVSum_Summarizing_Web_2015_CVPR_paper.html) (Song et al., CVPR 2015). Shot-level importance annotations are useful for salience research, but generic summarization is not message-conditioned narrative editing.
- [HierSum: A Global and Local Attention Mechanism for Video Summarization](https://openaccess.thecvf.com/content/CVPR2026W/AI4RWC/html/Beedu_HierSum_A_Global_and_Local_Attention_Mechanism_for_Video_Summarization_CVPRW_2026_paper.html) (CVPR Workshops 2026). Its hierarchical use of local subtitle cues and global instruction context reinforces the need to preserve local and whole-video context; its instructional-video setting limits generalization to all editing genres.

These sources are research inputs, not an adopted benchmark suite, model choice, or implementation dependency.
