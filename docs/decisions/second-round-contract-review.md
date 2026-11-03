# Second-round contract review

> **Status: HISTORICAL REVIEW RECORD (superseded by ARB-01, 2026-11-03).** Its authority table points at research documents; current normative ownership is defined in the [documentation map](../README.md) and [Kernel data model](../contracts/kernel-data-model.md). The findings remain informative.

## 1. Scope

The second round follows the conditional first-round review. It retains the first-round cognitive direction and resolves the identified P0/P1 contract gaps without introducing a runtime stack, package topology, new dependency, or Multi-Agent design.

The work is documentation-only. No Runtime code was added or changed. No benchmark or fault-injection run was performed.

## 2. P0 review outcomes

| Issue | Second-round contract | Cross-document authority | Status |
| --- | --- | --- | --- |
| P0-1 PlanRevision / Task lifecycle | Plan switch is freeze → drain → reconcile → refresh → validate → atomic activate. Task may enter Planning from Running and other active non-terminal states. UNKNOWN can block cutover. | [PlanRevision contract](../contracts/plan-revision.md), [lifecycle](../architecture/lifecycle.md), [design](../research/autonomous-coding-agent/design.md) | PROPOSED — structurally specified; runtime unverified |
| P0-1 PlanStep state | WorkStatus and VerificationStatus are orthogonal. FailedKnown belongs to Attempt/ToolInvocation, not the engineering goal. | [PlanRevision contract](../contracts/plan-revision.md), [lifecycle](../architecture/lifecycle.md) | PROPOSED |
| P0-2 Kernel plan acceptance | Kernel checks deterministic schema, identity/version, DAG, references, scope, budget, capability, and legal-transition contracts. It does not judge technical or semantic plan quality. | [PlanRevision contract](../contracts/plan-revision.md), [design](../research/autonomous-coding-agent/design.md), [overview](../architecture/overview.md) | PROPOSED |
| P0-2 GoalContract acceptance | Immutable UserIntent and append-only clarifications; accepted GoalContract versions are immutable. Protected-field changes require explicit confirmation or an immutable intake-time authorization reference. | [PlanRevision contract](../contracts/plan-revision.md), [design](../research/autonomous-coding-agent/design.md), [lifecycle](../architecture/lifecycle.md) | PROPOSED |
| P0-3 Independent verification | Machine evidence, fresh independent review, and risk-based external assurance are separate. Verifier dispositions are findings, not criterion proof. Completion Guard checks evidence obligations. | [completion contract](../contracts/completion.md), [design](../research/autonomous-coding-agent/design.md) | PROPOSED — quality unverified |

## 3. P1 review outcomes

| Issue | Second-round contract | Location | Status |
| --- | --- | --- | --- |
| P1-1 GoalContract versioning | Source intent and clarifications are immutable references; new accepted versions trigger plan impact analysis and stale-report handling. | [PlanRevision contract](../contracts/plan-revision.md), [design](../research/autonomous-coding-agent/design.md) | PROPOSED |
| P1-2 ActionProposal | Version-bound durable decision record; Orchestration selects it; Kernel checks structure/bindings; every ToolInvocation has separate admission; batches may partially execute and are not atomic. | [design](../research/autonomous-coding-agent/design.md), [lifecycle](../architecture/lifecycle.md) | PROPOSED |
| P1-3 EvidenceGraph | Minimum Claim/Evidence/Relation/Freshness/Provenance records; graph database is not assumed; model self-confidence is not evidence. | [design](../research/autonomous-coding-agent/design.md), [Context Engine](../context/context-engine.md) | PROPOSED |
| P1-4 Checkpoint | Historical integrity/readability is separate from current authorization and execution resumability. Recovery reloads current authorization and workspace state. | [Context Engine](../context/context-engine.md), [lifecycle](../architecture/lifecycle.md) | PROPOSED |
| P1-5 Control-loop arbitration | One task-level Orchestration decision coordinator serializes control proposals with explicit priority; Kernel CAS remains the commit gate. | [design](../research/autonomous-coding-agent/design.md), [overview](../architecture/overview.md) | PROPOSED |
| P1-6 Evaluation stages | Architecture metrics/method → task set → baseline → target confirmation → formal evaluation/ablation. Baseline is not required before design-level evaluation method or implementation planning. | [evaluation protocol](../research/autonomous-coding-agent/evaluation.md), [roadmap](../development/roadmap.md) | PROPOSED |

