# Architecture Decision Log

> **Authority:** This file is the sole status register for Architecture Decision Proposals (ADP) and Architecture Review Board decisions (ARB). A decision approves only the scope it quotes. It never implies implementation, runtime evidence, technology selection or deployment authorization.

## 1. Decision status vocabulary

| Status | Meaning |
| --- | --- |
| **ACCEPTED** | Approved as proposed, for the recorded scope. |
| **ACCEPTED (construction scope)** | Binding on construction documents and code interfaces, but **not** evidence that any runtime behaviour works. No implementation authority is granted. |
| **REVISED** | Approved only in the explicitly revised form recorded in the entry. |
| **DEFERRED** | Intentionally postponed; no implementation authority is inferred. |
| **REJECTED** | Explicitly declined. |
| **OPEN** | No decision has been made. |

Every entry records the selection, rationale, alternatives not selected, risks, acceptance conditions, related documents and authorization boundary.

## 2. Decision register

| ID | Decision | Status | Date |
| --- | --- | --- | --- |
| ADP-01 | Video first-phase autonomous editing capability and operation boundary | **REVISED** | 2026-11-02 |
| ADP-02 | Task-conditioned progressive media analysis | **REVISED** | 2026-11-02 |
| ADP-03 | Workflow Profile lifecycle, revocation and migration | **ACCEPTED (construction scope)** | 2026-11-03 |
| ADP-04 | Generic artifact and media storage contract | **ACCEPTED (construction scope)** | 2026-11-03 |
| ADP-05 | Media time, PTS, VFR and audio alignment | **ACCEPTED (construction scope)** | 2026-11-03 |
| ADP-06 | Output profile registry and defaults | **ACCEPTED (construction scope)** | 2026-11-03 |
| ADP-07 | Criterion-level verification and human review | **ACCEPTED (construction scope)** | 2026-11-03 |
| ADP-08 | Host capability and resource envelope | **ACCEPTED (construction scope)** | 2026-11-03 |
| ADP-09 | Cross-domain artifact handoff | **ACCEPTED (construction scope)** | 2026-11-03 |
| ADP-10 | Minimal preview and approval surface | **ACCEPTED (construction scope)** | 2026-11-03 |
| ADP-11 | Implementation order and gates | **SUPERSEDED by ARB-01 / roadmap** | 2026-11-03 |
| OWNER-01 | Unified one-Kernel/two-domain product direction | **ACCEPTED** | 2026-11-02 |
| ARB-01 | Construction baseline v1, document hierarchy, readiness model and architecture selection | **ACCEPTED (construction scope)** | 2026-11-03 |

### 2.1 OWNER-01 — Unified one-Kernel/two-domain product direction

- **Status:** ACCEPTED (product direction), 2026-11-02.
- **Selection:** one shared Agent Kernel with independent Autonomous Coding and Autonomous Video Editing domain intelligence; separate RepositoryModel and MediaProjectModel; one immutable DomainBinding per Task; Video first phase is natural-language automatic editing, not a full editor.
- **Alternatives rejected:** two separate agent products (duplicate authority/recovery); a Coding-only Kernel with Video as an external tool (no shared lifecycle/recovery); a universal semantic model (collapses domain cognition).
- **Authorization boundary:** product direction only. It does not approve Runtime implementation, technology selection, deployment, or Multi-Agent/D9. The detailed construction contract is ARB-01.
- **Record:** [Unified domain direction](unified-domain-direction.md).

## 3. ADP-01 — Video first-phase autonomous editing capability and operation boundary

