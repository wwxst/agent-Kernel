# Architecture overview

> **Status: ACCEPTED for construction (ARB-01, 2026-11-03); implementation NOT started; runtime claims UNVERIFIED.** This is an **informative** map of the normative contracts. Where it disagrees with an owning contract, that contract wins ([documentation map](../README.md)).

## 1. Product objective

One autonomous Agent platform with two initial execution domains — Autonomous Coding and Autonomous Video Editing — and a Kernel that does not grow per domain.

- **Coding:** understand a repository, plan changes, edit, run checks, debug/repair, verify, deliver.
- **Video:** understand natural-language editing intent and source media, analyze, build a narrative and timeline, render, inspect the actual output, revise, deliver.

The platform is not two agents behind one UI. It is one Kernel hosting independent domain workflows with shared authority and recovery.

## 2. Three layers plus one policy surface

| Layer | Owns | Must not own |
| --- | --- | --- |
| **Shared Kernel** | Task/Goal/Plan state, ModelStep selection, ToolInvocation admission, budgets, permissions, Journal/Inbox/Outbox, completion, delivery | Domain semantics, Host physical facts, cognitive strategy |
| **Domain Intelligence / adapter** | Goal interpretation, domain model, planning and repair policy, evidence interpretation, criterion verification, recovery suggestion | Provider calls, side-effect execution, Kernel state writes |
| **Domain Execution** | Typed tools, artifacts and operations executed only through admission + Trusted Host | Permission grants, task state, plan activation, completion |
| **Execution Strategy (data)** | Fast path, context budget, scheduling, waits, resources, additional verification triggers, termination bounds | Assurance floor, effect classes, terminal choice |

The fourth row is why adding a domain does not require editing the Kernel: the loop branches on **state and policy values**, never on `domain_id`.

## 3. Authority boundaries

Canonical statements live in [Core protocol](../contracts/core-protocol.md) §2–§5 and [Kernel data model](../contracts/kernel-data-model.md) §8. In brief:

1. **Kernel commits.** TaskControl CAS applies to accepted goal, structural plan cutover, cancellation and terminal only. Routine model/tool/budget/receipt operations use owning-aggregate versions and a selective read-set.
2. **Orchestration proposes.** Adapters emit bounded, immutable decisions; they cannot admit, settle, converge or complete.
3. **Gateway observes.** Provider send facts and usage are Gateway records; Kernel owns Attempt identity, reservation and selection.
4. **Host executes.** A trusted Host owns nonce consumption, launch/fence ordering, process facts, its own ledger and authenticated receipts.
5. **Completion requires evidence.** A model statement, exit code or renderer exit is never completion.

Kernel Journal and Host Ledger remain separate fact boundaries. No document claims an atomic transaction spanning Kernel state and an external side effect.

## 4. The two architecture decisions that matter

**Decision A — domains extend, the Kernel does not grow.** A domain registers an immutable manifest, adapter ports, typed tools, artifact/evidence schemas, a verification policy and an execution strategy. Kernel validates envelope, authority, references and legal transitions; the adapter owns interpretation. A fourth domain must land with **zero Kernel file/enum/event changes** ([Domain Extension](../contracts/domain-extension.md), fixture X13).

**Decision B — shared Kernel does not mean identical execution.** Bottlenecks differ, so policy is data:

| Domain | Dominant cost | Strategy emphasis |
| --- | --- | --- |
| Coding | model round-trips, search, repeated tests | incremental context, fast locate, targeted verification, serialized writes |
| Video | probe/analysis, preview, render | digest-keyed caches, bounded parallel analysis, asynchronous jobs, media resource admission |
| Office | parsing, external APIs, batch edits | structured range ops, caching, batching, rate/quota control |
| Browser | page load, waits, DOM churn | incremental page state, event-driven waits, timeout budgets |

The strategy cannot lower a safety floor ([Execution Strategy](../contracts/execution-strategy.md) F1–F12). This is what makes "one Kernel" compatible with "different domains, different performance strategies".

