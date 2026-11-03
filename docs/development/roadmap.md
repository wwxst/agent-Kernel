# Development roadmap, gates and construction plan

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03). This document is the construction plan; it does not authorize code, dependencies or deployment.** No implementation exists, no fixture has been executed, and no performance or quality result is claimed. Readiness here means *a competent team can build without inventing architecture*, not *the architecture has been proven at runtime*.

## 1. Two different questions

The previous gate model conflated two questions and made "ready for implementation" require a finished implementation. This plan separates them:

| Question | Gate | Evidence required |
| --- | --- | --- |
| Can a competent team build this without inventing architecture? | **DF — Design Freeze** | Documents, schemas, interfaces, fixture definitions, task breakdown; no open P0; no known contradiction |
| May we spend build time on a time-boxed harness? | **SA — Spike Authorization** | Owner authorization naming environment, provider/host/storage candidates, budget and stop conditions |
| Do the protocols behave as specified? | **PE — Prototype Evidence** | Executed fixtures with traces, PASS/FAIL/NOT RUN per case |
| Is the implementation verified for release? | **VI — Verified Implementation** | Fault injection, domain evidence, benchmarks, security review |

**Ready for Implementation (RFI) = DF passed for the construction baseline.** RFI deliberately does **not** imply PE or VI, and no document may cite DF as evidence of runtime behaviour. Conversely, PE/VI require code, which requires SA; they cannot be preconditions of DF.

## 2. Gate definitions

### DF — Design Freeze (construction baseline v1)

Scope: Kernel core, Host boundary, Model Gateway/budget, Context Engine, Coding domain, Video domain, Office design-only extension, evaluation design.

Entry/exit criteria (all mandatory):

1. Every normative document is indexed in the [documentation index](../README.md) with document class, status and owner.
2. Every record, enum, event, command and error code has exactly one owning document; no field table is duplicated ([Kernel data model](../contracts/kernel-data-model.md)).
3. Zero open P0 findings; P1 items are recorded with an owner and target gate.
4. Zero known cross-document contradictions on authority, terminal states, UNKNOWN, budgets, effect classes and evidence.
5. Every Kernel contract has fixture ids; every domain has a tool/operation registry, evidence catalog and acceptance predicates.
6. The construction work breakdown (§3) has dependencies, effort class and blocking acceptance per ticket.
7. Office X1–X13 and Coding/Video fixtures are defined (design only).
8. Sign-off record (§8) signed by owner + independent reviewer, with document digests.

**Current status: DF PASS (2026-11-03) for construction baseline v1, recorded in [the construction readiness review](../decisions/construction-readiness-review.md).** PE/VI remain `NOT RUN`.

### SA — Spike Authorization

Owner-only decision. Must name: environment, provider candidates, Host OS/profile, storage candidate, time box, spend cap, stop conditions, and the fixture subset to be executed. A spike may not ship, may not use production credentials, and creates no compatibility obligation. Until SA, no runtime code is written (AGENTS.md).

### PE — Prototype Evidence

Executed, reproducible, environment-scoped. Minimum set before the first production implementation:

- M1–M6 (Kernel/Gateway provider ambiguity and budget), R1–R7 (Host fence/revocation), S1–S3 (sealed execution view), V1–V3 (overlay/symlink), T1–T4 (outbox/receipt replay), B1–B2 (certificate/budget race), P1–P2 (approval/plan classification).
- One Coding vertical (C-01…C-15) and one Video vertical (V-01…V-13) on a named frozen task set.
- X1–X13 extension conformance with a **zero-Kernel-diff** check for a fourth domain.

A PE report states per fixture: environment, build commit, fixture id, raw trace, result `PASS | FAIL | SKIP | PARTIAL | NOT RUN`, limitations, reviewer. A safe denial/hold is a correct *safety* result, never a success result.

### VI — Verified Implementation