- **Status:** REVISED — approved in revised form.
- **Owner disposition date:** 2026-11-02.
- **Owner response:** “REVISED：按本轮提出的完整自主剪辑闭环方案修订后批准。”
- **Final selection:** Deliver a genuinely autonomous natural-language video-editing Agent that completes an end-to-end editing task within a bounded core operation set: understand request → analyze source media → identify/select useful moments → organize a basic narrative → create an immutable TimelineRevision → render → inspect the actual output → revise from user feedback → re-render/re-verify → deliver.
- **Included first-phase capabilities:** ingest/fingerprint/probe; task-conditioned basic video/content/shot analysis under ADP-02; task-relevant moment/highlight selection with evidence and uncertainty; genre-flexible NarrativePlan with message, beats, sequence, simple pacing; trim, reorder, hard cut, concatenate, simple fade/crossfade, limited source-audio controls; immutable timeline; bounded FFmpeg render; actual-output technical/content checks; natural-language revision, re-render, re-verification and delivery.
- **Autonomy boundary:** within the accepted GoalContract, authorized source set, bounded operation registry, permissions and resource envelope the Agent decides autonomously; it must clarify or stop safely for material ambiguity, insufficient evidence, unauthorized scope, material factual risk or exhausted budget.
- **Explicitly deferred:** generated captions/titles; music generation/acquisition; voice synthesis; multi-track audio mixing/ducking/advanced loudness; advanced multi-objective ranking; rich cross-scene narrative reasoning; advanced continuity; music-aware pacing; complex transitions; compositing/motion graphics/keyframes/stabilization/advanced color/VFX/arbitrary filter graphs; manual timeline editing/full NLE; plugin marketplace; unrequested external asset acquisition and external publication. Codec/container/resolution/aspect/rate/color/audio adaptation is ADP-06.
- **Risks:** basic selection/narrative may be insufficient for complex genres; weak or conflicting analysis evidence may require clarification/human review; simple transitions still require timebase/audio/render validation; technical validity does not prove semantic correctness.
- **Acceptance conditions:** natural-language start without per-operation instruction; evidence-backed analysis and selection; valid immutable timeline; typed core operations with deterministic compilation and evidence obligations; bounded render path failing closed; actual-output verification; traceable revisions; source-to-output provenance; material ambiguity/insufficient evidence/unauthorized scope/exhausted budget produce clarification/safe stop; evaluation measures completion and quality, not tool success.
- **Authorization boundary:** product capability boundary only. Does not authorize runtime code, dependencies, real-model/media experiments, external acquisition/publication, a final technology stack or deployment.

## 4. ADP-02 — Task-conditioned progressive media analysis

- **Status:** REVISED — approved in revised form.
- **Owner disposition date:** 2026-11-02.
- **Owner response:** “批准”.
- **Final selection:** four-stage policy. (1) Intake and technical baseline always: fingerprint and probe every source asset; record asset/stream identity, duration, start timestamps, rational time bases, frame/sample characteristics, decode warnings. (2) Source-wide coverage accounting always: one CoverageManifest per asset bound to the exact ProjectSnapshot/input manifest and source digest; for content-based selection, a coarse temporal navigation index with sampling density and gaps. (3) Task-conditioned deep analysis only as required by accepted criteria. (4) Adaptive evidence expansion when evidence is incomplete, contradictory, low-confidence, stale, boundary-sensitive or insufficient, recording trigger, expected evidence, cost reservation and result; unresolved evidence stays Partial/Inconclusive/UNKNOWN.
- **Coverage semantics:** scoped per asset, stream, modality and declared interval; disjoint, gap-accounted, end-exclusive; six mutually exclusive statuses **Observed, Sampled, NotSampled, NotRequested, Unavailable, DecodeFailed**; a status change requires a segment boundary; one modality cannot satisfy another's coverage obligation; absence of a stream is an inventory fact, not a fabricated segment; if the GoalContract requires the absent modality the evidence requirement remains unsatisfied.
- **Evidence boundary:** NotSampled/NotRequested/Unavailable/DecodeFailed never support a negative content claim; sparse sampling, shot summaries and transcript-only evidence cannot establish whole-source absence; negative claims need a method and coverage adequate to the claim; every claim retains source/stream/timebase, method/configuration, scope, uncertainty and freshness.
- **Rationale:** preserves source-wide visibility and auditable gaps while avoiding unconditional full multimodal cost, latency, privacy exposure and noisy absence claims.
- **Risks:** progressive analysis can miss unanticipated cues; coarse indexing is not comprehension; analyzers may disagree; dense expansion consumes budget; raw evidence may be sensitive. No universal confidence threshold is approved.
- **Acceptance conditions:** every asset has a probe or explicit failed/unavailable record; every declared modality scope has a complete gap-accounted CoverageManifest; content-selection tasks have a coarse index with density/gaps declared; criteria map to analysis kinds and minimum scopes; expansion is bounded/reasoned/reserved; weak evidence stays Partial/Inconclusive/UNKNOWN; evaluation measures manifest completeness, recall/miss rate, false detections, source-range accuracy, escalation quality and analysis cost separately.
- **Authorization boundary:** logical policy and coverage/evidence semantics only; no provider, model, storage, media stack, confidence threshold, production pipeline or numeric target is selected.