## 5. Execution path

1. Application submits Task + immutable UserIntent; Kernel binds a DomainBinding/Workflow Profile/Strategy.
2. Adapter proposes a GoalContract; Kernel validates schema, bindings and required confirmations.
3. Kernel activates a PlanRevision (structural cutover only when protected fields change).
4. Orchestrator wakes on a typed cause, assembles a purpose-scoped context projection, and requests one bounded decision.
5. Kernel independently admits each ToolInvocation (read-set, effect class, approval, budget, conflict scope, durable intent + outbox).
6. Tool Runtime dispatches through the Trusted Host launch gate; the Host records physical facts and returns authenticated receipts.
7. Adapter interprets outcomes and updates its domain projection; evidence bindings and invalidations are recorded.
8. When mandatory evidence is current, a `CommitTerminal` command runs the deterministic Completion Guard; only it can commit `Completed`.
9. Delivery references immutable artifacts and the exact goal/plan/binding/report versions.

Cancellation, deadline, no-progress and UNKNOWN are convergence protocols with durable waits and typed dispositions — never a UI flag or a claim that effects were rolled back.

## 6. Domain chains

**Coding:** RepositoryModel → typed tools (`discover`, `read_ranges`, `apply_patch`, `run_build_test`, `freeze_source`, `publish_patch`) → sealed read-only source + disjoint test outputs → `ExecutionViewManifest` → fail-to-pass/pass-to-pass/hidden evidence → Guard. See [Coding construction spec](../research/autonomous-coding-agent/design.md).

**Video:** canonical asset/snapshot identity → coverage-accounted analysis → NarrativePlan → immutable TimelineRevision → deterministic RenderPlan compiler → bounded RenderJob → decode/probe + content inspection + provenance map → Guard. See [Media Project](../contracts/media-project.md), [Timeline](../contracts/media-timeline.md), [Render Compiler](../contracts/render-compiler.md), [RenderJob](../contracts/render-job.md).

Both use the same admission, budget, UNKNOWN, cancellation, receipt and completion machinery. Neither imports its semantics into the Kernel.

## 7. Evidence and completion

The shared evidence envelope is intentionally small: `EvidenceRef` + `CriterionEvidenceBinding` + `VerificationReport`. Domain evidence lives in typed artifacts referenced by `domain_evidence_refs[]` (schema id + digest). Optional indexes (EvidenceGraph, summaries, checkpoints) accelerate reasoning and are rebuildable; they are never completion authority.

A criterion passes only with current, provenance-bound evidence of the required class and independence. Human-gated criteria require an authenticated human disposition. The Guard is deterministic and always runs; a fast path may skip a model review, never a mandatory check.

## 8. Invariants (summary, not canonical)

1. One Kernel owns authoritative state; Host owns physical facts.
2. Kernel does not branch on domain; adapters cannot hold authority.
3. Every effect is an independently admitted ToolInvocation with durable intent, budget and Host evidence.
4. UNKNOWN is not failure; no blind retry or conflicting publication.
5. Terminal facts are immutable; late evidence creates holds/remediation, not rewrites.
6. Completion requires current criterion evidence and the Kernel assurance floor.
7. Strategy may tighten policy, never weaken a floor.
8. A new domain extends data and tools; it does not edit the state machine.
9. Multi-Agent / D9 remains deferred.

## 9. Readiness and non-goals

The construction baseline is frozen (DF). No implementation exists; all protocols are `UNVERIFIED` until PE/VI ([Roadmap](../development/roadmap.md)). Not in scope:

- No runtime code, production dependency, deployment or technology selection.
- No full video editor, VFX suite or manual NLE.
- No external R2 effects by default, no multi-tenant shared Host.
- No Multi-Agent / D9, no legacy code migration.

See the [construction readiness review](../decisions/construction-readiness-review.md) for what may and may not be claimed.
