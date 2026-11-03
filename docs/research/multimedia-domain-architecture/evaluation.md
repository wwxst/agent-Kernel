# Autonomous Video Editing — Second-Round Evaluation and Experiment Protocol

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03) as the Video evaluation protocol; normative schemas live in docs/contracts/*; no run performed.** No Video runtime, real-model benchmark, media processing, baseline, or quality result is reported. This protocol expands domain-quality evaluation while retaining the shared Kernel safety protocol.

## 1. Evaluation objective

Measure whether Video Editing Intelligence transforms natural-language intent and source media into a technically valid, content-faithful, narratively coherent, temporally continuous, audiovisually coordinated artifact; revises it correctly after feedback; preserves source provenance; and operates within authorized resources.

The primary result is not "FFmpeg returned zero". It is verified fulfillment of accepted editing criteria on the actual rendered output. Technical validity, message fulfillment, perceptual quality, provenance completeness, and user/human acceptance are separate dimensions.

## 2. Task families

Prepare a reproducible task set with pinned source assets/digests, provenance and usage declarations, prompts, GoalContract/EditIntent versions, output constraints, acceptance criteria, temporal reference annotations or reviewer rubrics, and independently authored/hidden checks.

Candidate task families:

1. **Technical ingest and media understanding:** mixed streams, metadata, VFR/CFR, rotation, timebase, audio/subtitle streams, decode defects, and incomplete coverage.
2. **Progressive analysis and escalation:** compare source-wide coverage accounting, per-asset/per-stream/per-modality segment manifests, task-conditioned modality selection, adaptive evidence expansion, unnecessary analysis, unresolved UNKNOWN, and privacy/retention behavior.
3. **Query-conditioned moment retrieval:** select source intervals relevant to a message or requested event, including low-salience but contextually necessary moments.
4. **Highlight ranking and diversity:** distinguish salience, query relevance, narrative utility, coverage, and redundancy.
5. **Message-driven narrative edit:** same source material, different editing messages; produce distinct valid beat sequences without losing factual context.
6. **Long-form story construction:** identify scene/beat structure, preserve prerequisites/context, and avoid unsupported causal or chronological implications.
7. **Multi-source montage:** reconcile source chronology, participants, visual style, and audio across multiple immutable assets.
8. **Interview/talk edit:** remove pauses/redundancy while preserving utterance meaning, speaker turns, qualifications, and audio continuity.
9. **Pacing and rhythm:** change tempo or emotional progression without dropping required content; compare pacing curves and expert judgments.
10. **Visual/semantic continuity:** action, screen direction, eyeline, shot scale, location/time, participant, and intentional discontinuity.
11. **Audiovisual coordination:** dialogue intelligibility, ambience bridges, music/beat alignment where authorized, sample timing, sync, clipping/loudness.
12. **Factual/context integrity:** prevent quote splicing, false cause/effect, omitted caveats, misleading chronology, and unsupported attribution.
13. **Natural-language revision:** apply a follow-up instruction locally, preserve unrelated beats, and correctly invalidate/reuse evidence.
14. **Output adaptation:** apply declared container/codec/resolution/aspect/frame-rate/color/audio/subtitle profiles without confusing format conversion with editorial quality.
15. **Source provenance:** trace each output interval to source asset/stream/range or declared generated/third-party ingredient and transformations.
16. **Recovery and security:** cancellation, Host restart, lost receipt, UNKNOWN, partial output, stale plan, malicious playlist/path/filter input, and resource exhaustion.

Each task declares which dimensions are relevant and the required evidence class. Not every task needs every analysis modality or a human review.

## 3. Experimental controls

Pin and record:

- source asset IDs, content digests, stream metadata, rights/provenance declarations, and source-set version;
- ProjectSnapshot, MediaAnalysis runs, MediaProjectModel projection, NarrativePlan, GoalContract, and EditIntent versions;
- Workflow Profile and tool-definition snapshots;
- model/provider identity and relevant settings if a future run is separately authorized;
- media-analysis tool/model/build versions, sampling/coverage policy, and configuration digests;
- FFmpeg build/version, compiler version, RenderPlan/argv/filtergraph digests, and Output Profile;
- Host environment, OS, CPU/GPU/memory/disk limits, filesystem/network isolation, and resource policy;
- timeline/render artifact digests, source-to-output provenance map, and staging/publication records;
- verifier version, evidence input manifest, independence class, and human-review rubric;
- task-set version, genre/difficulty strata, ambiguity/contextfulness, repeat controls, and reference annotation provenance.

Compared systems receive the same source media, message, constraints, profile, policy, and resource envelope. Report distributions, disagreements, failures, unknowns, and excluded/unavailable cases—not only the best render. Separate model-judge results from independent human results.

## 4. Primary Video-domain metrics

| Dimension | Candidate metric/evidence | Interpretation limit |
| --- | --- | --- |
| Goal/criterion fulfillment | Required-criterion pass rate with evidence and exclusions | Does not alone measure aesthetic quality |
| Moment retrieval | Temporal IoU, Recall@K, precision/recall, ranking metrics where annotations support them | A correct interval may still be a poor narrative choice |
| Highlight selection | Salience ranking, query relevance, coverage/diversity, redundancy, reviewer preference | Salience is not message utility |
| Source-range accuracy | Boundary error, temporal overlap, correct stream/asset selection | Does not prove context is sufficient |
| Analysis coverage and evidence gaps | Per-asset/per-stream/per-modality manifest completeness, disjoint interval partition, explicit gaps, Observed/Sampled/NotSampled/NotRequested/Unavailable/DecodeFailed accounting, relevant-event miss rate where annotated | Coverage accounting is not exhaustive semantic recall; one modality cannot satisfy another modality's coverage |
| Progressive analysis efficiency | Analysis cost per source-minute/task, unnecessary modality runs, escalation trigger precision/recall, unresolved UNKNOWN | Compare only on matched task criteria and source sets |
| Timestamp conversion correctness | PTS/timebase round-trip, piecewise stream-to-asset mapping, discontinuity/gap handling, frame/sample boundary inclusion, VFR preservation, audio priming/padding and deterministic rounding | Exact arithmetic does not alone prove rendered A/V quality or perceptual synchronization |
| Narrative structure | Beat coverage, beat order/dependency validity, message transmission, contextual depth | Rubric/judgment required for many genres |
| Factual/context integrity | Unsupported causal links, quote distortion, omitted qualifications, chronology errors, required-context recall | Must be checked against source evidence and task criteria |
| Semantic continuity | Action/eyeline/screen-direction/speaker/location/time continuity; intentional discontinuity rationale | No universal continuity score |
| Pacing | Beat-level duration allocation, cut-tempo curve, reviewer rubric for progression/emotional pacing | Average shot duration is insufficient |
| Audiovisual coordination | Dialogue integrity, audio continuity, A/V sync, beat alignment where intended, loudness/clipping | Beat alignment is not a universal requirement |
| Temporal synchronization | Measured source-to-output timestamp mapping, cumulative drift, A/V offset and sync error against declared profile tolerance | Tolerance remains profile-specific and must be frozen before a run |
| Technical output validity | Probe/decode/container/stream/profile/duration/timing checks | Technical validity is not editorial correctness |
| Revision fidelity | Instruction satisfaction, edit locality, unaffected-region preservation, regression rate | Depends on a declared change-impact oracle |
| Provenance completeness | Output-interval-to-source mapping coverage, digest verification, ingredient lineage | Provenance does not prove factual truth or usage rights |
| Perceptual quality | Blind pairwise preference and rubric scores from independent reviewers | Reviewer variance and task context must be reported |
| Human escalation quality | Necessary clarification/review rate, missed escalation, avoidable interruption | Must not optimize away required human control |
| Resource efficiency | Wall time, CPU/GPU/memory/disk, analysis cost, render retries, cost per verified edit | Compare only under equivalent workload and Host controls |

Do not collapse these into one global scalar. Publish a dimension vector and criterion-level failures. A task may be technically valid but semantically wrong; it may be semantically strong but fail a protected exclusion; it may be traceable but not licensed for use.

### 4.1 Decode-scan, tolerance and content-sampling policy

- **Decode-scan policies.** `full` = every packet and frame decoded and any decode error fails. `sampled` = declared scan units (first keyframe, final two seconds, at least one unit per declared GOP interval, and every interval cited by content evidence) are decoded and any error in a scanned unit fails. `none` is invalid for final acceptance. "Complete decode under the declared policy" means every declared scan unit was decoded and checked; it never implies unscanned regions were verified, and a criterion may not cite them.
- **Tolerance profile.** A versioned object with `duration_delta_ticks`, `frame_count_delta`, `stream_parameter_equality`, `av_offset_ms`, `sample_rate`/`channel_layout` equality, and any loudness tolerance the profile declares. Values are profile data frozen before a run; this document asserts none.
- **Content-evidence sampling minimum.** At least one frame at every clip start/end and at every transition midpoint, one audio window of at least one second at every clip boundary, and the transcript window for any criterion that references speech. A criterion may require more; evidence from unscanned intervals cannot satisfy it.

## 5. Human and independent review protocol

For narrative/perceptual criteria, use a blinded review rubric that separates at least:

- message transmission and instruction fidelity;
- selected moment relevance and contextual sufficiency;
- cut order and story coherence;
- shot/action/speaker continuity;
- narrative pacing and emotional progression;
- audiovisual coherence and dialogue/audio integrity;
- technical artifacts/readability;
- factual integrity and preservation of qualifications.

Reviewers should not be shown the editor's self-assessment before making their independent judgment. Preserve individual ratings, pairwise preferences, disagreement, reviewer qualification, and adjudication outcome. A model-as-judge may assist triage or provide a separate comparison signal, but it cannot replace a required human disposition or independent criterion evidence.

## 6. Evidence classes

For each criterion, declare one or more required classes:

- **Technical machine evidence:** ffprobe metadata, decode results, stream/timing checks, output digest, render receipt.
- **Timeline machine evidence:** schema validation, source-range/timebase checks, duration/track/transition validation, timeline-to-render binding.
- **Raw content evidence:** timestamped sampled frames/audio/transcript segments and source-to-output interval mapping.
- **Independent content evidence:** independently authored reference intervals, hidden checks, human-labelled source moments, or a fresh verifier review of raw evidence.
- **Perceptual/human evidence:** blind reviewer assessment or explicit user acceptance when criterion is subjective and policy requires it.
- **Provenance evidence:** immutable source/derived digests, transformation lineage, output ingredient map, and optional signed provenance credential where required.

A model's own summary, selection score, or aesthetic score cannot stand in for machine evidence or required human disposition. An inconclusive claim remains Inconclusive/UNKNOWN.

**Pass authority.** A criterion verdict `Pass` is written only in the `VerificationReport` produced from the domain verifier's `VerificationProposal` and accepted by the deterministic Completion Guard. The planner/editor that produced the timeline may not write a verdict for a criterion it implemented; a model review yields a disposition (`NoBlockingFinding|BlockingFinding|InsufficientEvidence|HumanReviewRequired`), never a verdict. The proposal carries verdicts plus evidence references, and the Guard independently checks presence, independence class, freshness and human disposition ([Kernel data model](../../contracts/kernel-data-model.md) §3.11, [Completion](../../contracts/completion.md)).

## 7. Shared Kernel metrics

Shared Kernel metrics remain cross-domain and are defined in the [Shared Agent Kernel evaluation protocol](../shared-kernel/evaluation.md). Video runs report the same Kernel metrics alongside domain metrics; they do not redefine them.

A high-severity unauthorized execution, false completion, unresolved UNKNOWN replay, cancellation leak, or publication of an unverified/stale artifact remains a shared safety blocker.

## 8. Ablation and diagnostic plan

After a stable baseline exists, vary one capability at a time:

- metadata-only probing versus source-wide, per-stream/per-modality coverage accounting plus task-conditioned progressive analysis;
- coarse global coverage labels versus disjoint interval manifests with explicit NotRequested, NotSampled, Unavailable, and DecodeFailed states;
- fixed sparse sampling versus adaptive evidence expansion triggered by criterion-level gaps;
- uniform frame sampling versus task-conditioned temporal coverage;
- single-origin stream normalization versus explicit piecewise stream-to-asset clock mappings across PTS discontinuities and audio sample offsets;
- generic salience ranking versus query/message-conditioned moment retrieval;
- single-score ranking versus dimension-level multi-objective selection;
- no explicit NarrativePlan versus beat-structured planning;
- chronology-only versus intent-aware but factuality-constrained ordering;
- no continuity model versus explicit visual/semantic/audio continuity checks;
- no pacing curve versus beat-level duration/rhythm planning;
- visual-only planning versus audio/transcript-aware planning;
- no evidence carry-forward versus explicit freshness-checked carry-forward;
- one-pass editing versus bounded inspect/critique/revise loop;
- **one primary controller** with simplified edit/render/inspect decisions versus that **same controller** with richer Strategic/Tactical/Assurance decision modes, at equal Host, tool, model and evidence budgets;
- stable protected input/project snapshot with isolated render outputs versus broad output-inclusive mutable project hashing;
- editor self-assessment versus fresh independent verifier/human review;
- timeline compiler versus direct command construction (direct command construction is a controlled research comparison only, never production authority);
- unrestricted versus allowlisted protocol/filter/format policy in controlled security tests;
- naive render retry versus Host Ledger reconciliation and unique output staging.

Do not introduce Multi-Agent / D9 as a baseline dependency. Internal phases of one task-level Video Orchestration coordinator are not separate agents or authorities.

## 9. Research datasets and benchmark applicability

Existing datasets are evidence about component tasks, not automatically a complete product benchmark:

- **MEDit-Bench (2026 preprint):** message-conditioned long-form editing with multiple professional edits for the same source/message pair. It is directly relevant to narrative/message fidelity and human comparison, but its dataset scale, genres, cut-only focus, and judge protocol do not cover all project requirements.
- **QVHighlights (NeurIPS 2021):** natural-language query-conditioned moment retrieval and highlight saliency. It is relevant to candidate interval retrieval, not full story construction or final render quality.
- **TVSum (CVPR 2015):** shot-level importance/summarization. It is relevant to salience and redundancy research, not message-driven narrative editing.
- **VideoAgent (EMNLP 2026):** recent work on long-video understanding, shot planning, and cross-modal retrieval. Its multi-agent orchestration is not adopted because D9 remains deferred.

The final task set may combine newly authored, rights-cleared tasks with selected public component benchmarks after licensing, provenance, task compatibility, and evaluation-oracle review. No dataset is selected or downloaded in this architecture round.

## 10. Staged evaluation gates

| Stage | Required output | Gate |
| --- | --- | --- |
| Architecture design | Metric definitions, task families, safety floors, evidence classes, and experiment method | Owner review; no runtime result implied |
| Task-set preparation | Pinned/rights-cleared assets, task prompts, criteria, difficulty strata, reference intervals/rubric, hidden checks | Freeze task-set and rubric before comparisons |
| Baseline | Declared reference system or first controlled implementation on frozen set | Separate explicit authorization; publish distributions and failure taxonomy |
| Target confirmation | Proposed quality/safety thresholds based on measured baseline and intended risk | Explicit owner approval; do not backfill thresholds |
| Formal evaluation | Repeated comparisons, ablations, recovery/fault-injection and regression runs | Publish all outcomes and confidence limits |

Architecture-level evaluation may be reviewed before a benchmark baseline exists. Runtime and real-model baseline runs require separate explicit authorization of provider, assets, workspace isolation, tools, network, budgets, and stop conditions. A fixture-only renderer/provider test is not a real-model editing-quality baseline.

## 11. Current status

- Video Editing runtime: **NOT STARTED**.
- Media task set: **NOT BUILT**.
- Real-model/media experiments in this round: **NOT RUN**.
- Baseline and target thresholds: **NOT RUN / OPEN**.
- Media quality, provenance verifier, and independent-review effectiveness: **UNVERIFIED**.

## 12. Research references

- [MEDit-Bench: Message-Driven Narrative Video Editing](https://ogatakatsuya.github.io/medit-bench/) — 2026 preprint; multiple editing messages and professional edit references.
- [QVHighlights](https://proceedings.neurips.cc/paper_files/paper/2021/hash/62e0973455fd26eb03e91d5741a4a3bb-Abstract.html) — query-conditioned moment retrieval and highlight saliency.
- [TVSum](https://openaccess.thecvf.com/content_cvpr_2015/html/Song_TVSum_Summarizing_Web_2015_CVPR_paper.html) — shot-level importance and summarization.
- [VideoAgent](https://aclanthology.org/2026.emnlp-main.949/) — EMNLP 2026 research on video understanding/editing; its multi-agent design is not adopted.

## 13. Executable Video first-slice performance and correctness fixtures (design; NOT RUN)

**Pinned fixtures:** `V-01` multi-source short-form edit from natural-language request to rendered artifact; `V-02` progressive analysis with a known low-salience required moment; `V-03` VFR/PTS discontinuity and audio-sync conversion; `V-04` cancelled render with writable descendant; `V-05` crash/lost receipt with complete staging; `V-06` malformed/prohibited FFmpeg filter/input reference; `V-07` technically valid but context-misleading edit; `V-08` local revision invalidating only one beat; `V-09` insufficient GPU/disk budget with partial output; `V-10` different message on identical source footage; `V-11` cached probe reuse after an identical-size source swap; `V-12` parallel analysis against a pinned render reservation; `V-13` preview passes but the final render fails inspection. Record pinned source digests, rights, reference intervals, requested message, output target, runtime/Host profile and blinded review rubric; all fixture outcomes remain NOT RUN.

**Assertions:** V-01 outputs exact signed render/source-to-output provenance, technically validated actual content and expected message/beat criteria; V-02 detects/escalates missing required content (never equates Unsampled with negative finding); V-03 respects declared rounding/audio sample limits; V-04/05 preserve one-use non-idempotent render and no premature publication; V-06 fails before shell/FFmpeg execution; V-07 blocks false semantic completion even with technical PASS; V-08 reuses only independent unchanged evidence; V-09 never exceeds enforceable resource admission and quarantines incomplete output; V-10 changes content selection/narrative according to user message, not a universal template; V-11 must miss the cache and mark prior evidence stale after the content digest changes (never reuse a quick fingerprint as equality); V-12 must queue or reject analysis that would exceed the render reservation, with no silent resource sharing; V-13 must fail final acceptance even though the preview passed, and the preview must never be accepted as final-output evidence.

**Controlled comparisons:** (A) exhaustive source processing + mandatory preview + fixed Verifier versus (B) task-conditioned progressive analysis + selective preview + profile-required actual-output inspection; separate ablations for metadata caching, bounded media workers and render reuse. Both share identical sources/rights, criteria, human review panel, Host resources, model/analysis pricing profile and duration budget. Record independent blinded reviewer agreement, temporal source-range precision/recall, story/context errors, actual output decode/profile/sync validity, incorrect completion, p50/p95 including queued render, GPU/CPU time, I/O/output bytes, model/input-output/audio-video Tokens, render retries/UNKNOWN, tool wait and total charge. Report failures and missing evidence, not only successful videos. Use [Shared evaluation §9](../shared-kernel/evaluation.md) safety/noninferiority gates. No empirical result or numeric improvement is claimed here.