## 5. ADP-03…ADP-11 dispositions (2026-11-03)

These are **construction-scope** dispositions: they freeze the contract shape needed to build, not the values or implementations that require external facts. Each links to its normative text; where a downstream fact is unknown, the contract defines a fail-closed capability probe instead of inventing an answer.

| ID | Disposition and scope | Still decided at build time |
| --- | --- | --- |
| ADP-03 | **ACCEPTED (construction scope).** Immutable, digest-pinned Workflow Profile; one authority-epoch registry; single-Host serialized `LaunchGate`; distinct `RevocationRequested` / `HostFenceInstalled` / `Revoked`; UNKNOWN holds; multi-Host ordering unapproved. See `contracts/domain-workflow.md`, `security/trusted-host.md`, `contracts/core-protocol.md`. | Named Host/OS and membership; exact grant TTL per risk class (provisional defaults recorded in ARB-01.6). |
| ADP-04 | **ACCEPTED (construction scope).** Generic immutable artifact manifest + opaque content-addressed payload; Journal stores references, never large bytes; six-state minimum projection (Staging/Published/Quarantined/Missing/DigestMismatch/Unverified). | Storage technology, placement, encryption, retention implementation. |
| ADP-05 | **ACCEPTED (construction scope).** Per-stream integer PTS/sample coordinates; piecewise asset-clock mapping; rational time bases; explicit conversion/rounding records; A/V mapping. See `contracts/media-timeline.md`. | Container/codec matrix and platform probing details. |
| ADP-06 | **ACCEPTED (construction scope).** Versioned output-profile registry; no silent defaults; one compatibility profile candidate. | Which profiles ship first and their exact parameter values. |
| ADP-07 | **ACCEPTED (construction scope).** Criterion-level evidence classes via a single `VerificationPolicy` owner; independent content review; human disposition for subjective/high-impact criteria; Kernel assurance floor is non-negotiable. | Reviewer availability, rubric detail, blind-review logistics. |
| ADP-08 | **ACCEPTED (construction scope).** Hard-enforce only Host-supported dimensions; R0 allowed, R1 only under a recorded effect policy, R2 disabled; bounded source/output admission; GPU optional and admission-controlled. | Named enforcement mechanisms and measured limits. |
| ADP-09 | **ACCEPTED (construction scope).** Separate Tasks, exact immutable ArtifactRef, resolver-mediated ScopedReadGrant, per-read authorization, no inherited permissions/context; sequential `CompositePlan` handoff at the application layer. | Multi-tenant handoff, fan-out, autonomous composition. |
| ADP-10 | **ACCEPTED (construction scope).** Contact-sheet/low-resolution preview plus approve/revise/reject; no manual timeline editor; preview never substitutes final inspection. | UI surface and preview encoding parameters. |
| ADP-11 | **SUPERSEDED.** Replaced by the DF/SA/PE/VI gate model and the WBS in `development/roadmap.md`. | — |

**Authorization boundary:** these dispositions do not authorize runtime implementation, dependencies, real media/provider runs, external effects or deployment. They remove documentation ambiguity so construction *can* be planned and authorized.

## 6. ARB-01 — Construction baseline v1 (2026-11-03)

- **Status:** ACCEPTED (construction scope).
- **Method:** eight independent role reviews (Kernel runtime, performance/Token, Coding, Video, domain extension/Office, security/reliability, adversarial architecture, documentation integrity) followed by a chief-architect adjudication and a construction WBS. Design, review and acceptance were role-separated. The reviewers were AI subagents; this is a **document-level** review, not an external human certification. No runtime evidence exists.
- **Scope:** the normative surface needed to build the Kernel, the Coding and Video domains, the Office design sample and the composition path.

### 6.1 Sub-decisions

