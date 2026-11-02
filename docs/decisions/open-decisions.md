# Open decisions

> **Status: Open register.** Nothing in this file is approved merely because it is listed here. The intelligent execution architecture and Kernel reconciliation are proposals pending owner review.

The current starting point is [Architecture overview](../architecture/overview.md). The new cognitive design is [Autonomous Coding Agent — Intelligent Execution Architecture](../research/autonomous-coding-agent/design.md). Concrete technology and implementation decisions require research, trade-off analysis, and explicit review.

## 1. Autonomous Coding Agent intelligence

**PROPOSED DESIGN DRAFT — highest priority.**

A first end-to-end design is available. The following decisions remain open:

- What GoalContract schema is sufficient for real software tasks without overburdening simple tasks?
- What evidence and freshness rules should RepositoryModel and EvidenceGraph enforce?
- What is the right PlanStep granularity for cross-package and migration tasks?
- How should PlanRevision preserve stable step identity while representing superseded work?
- How much reconnaissance is sufficient, and how should no-progress exploration be detected?
- What is the right strategic/tactical/assurance control policy?
- How should hypothesis-driven debugging and retry limits adapt by failure class?
- How should verifier independence and evidence sufficiency be evaluated?
- Which project instruction files should be loaded, and how should their authority remain bounded?
- Which task classes should be in the first controlled vertical slice?

See [design](../research/autonomous-coding-agent/design.md), [failure model](../research/autonomous-coding-agent/failure-model.md), and [evaluation protocol](../research/autonomous-coding-agent/evaluation.md).

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