Release-level evidence: full fault-injection matrix, real domain runs, blinded quality review where required, performance/ablation report, security review, operational runbooks. Only VI supports production claims.

## 3. Construction work breakdown

Effort classes are relative: **S** ≤ 1 week, **M** 1–3 weeks, **L** 3–6 weeks for one experienced engineer, excluding review latency. They are planning estimates, not commitments.

### Phase 0 — Repository and harness

| Ticket | Depends on | Deliverable | Blocking acceptance |
| --- | --- | --- | --- |
| K-00 Harness | DF + SA | Deterministic clock/IDs, in-memory and durable storage adapters, fault injector, trace recorder, fixture runner | M/T/R fixtures run twice with identical traces; no real provider/OS claim |
| K-00b Storage contract test | K-00 | Test proving owning-aggregate CAS + selective multi-aggregate read-set under one serializable transaction, lock order, serialization-retry | Required-properties test from [Core §2](../contracts/core-protocol.md); if it fails, fall back to a narrower single-writer design before K-01 |

### Phase 1 — Kernel authority

| Ticket | Depends on | Deliverable | Blocking acceptance |
| --- | --- | --- | --- |
| K-01 State and journal | K-00b | TaskControl/Goal/Plan/ModelStep/Invocation/Budget aggregates, Journal, Command Inbox, outbox, recovery scan | T1/T4; aggregate-local CAS; no global Task CAS for routine work; terminal exactly once |
| K-02 Terminal and wait | K-01 | Loop state machine, WakeEvent routing, WaitRecord timers, CompletionHold record, terminal reason taxonomy | Terminal race fixtures; deadline/no-progress/cancel outcomes; no "agent decision task" entity |
| K-03 Budget ledger | K-01 | BudgetScope, reservations, certificates, enforcement holds, late-cost append | B1/B2; exposure inequality; completion-vs-overrun serialization |
| K-04 Permissions | K-01 | Principal, capability, approval lifecycle, one-use consumption, tenancy | P-1…P-10 fixtures |
| K-05 Deployment binding | K-01, K-04 | DomainBinding/profile/authority epoch, strategy binding, L2 cutover | Activation/revocation/epoch fixtures; stale-plan rejection |

### Phase 2 — Trusted Host

| Ticket | Depends on | Deliverable | Blocking acceptance |
| --- | --- | --- | --- |
| H-01 Launch gate | K-01, K-05 | Nonce, LaunchAttempt incl. `Spawning`, pre-spawn cookie, local fence, receipts | R1–R7; proven-not-launched only with cookie+process evidence |
| H-02 Sandbox | H-01 | Sealed read-only source, disjoint writable roots, path/symlink/mount denial, resource limits | S1–S3, V1–V3 on a named OS |
| H-03 Process convergence | H-01 | Descendant/handle tracking, cancel/drain, convergence predicate | Process-tree leak and kill-with-writer fixtures |
| H-04 Toolchain profile | H-02 | Supported-toolchain matrix, dependency-root materialization, redirect map, `Unsupported` inventory | At least one real ecosystem (e.g. Node or Python) passes S1; others explicitly Unsupported |

### Phase 3 — Model Gateway

| Ticket | Depends on | Deliverable | Blocking acceptance |
| --- | --- | --- | --- |
| G-01 Adapter + certificate | K-03 | Provider adapter trait, canonical request, maximum-charge certificate, capability probe | B1; unbounded provider cannot enter hard budget |
| G-02 Send ledger | G-01 | Durable `SendMayHaveOccurred`, dedup, no blind resend, status reconciliation | M1–M6 |
| G-03 Selection/delivery | K-01, G-02 | Candidate recording, one irreversible selection, delivery outbox, usage import | Duplicate/out-of-order selection fixtures |

### Phase 4 — Context and orchestration

