# Open decisions

> **Status: Open register.** Nothing in this file is approved merely because it is listed here. The intelligent execution architecture and Kernel reconciliation are proposals pending owner review.

The current starting point is [Architecture overview](../architecture/overview.md). The new cognitive design is [Autonomous Coding Agent — Intelligent Execution Architecture](../research/autonomous-coding-agent/design.md). Concrete technology and implementation decisions require research, trade-off analysis, and explicit review.

## 1. Autonomous Coding Agent intelligence

**SECOND-ROUND CONTRACTS PROPOSED — owner review pending.**

The first-round design skeleton is retained. The second-round draft now closes the following design gaps:

| Review item | Proposed resolution | Status |
| --- | --- | --- |
| P0-1 PlanRevision / Task lifecycle | Freeze → drain → reconcile → refresh → validate → atomic activate; explicit Running → Planning and Reconciling transitions | PROPOSED |
| P0-1 PlanStep status | Separate WorkStatus and VerificationStatus; FailedKnown remains an invocation/attempt outcome | PROPOSED |
| P0-2 Kernel plan acceptance | Deterministic structural/authority contract validation only; semantic plan quality remains Orchestration | PROPOSED |
| P0-2 GoalContract acceptance | Immutable UserIntent, append-only clarifications, immutable accepted versions, confirmation for protected-field changes | PROPOSED |
| P0-3 Verification independence | Machine evidence, fresh independent review, risk-based external assurance; Verifier output is not completion proof | PROPOSED |
| P1-2 ActionProposal | Version-bound durable decision record, bounded items, independent invocation admission, partial execution, stale invalidation | PROPOSED |
| P1-3 EvidenceGraph | Minimum Claim/Evidence/Relation/Freshness/Provenance records; no graph database assumption; no model self-confidence as evidence | PROPOSED |
| P1-4 Checkpoint | Separate historical integrity/readability from current execution authorization and resumability | PROPOSED |
| P1-5 Loop arbitration | One task-level Orchestration decision coordinator with explicit priority and Kernel CAS | PROPOSED |
| P1-6 Evaluation gates | Design method → task set → baseline → target confirmation → formal evaluation | PROPOSED |

The detailed contracts are in [PlanRevision lifecycle](../contracts/plan-revision.md), [intelligent execution design](../research/autonomous-coding-agent/design.md), [Context Engine](../context/context-engine.md), [completion contract](../contracts/completion.md), and [evaluation protocol](../research/autonomous-coding-agent/evaluation.md). The cross-document consistency findings are recorded in [Second-round contract review](second-round-contract-review.md).

Remaining open questions:

- Which plan-switch UNKNOWN cases can a future Host prove non-blocking?
- What exact protected GoalContract fields and confirmation policy should apply to different product risk classes?
- What evidence-independence level should each risk class require?
- How should semantic plan quality and RepositoryModel sufficiency be measured without moving those judgments into Kernel?
- What task suite and hidden-test design best expose plan churn, false completion, and weak debugging?
- What is the minimum useful PlanStep granularity for cross-package and migration work?

No item above is approved solely because it is written here. Owner review is still required.

## 2. Reference implementation applicability

**OPEN.** Source-grounded review exists for Pi, Codex, DeepSeek Harness, and Claude Agent SDK. The review recommends adapting lifecycle, event, session, context, and scheduling patterns while retaining Kernel-specific authority and completion contracts. No reference architecture is adopted wholesale.

See [reference review](../research/autonomous-coding-agent/reference-review.md).

## 3. Loop and orchestration strategy

**OPEN.** Compare a minimal/native loop with adapter-based reuse of established agent cores. Evaluate event semantics, streaming, tool scheduling, steering/follow-up, cancellation, retry ownership, state recovery, debugging observability, and long-task completion quality.

Do not decide based on superficial API similarity or line count.

## 4. Runtime and language

**OPEN.** No language, runtime, package manager, module system, or build stack is selected by this baseline. Evaluate maintainability, process control, streaming, type safety, ecosystem, testability, and cross-platform requirements.

## 5. Persistence

**OPEN.** Evaluate event journal, aggregate reconstruction, transaction isolation, fsync/durability, checkpoint co-commit, inbox/outbox, migrations, backup, and crash recovery. SQLite is a candidate to study, not a decision.

## 6. Trusted ToolHost and sandbox

**OPEN.** Evaluate OS identity binding, process-tree containment, namespaces, seccomp, cgroup v2, filesystem confinement, network policy, workspace snapshots, receipt authenticity, and cross-platform support. Historical Bubblewrap/seccomp/cgroup experiments are evidence only for their exact environment and scope.

## 7. Tool concurrency and execution policy

**OPEN.** Define effect metadata, read-only parallelism, disjoint write scopes, conflicting writes, exclusive barriers, drain semantics, cancellation, scheduling fairness, deterministic result projection, idempotency classification, and workspace-generation invalidation.

## 8. Context, repository model, and memory

**OPEN.** Evaluate repository indexing, symbol graph freshness, evidence graph representation, Planning/Execution/Verification Context separation, prompt-injection handling, token budgeting, compaction, checkpoint consistency, project memory quality, and stale-source invalidation.

## 9. Workspace and completion evidence

**OPEN.** Define acceptance-criterion schema, verifier independence, hash scope, symlink/submodule/LFS behavior, test side effects, environment digest, final snapshot, receipt profile, evidence lifetime, and remediation lifecycle.

## 10. Evaluation and benchmark

**OPEN.** Build a reproducible task suite with fixed base commits, environments, budgets, policies, and hidden tests. Agree primary metrics and safety gates before reporting success-rate claims. No runtime benchmark has been run.

See [evaluation protocol](../research/autonomous-coding-agent/evaluation.md).

## 11. Extensions and Multi-Agent

- Extension host isolation and lifecycle: **OPEN**.
- Multi-Agent / D9, ChildTask ownership, distributed workers, and capability inheritance: **DEFERRED / NOT AUTHORIZED**.

## 12. Decision record requirements

For each decision, record:

- problem and constraints;
- alternatives considered;
- source evidence and tested versions;
- trade-offs and failure modes;
- security and recovery implications;
- recommendation and rejected alternatives;
- validation plan and acceptance criteria;
- status and explicit owner approval.

Do not silently turn an experiment result into a permanent decision.
