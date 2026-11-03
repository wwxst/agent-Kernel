# Documentation map and normative index

This is the self-contained project baseline for `wwxst/agent-Kernel`. The former source repository has been deleted; nothing here depends on it. Historical provenance identifiers exist only to explain the origin of adopted principles.

## Document classes and precedence

| Class | Binds construction? | Examples |
| --- | --- | --- |
| **NORMATIVE** | Yes. Interfaces, records, state machines, invariants, fixtures. | `contracts/*`, `security/*`, `architecture/lifecycle.md` |
| **NORMATIVE (domain)** | Yes, for that domain's payloads/tools/acceptance; not for Kernel authority. | Coding and Video design/evaluation documents |
| **ARCHITECTURE** | No. Explains and justifies; may quote normative clauses but cannot create obligations. | `architecture/overview.md`, `architecture/domain-architecture.md` |
| **DECISION RECORD** | Binds only the clauses it quotes. `decision-log.md` is the sole status register. | `decisions/*` |
| **RESEARCH** | No. Source review, alternatives, experiments. | `research/**/reference-review.md`, `research/shared-kernel/*` |
| **POLICY / INDEX** | Yes for process/provenance rules. | `AGENTS.md`, `README.md`, this map, `migration/asset-policy.md` |

**Precedence rules (normative):**

1. An owner decision binds only the clauses it quotes; [Decision Log](decisions/decision-log.md) is the sole status register.
2. Where two normative documents disagree, the document that owns the record/enum wins ([Kernel data model §7](contracts/kernel-data-model.md)). A document that links a record must not restate its fields.
3. Architecture, ADP and research documents create no implementation obligation.
4. A file is normative only if this page lists it with a normative class and a status. Unlisted files are drafts.
5. A statement without one of the AGENTS.md labels (APPROVED PRINCIPLE / OPEN / PROPOSED / UNVERIFIED / DEFERRED) is not normative.

## Construction baseline v1 (DF-frozen)

Status: **ACCEPTED for construction (ARB-01, 2026-11-03)**. Implementation not started; all runtime claims `UNVERIFIED`; all runs `NOT RUN`.

| Document | Class | Purpose |
| --- | --- | --- |
| [Core protocol](contracts/core-protocol.md) | NORMATIVE | Authority, transaction ownership, state projections, transitions, loop, terminalization, invariants |
| [Kernel data model](contracts/kernel-data-model.md) | NORMATIVE | Records, identifiers, enums, canonicalization, events, commands, errors, cross-record invariants |
| [Permission, approval and tenancy](security/permissions.md) | NORMATIVE | Principals, capability grants, one-use approvals, separation of duties, tenant isolation |
| [Execution Strategy (DES)](contracts/execution-strategy.md) | NORMATIVE | Data-driven per-domain execution policy, Kernel floor, reference strategies, conformance fixtures |
| [Lifecycle](architecture/lifecycle.md) | NORMATIVE | Task/Goal/Plan/Step/ModelStep/Invocation lifecycle, waits, holds, terminal rules |
| [PlanRevision](contracts/plan-revision.md) | NORMATIVE | Plan graph, L0/L1/L2, cutover, step state, carry-forward |
| [Domain Workflow](contracts/domain-workflow.md) | NORMATIVE | DomainBinding, Workflow Profile, typed envelopes, handoff |
| [Domain Extension](contracts/domain-extension.md) | NORMATIVE | Manifest, adapter ports, activation, composition, Office sample, X1–X13 |
| [Model and Budget](contracts/model-and-budget.md) | NORMATIVE | ModelStep/Attempt, send ambiguity, certificates, reservations, settlement |
| [Delivery and Inbox](contracts/delivery-and-inbox.md) | NORMATIVE | Response delivery, durable inbox, replay, retention |
| [Workspace Freeze](contracts/workspace-freeze.md) | NORMATIVE | Freeze protocol, receipts, sealed input, decision state machine |
| [Verification and Completion](contracts/completion.md) | NORMATIVE | Criteria, evidence classes, assurance floor, Guard, holds |
| [Trusted ToolHost](security/trusted-host.md) | NORMATIVE | Threat model, LaunchGate, epochs, effect classes, UNKNOWN oracles, host obligations |
| [Coding construction specification](research/autonomous-coding-agent/design.md) | NORMATIVE (domain) | Repository model, tools, patch/test/recon/repair, fast path |
| [Coding failure model](research/autonomous-coding-agent/failure-model.md) | NORMATIVE (domain) | Failure codes, recovery mapping, terminal reasons |
| [Coding evaluation](research/autonomous-coding-agent/evaluation.md) | NORMATIVE (domain) | Task set, fixtures C-01…C-15, acceptance predicates |
| [Video design](research/multimedia-domain-architecture/design.md) | NORMATIVE (domain) | End-to-end editing chain and tools |
| [Video intelligence](research/multimedia-domain-architecture/intelligence.md) | NORMATIVE (domain) | Analysis, moment selection, narrative and revision method |
| [Video evaluation](research/multimedia-domain-architecture/evaluation.md) | NORMATIVE (domain) | Fixtures V-01…V-13, acceptance predicates |
| [Media Project](contracts/media-project.md) | NORMATIVE | MediaAsset, ProjectSnapshot, coverage, claims, NarrativePlan |
| [Media Timeline](contracts/media-timeline.md) | NORMATIVE | Operation registry, rational time, timeline invariants |
| [Render Compiler](contracts/render-compiler.md) | NORMATIVE | Deterministic timeline→RenderPlan compilation, canonical argv/filtergraph |
| [RenderPlan Security](contracts/render-plan-security.md) | NORMATIVE | Input/filter/network/process allowlists and the render TCB |
| [RenderJob](contracts/render-job.md) | NORMATIVE | Long-running render projection, reconciliation, publication |
| [Shared evaluation protocol](research/shared-kernel/evaluation.md) | NORMATIVE | Metrics, RunRecord, statistics, gates, architecture comparison |
| [Roadmap and construction plan](development/roadmap.md) | NORMATIVE | DF/SA/PE/VI gates, WBS, acceptance checklist |
| [Context Engine](context/context-engine.md) | NORMATIVE | Projections, provenance, token envelope, cache, checkpoints |