| Ticket | Depends on | Deliverable | Blocking acceptance |
| --- | --- | --- | --- |
| O-01 Context assembler | K-01 | Purpose-scoped lazy assembly, ContextManifest instrumentation, cache keys/invalidation | Truncation/omission/stale-cache fixtures; token ceilings from DES |
| O-02 Orchestrator loop | K-02, G-03, O-01 | One loop, adapter ports, decision envelope, per-item admission, no-progress/deadline | S-5…S-11; no duplicate effect; bounded iterations |
| O-03 Completion Guard | K-02, K-03, O-02 | Deterministic ordered checks, assurance floor, hold/review | Guard fixtures incl. hidden oracle, stale evidence, late receipt |

### Phase 5 — Coding vertical

| Ticket | Depends on | Deliverable | Blocking acceptance |
| --- | --- | --- | --- |
| C-01 Repository tools | O-01, H-02 | `discover`, `read_ranges`, index/parse, context strategy | Locate fixtures; stale-read rejection |
| C-02 Patch engine | C-01, K-04 | Apply patch, CAS, multi-file atomicity, encoding rules | Conflict/partial-apply fixtures |
| C-03 Test/build runner | C-02, H-04 | Sealed run, ExecutionViewManifest, test report parsing, selection record | S1, F2P/P2P evidence |
| C-04 Coding intelligence | O-02, C-03 | Goal/plan payloads, recon budget, repair loop, fast path | C-01…C-15 |
| C-05 Completion integration | O-03, C-04 | Criterion evidence catalog, ProtectedInputScope, HiddenOracleInput | False-completion traps |

### Phase 6 — Video vertical

| Ticket | Depends on | Deliverable | Blocking acceptance |
| --- | --- | --- | --- |
| V-01 Media ingest and identity | O-01, H-02 | Canonical snapshot, probe, coverage manifest, typed claims | Identity/digest fixtures; no size/mtime identity |
| V-02 Timeline and compiler | V-01 | Operation registry, timeline validator, deterministic RenderPlan compiler | Compiler fixtures; unknown op rejected |
| V-03 Render job | V-02, H-03 | Bounded RenderPlan, staging, long-job lifecycle, cancellation, publication fencing | V-04/V-05/V-09; no publish without convergence |
| V-04 Video intelligence | O-02, V-02 | NarrativePlan, moment selection, revision loop | V-01…V-03, V-06/V-10 |
| V-05 Output assurance | V-03, O-03 | Decode/probe, content inspection, provenance map, human gate | V-01/V-07/V-08/V-11…V-13 |

### Phase 7 — Composition and Office proof

| Ticket | Depends on | Deliverable | Blocking acceptance |
| --- | --- | --- | --- |
| X-01 Composite handoff | C-05, V-05 | CompositePlan runner (application layer), ScopedReadGrant, failure policies | X4 handoff; no inherited authority; dependency failure typed |
| X-02 Office mock adapter | O-02, X-01 | Office manifest, 2 tools, criteria, UNKNOWN/wait paths | X1–X3, X9–X13; zero Kernel state-machine change |
| X-03 Fourth-domain diff audit | X-02 | Independent author adds a minimal domain; measure Kernel diff | Zero files/enums/events changed in Kernel core |

### Phase 8 — Measurement and release evidence

| Ticket | Depends on | Deliverable | Blocking acceptance |
| --- | --- | --- | --- |
| E-01 Benchmark harness | C-05, V-05 | Frozen task sets, RunRecord/Spans, cost and latency aggregation, cheating arm | Harness detects a deliberately unsafe arm as FAIL |
| E-02 Ablations | E-01 | Paired A/B for fast path, context, verification, scheduling | Pre-registered metrics; INCONCLUSIVE allowed; no PASS from wide CIs |
| E-03 Architecture comparison | E-02 | A1–A4 arms (unified/adapter vs separate agents vs workflow engine vs monolith) | Marginal-cost-of-domain and reliability comparison; falsifiers F1–F4 |
| E-04 Release readiness | E-03 | VI report, residual risks, operations runbooks | Security review + fault matrix + domain evidence |

