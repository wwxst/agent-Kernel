# Open decisions

> **Status: Open register.** Nothing in this file is approved merely because it is listed here.

The architecture principles in [overview](../architecture/overview.md) are the current starting baseline. Concrete technology and implementation decisions require research, trade-off analysis and explicit review.

## 1. Autonomous Coding Agent intelligence

**OPEN — highest priority.**

- What is the right control-loop model for long-running autonomous coding?
- How should goal understanding, repository exploration, task decomposition, planning, execution, feedback, debugging, verification and repair interact?
- Which decisions belong to adaptive Orchestration and which must be enforced by deterministic Kernel contracts?
- How should the system decide when to continue, replan, ask the user, request approval, or stop?
- What constitutes sufficient evidence to claim a coding task is complete?
- How should context compaction, memory and checkpointing preserve intent and execution state over long tasks?

See [the dedicated research charter](../research/autonomous-coding-agent/README.md).

## 2. Loop and orchestration strategy

**OPEN.** Compare a minimal/native loop with adapter-based reuse of established agent cores. Evaluate Pi, Codex, DeepSeek Harness and Claude Code against the new contracts. Do not decide based on superficial API similarity or line count.

Questions include event semantics, streaming, tool scheduling, steering/follow-up, cancellation, retry ownership, state recovery, extensibility and debugging observability.

## 3. Runtime and language

**OPEN.** No language, runtime, package manager, module system or build stack is selected by this baseline. Evaluate maintainability, process control, streaming, type safety, ecosystem, testability and cross-platform requirements.

## 4. Persistence

**OPEN.** Evaluate event journal, aggregate reconstruction, transaction isolation, fsync/durability, checkpoint co-commit, inbox/outbox, migrations, backup and crash recovery. SQLite is a candidate to study, not a decision.

## 5. Trusted ToolHost and sandbox

**OPEN.** Evaluate OS identity binding, process-tree containment, namespaces, seccomp, cgroup v2, filesystem confinement, network policy, workspace snapshots, receipt authenticity and cross-platform support. Historical Bubblewrap/seccomp/cgroup experiments are evidence only for their exact environment and scope.

## 6. Model Gateway and provider accounting

**OPEN.** Evaluate provider streaming semantics, tool-call completeness, cancellation, retries, usage precision, late billing, invoice evidence, price versioning and budget reservation strategy.

## 7. Tool concurrency and execution policy

**OPEN.** Define read-only parallelism, conflicting writes, exclusive barriers, drain semantics, cancellation, scheduling fairness, stable result projection and idempotency classification.

## 8. Context and memory

**OPEN.** Evaluate retrieval, symbol indexing, planning/execution context separation, prompt-injection handling, token budgeting, compaction, checkpoint consistency, memory quality and stale-source invalidation.

## 9. Workspace and completion evidence

**OPEN.** Define hash scope, symlink/submodule/LFS behavior, test side effects, environment digest, final snapshot, receipt profile, and completion evidence lifetime.

## 10. Extensions and Multi-Agent

- Extension host isolation and lifecycle: **OPEN**.
- Multi-Agent / D9, ChildTask ownership, distributed workers and capability inheritance: **DEFERRED / NOT AUTHORIZED**.

## 11. Decision record requirements

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