The Coding and Video construction documents remain under `research/` because that is where the designs were researched; ARB-01 promotes them to **NORMATIVE (domain)**. Their location is retained to avoid link churn, and this index — not the directory — determines normative ownership. Documents not listed here are drafts and bind nothing.

## Architecture and product direction

- [Overview](architecture/overview.md) — three layers, authority boundaries, high-level path, non-goals.
- [Unified domain architecture](architecture/domain-architecture.md) — shared Kernel, independent domain intelligence and execution.
- [Provenance](architecture/provenance.md) — source and adoption boundary of the baseline.
- [Unified domain direction](decisions/unified-domain-direction.md) — owner-approved product scope (2026-11-02).

## Decisions and reviews

- [Decision Log](decisions/decision-log.md) — **authoritative status register**; ADP dispositions and ARB-01.
- [Construction readiness review](decisions/construction-readiness-review.md) — review method, findings, dispositions, acceptance verdict, residual risks.
- [Open decisions](decisions/open-decisions.md) — what remains genuinely external or build-time.
- [Architecture Decision Proposals](decisions/architecture-decision-proposals.md) — historical proposal packet; ADPs are now disposed in the Decision Log.
- [Architecture subtraction review](decisions/architecture-subtraction-review.md) — historical KEEP/SIMPLIFY/EXPERIMENT review.
- [Cross-domain review](decisions/cross-domain-architecture-review.md) — historical consistency review.
- [Second-round revision](decisions/second-round-architecture-revision.md) and [contract review](decisions/second-round-contract-review.md) — historical records.

## Research (informative)

- [Shared Kernel reference review](research/shared-kernel/reference-review.md) — Pi, Codex, DeepSeek Harness, Claude Agent SDK execution-layer review.
- [Coding reference review](research/autonomous-coding-agent/reference-review.md) — Coding-specific reference analysis.
- [Coding research index](research/autonomous-coding-agent/README.md).
- [Video research index](research/multimedia-domain-architecture/README.md).

## Policy

- [Legacy asset policy](migration/asset-policy.md) — no legacy code migration without per-asset review.
- [AGENTS.md](../AGENTS.md) — project working rules (highest process authority).

## How to change a normative document

1. Change the owning document, not a restatement.
2. If a record/enum/field changes, amend [Kernel data model](contracts/kernel-data-model.md) in the same change and update its invariants.
3. If authority or a safety property changes, add a Decision Log entry; a schema-compatible edit does not create a decision.
4. Update this index (status/class) and every link that pointed at the old section.
5. Run the link check; a broken relative link or anchor is a documentation defect, not a warning.
6. Never mark a contract "verified", "validated" or "production-ready" without an executed PE/VI record naming the environment and traces.

## Status rule

The existence of a document does not make its content final. Product direction (ADP-01/ADP-02) and the construction baseline (ARB-01) are accepted for their recorded scopes. Runtime behaviour remains unverified until PE/VI evidence exists. See `AGENTS.md`.