| ID | Decision | Rationale | Alternatives rejected |
| --- | --- | --- | --- |
| ARB-01.1 | **Document classes and precedence.** Normative contracts are those listed in `docs/README.md` as `NORMATIVE`; architecture/ADP/research documents are informative unless they quote a normative clause; `decision-log.md` is the sole status register; a document that links a record does not restate its fields. | 40+ overlapping documents had nine restatements of authority rules and no precedence rule; a single owner per record is required for independent implementation. | "Everything is normative" (contradiction-prone); "nothing is normative until code exists" (unbuildable). |
| ARB-01.2 | **Readiness model.** Gates become **DF (Design Freeze) → SA (Spike Authorization) → PE (Prototype Evidence) → VI (Verified Implementation)**. RFI means DF passed; it never implies PE/VI. | The old G0–G5 chain made RFI require a finished implementation, which requires authorization that RFI was supposed to gate. | Keeping G0–G5 with renamed labels (cycle remains). |
| ARB-01.3 | **Architecture selection.** One authoritative Kernel + version-pinned domain adapters + data-driven per-domain Execution Strategy, with K/G/H ownership, UNKNOWN handling, Host fence, hard-budget interface and evidence-gated completion retained. | Only this shape satisfies both owner constraints: adding a domain does not grow the Kernel, and domains may have different execution strategies. | Two separate domain agents (duplicate authority/recovery; cross-domain handoff becomes a new integration problem); a generic durable-workflow engine (host/provider ambiguity and admission authority are not expressible as activities); a monolithic domain-aware Kernel (every domain edits the authority core). |
| ARB-01.4 | **Canonical data model and permission model are normative.** One record/enum/event/error catalog; principals, capabilities, approval records, separation of duties and tenancy are specified. | Independent implementations cannot interoperate on prose; approval was previously only a version number. | Per-module schemas with a translation layer (doubles the surface; no single authority). |
| ARB-01.5 | **Execution semantics.** One numbered loop with one priority order; `WakeEvent` causes; `CommitTerminal` as the only terminal path; a single terminal rule for unresolved effects (fail with `UnresolvedEffect` + separate durable hold, never falsely converged); `PlanStep` state is versioned and event-sourced. | Three loop orders, two terminal rules and an unversioned PlanStep state made the core unimplementable. | Leave the loop to implementation discretion (untestable termination). |
| ARB-01.6 | **Effect and evidence policy.** R2 disabled; R1 admissible only under a recorded effect policy with provisional defaults (30 s TTL, 2 s clock uncertainty, 5 s fence ACK, fail-closed); sealed read-only source + disjoint outputs; `DependencyRoot` and `HiddenOracleInput` are declared digest-bound inputs; the shared `VerificationReport` is domain-neutral (`domain_evidence_refs[]`). | The sealed-snapshot equality rule contradicted hidden oracles and real toolchain writes; domain-named report fields contradicted Kernel neutrality. | Full file-open tracing (unnecessary complexity); writable overlay with post-run hashing (cannot prove what ran); per-domain report fields (Kernel branching by another name). |
| ARB-01.7 | **Performance and Token policy.** Per-domain strategy fields are normative data with Kernel floors; ceilings in the documents are **TARGET/UNMEASURED**; cost gates use exposure-adjusted cost and cost per verified success; ablation includes a cheating arm and a four-architecture comparison. | The owner's primary goals had no normative contract, only metrics; numeric "targets" must not masquerade as results. | Leaving budgets OPEN (nothing to design against); declaring measured gains (fiction). |
| ARB-01.8 | **Domain construction specs.** Coding: six typed tools, patch formalism, recon budget, test-selection record, formal evidence catalog with fail-to-pass, fast-path predicate. Video: canonical media identity, closed operation registry, deterministic compiler contract, reconciliation/publication protocol, acceptance catalog. Office: R0 read + R1 local export only; zero Kernel diff. | Domain chains were obligation prose without schemas or algorithms; "deterministic" was aspirational. | Design-by-example with no registry (incompatible implementations); full Office external effects (R2 disabled). |
| ARB-01.9 | **Cross-domain composition.** A derived, read-only `CompositePlan` executed by the application layer over ordinary independently authorized Tasks; failure policies `require_success` and `skip_on_failed_dependency`; no composite Task, shared budget, inherited approval or autonomous fan-out. | The owner requires combining domain tools/artifacts; the safety model forbids shared authority or a composite Task state. | A composite Task aggregate (new authority); partial-consumption policy (contradicts non-consumable partial artifacts); D9 multi-agent (deferred). |
| ARB-01.10 | **ADP-03…11 dispositions** as recorded in §5. | Needed to remove documentation ambiguity before construction. | Leaving them OPEN while claiming readiness (contradiction). |