## 4. Milestones and ordering

| Milestone | Contents | Exit |
| --- | --- | --- |
| M0 Harness | Phase 0 | Fixtures reproducible with mocks |
| M1 Kernel + Host + Gateway | Phases 1–3 | PE: M1–M6, R1–R7, S1–S3, T1–T4 |
| M2 Coding vertical | Phases 4–5 | PE: C-01…C-15 |
| M3 Video vertical | Phases 4–6 | PE: V-01…V-13 |
| M4 Composition + Office | Phase 7 | PE: X1–X13, zero-Kernel-diff audit |
| M5 Measurement and release | Phase 8 | VI report |

Critical path: K-00b → K-01 → H-01/H-02 → G-02 → O-02 → C-03 → C-05 → E-01. Video work can start after O-01/H-02 in parallel with Coding; it does not block M2.

**Bounded iterations:** at most two repair rounds per PE gate; unresolved forks escalate to the owner rather than triggering redesign. No gate may be re-opened by a documentation change without a new decision entry.

## 5. Definition of done (every ticket)

- Typed request/result schemas with version and canonical digest.
- Named owner for every durable write and every external effect.
- Explicit success, failure, cancellation, timeout and UNKNOWN paths.
- At least one deterministic fixture with a pass/fail oracle.
- Observability: span ids, event ids, receipt ids, correlated trace.
- Unsupported-environment behaviour: fail closed or explicitly `Unsupported`.
- No new Kernel state/enum/event unless the data model is amended by decision.

## 6. Construction acceptance checklist (DF)

1. Kernel core responsibilities, protocols, interfaces, state machines and execution flow are explicit and singular.
2. Coding and Video can be developed directly from the registry + evidence + acceptance documents.
3. A new domain can be added through the extension contract without changing the Kernel state machine; X13 proves zero diff.
4. Normal, failure, cancel, timeout, crash-recovery and terminal paths are complete and testable.
5. Performance/Token optimization has explicit policy fields, measurement formulas and acceptance methods.
6. Development tasks, dependency order, phase deliverables and acceptance conditions are clear.
7. All P0 issues are closed; remaining P1/P2 are recorded with owner and target gate; no major cross-document conflict remains.

## 7. Decision dependencies and external facts

| Item | Status after ARB-01 | What still must be decided at build time |
| --- | --- | --- |
| D0 Architecture shape | **DECIDED** (ARB-01.3) | — |
| D1 Hard-budget certificates | **INTERFACE DECIDED**; provider qualification open | Provider-specific capability probe at PE (SA names the provider) |
| D2 R1 exposure window | **PROVISIONAL DEFAULTS** (30 s TTL, 2 s skew, 5 s fence ACK) | Owner ratification per effect class before R1 enablement |
| D3 Host/OS | **CAPABILITY CONTRACT DECIDED**; product open | Named OS/profile at SA; unsupported => `Unsupported`, never weakened |
| D4 Storage | **REQUIRED PROPERTIES DECIDED**; product open | Candidate validated by K-00b |
| D5 Thresholds/task sets | **PROCEDURE DECIDED**; numbers provisional | E-gate calibration; rights-cleared assets |
| D6 Runtime authorization | **NOT GRANTED** | Explicit SA decision naming scope, budget, environment |

These are build-time choices constrained by normative contracts, **not** open architecture questions. A choice that violates a contract is not a valid option.

## 8. Sign-off record

Each gate records: gate, scope, document digests or build commit, owner, independent reviewer, environment, fixture ids and results, open P0/P1, accepted residual risks, decision-log entry id, date. A gate without this record is not passed.

## 9. Historical note

Stages 0–8 of the previous roadmap (research, reference review, cross-domain consistency, contract verification, baselines, productization) remain the research history and are preserved in the decision records. They are superseded as an execution plan by this document; their artifacts remain informative evidence of how the design was reached, not authorization to build.