## 4. Cross-document consistency rules

The following are the intended single meanings across the architecture documents:

1. **User intent:** the original request is immutable. GoalContract is a versioned interpretation and cannot silently replace the user's goal.
2. **Plan authority:** a candidate is not executable. AcceptedPendingCutover is not executable. Only one Active PlanRevision may govern new plan work.
3. **Plan switching:** the old revision stops accepting new work at a Kernel-linearized barrier. Already-started work drains or reconciles; conflicting UNKNOWN blocks cutover.
4. **PlanStep:** work completion and verification verdict are separate dimensions. Rework and evidence invalidation preserve history.
5. **Kernel boundary:** Kernel validates contracts and authority deterministically. Semantic adequacy, technical strategy, repository understanding, and action quality remain Orchestration responsibilities.
6. **ActionProposal:** a proposal records a decision; it never grants capability or approval. Each ToolInvocation is independently admitted.
7. **EvidenceGraph:** claims and relations are a provenance-aware projection, not a second authoritative ledger.
8. **Checkpoint:** authorization expiry does not erase historical progress. New execution requires fresh authorization and workspace reconciliation.
9. **Verification:** a Verifier model's opinion is not evidence of correctness. Required machine, independent, external, or human evidence is checked against the criterion contract.
10. **Decision ownership:** the three control loops do not independently mutate Task state. One task-level coordinator selects the next decision; Kernel commits legal state transitions.
11. **Evaluation:** target thresholds are set after a frozen task set and measured baseline; design-stage metrics and safety floors are defined earlier.

## 5. Remaining OPEN questions

The second-round draft does not pretend the following are solved:

- Which Host-proven read-only UNKNOWN cases may be classified non-blocking during plan cutover?
- What protected GoalContract fields and confirmation rules should apply to each risk class?
- What evidence-independence level should be required for each criterion risk class?
- How should semantic plan quality and RepositoryModel sufficiency be measured without moving judgment into Kernel?
- What PlanStep granularity works best for cross-package, migration, and long-running tasks?
- What benchmark tasks and hidden tests best expose plan churn, false completion, weak debugging, and context loss?
- Which reference-implementation findings need deeper exact-function/source-range audit before adoption decisions?

These are tracked in [Open decisions](open-decisions.md).

## 6. Validation record

- Documentation scope: **PASS** — changes in this round are Markdown architecture/contracts only.
- Local Markdown links in the reviewed design, contract, lifecycle, context, completion, evaluation, roadmap, and index documents: **PASS** — all resolved against the branch tree at review time.
- Runtime tests: **NOT RUN** — no runtime implementation was changed or available for this review.
- Benchmark runs: **NOT RUN**.
- Fault-injection and recovery tests: **NOT RUN**.
- Security properties, verifier quality, and execution safety: **UNVERIFIED**.

The branch remains separate from main. No pull request or merge is created by this review.

## 7. Decision requested

The second-round contracts are ready for owner review as a coherent proposal. Approval of this document would acknowledge the design direction and contracts for the next review stage; it would **not** authorize runtime implementation, technology selection, production dependencies, real-model execution, or legacy code migration.

## 8. Subsequent Draft PR #1 architecture subtraction

This is a **later proposal**, not a retroactive approval of the earlier contract review. One Task Orchestrator uses Strategic/Tactical/Assurance purposes; ActionProposal is bounded immutable intent with child Invocation-derived status; EvidenceGraph is an optional source-index over required EvidenceRefs/criterion bindings; PlanStep and Task presentation phases derive from events. Independent ModelStep/Invocation/Budget versions with a protected read-set replace blanket Task aggregate CAS; sequential-first scheduling and milestone checkpoints reduce protocol overhead.

The new proposal **retains** protected Goal/Plan barriers, per-Invocation Admission, Host receipt/UNKNOWN recovery, actual Coding input-view proof, Hard Budget and independent Completion evidence. Autonomous Coding capability is unchanged. G0 still pending and G1–G5 NOT RUN.