### 6.2 Why this shape is preferred (argument, not measurement)

The owner asked for a unified Kernel that does not grow per domain, while allowing domains different execution strategies, and for the choice to be justified against alternatives. The justification is a **reasoned comparison plus a falsifiable experiment**, not a measured result:

| Alternative | Why it loses on the stated goals | Falsifier that would overturn this |
| --- | --- | --- |
| Two independent domain agents | Duplicates admission, budget, UNKNOWN, Host fencing and completion authority; each still needs the same safety machinery, so the safety surface roughly doubles; cross-domain handoff becomes an integration project rather than a scoped grant | If two agents match the unified Kernel on false completion, terminal correctness and maintenance cost, the unified Kernel is unjustified |
| Generic durable-workflow engine + domain activities | Provider ambiguity, one-use Host launch, sealed execution views and criterion evidence are not expressible as ordinary activities; the engine would need the same custom safety code plus an engine | If A3 reproduces M1–M6/R1–R7 with less custom safety code, the bespoke Kernel is over-engineering |
| Monolithic domain-aware Kernel | Every new domain edits the authority core; regression surface grows with each domain, contradicting the extension invariant | If an Office adapter lands by editing Kernel state/enums/events, the extension boundary is rejected |
| Shared Kernel + data-driven Execution Strategy (selected) | One authority core; domain differences are policy; a new domain is manifest/tools/policy; performance tuning does not touch Kernel code | If any domain needs a Kernel branch to hit its required strategy, the strategy contract is insufficient and the boundary must reopen |

These are **falsifiers, not results**. The A1–A4 experiment and the zero-Kernel-diff Office audit are designed in [Shared evaluation](../research/shared-kernel/evaluation.md) §9.5 and are `NOT RUN`. No sentence in this baseline may claim that the selected shape is faster, cheaper or more reliable until that evidence exists.

### 6.3 Accepted residual risks

1. **No runtime evidence.** Every protocol property (serializability, fence ordering, sealed view, provider non-duplication, cancellation convergence) remains unproven until PE.
2. **Provider hard-budget eligibility is unknown.** Until a provider is qualified, only explicitly authorized soft-budget mode is honest; hard budget fails closed at admission.
3. **R1 window is a risk acceptance.** The provisional values are construction defaults, not measured safe bounds; the owner may tighten or disable per effect class.
4. **Toolchain compatibility is partial.** Sealed read-only source may not support every ecosystem; affected criteria must remain `Unsupported`/`Unverified` rather than silently pass.
5. **Adversarial review disagreement on RFI.** The independent reviewer recommended requiring prototype evidence before any "ready" claim and narrowing the freeze to a Coding-first slice. This decision keeps RFI as a document-level freeze because the owner's mandate is documentation-only; the disagreement is recorded rather than hidden. Release claims still require PE/VI.
6. **Performance hypotheses unmeasured.** All ceilings are design hypotheses; the ablation may show no benefit or a regression.

### 6.4 Authorization boundary

This decision freezes documents and interfaces for construction planning. It does **not** authorize writing runtime code, adding production dependencies, selecting a final technology stack, running real providers/media, performing external effects, or deploying. Spike work requires a separate SA authorization. Multi-Agent/D9 remains deferred.

## 7. Prior non-decisions and history (superseded, retained for audit)

- The architecture-subtraction review and the convergence proposal were **proposals only**; their content is now subsumed by ARB-01 where accepted.
- The earlier G0/G1–G5 labels are superseded by DF/SA/PE/VI. Any historical text that cites them remains a record of the review, not a current gate.
- ADP-01/ADP-02 remain the only prior owner dispositions; nothing in this log reopens their scope.
